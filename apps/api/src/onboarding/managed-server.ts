import path from 'node:path';
import { parseConfig } from '../config/env.js';
import { installShutdownSignals, startServer, type ServerRuntime } from '../server.js';
import { SetupActivation } from './activation.js';
import { ManagedMutationAdmission } from './admission.js';
import { SetupConfigStore } from './config-store.js';
import { changesDataLocations, managedChildrenIdle, readSetupIdle } from './idle-gate.js';
import { managedEnvironment } from './managed-environment.js';
import { ManagedMaintenance } from './maintenance.js';
import { readBootstrapCredential, readManagedInstallation } from './managed-installation.js';
import { SetupPathProbe } from './path-check.js';
import type { ManagedSetup } from './routes.js';
import { registerStaticApp } from './static-app.js';

export async function startManagedServer(options: {
  stateDir: string;
  releaseRoot: string;
  mediaExportRoot: string;
  masterKey: Buffer;
  installSignalHandlers?: boolean;
  childrenIdle?: () => boolean | null;
  tickMs?: number;
  onFatal?: (code: string) => void;
}) {
  const marker = readManagedInstallation(options);
  const store = new SetupConfigStore(options);
  store.view(); // No implicit initialization or adoption on normal service start.
  let activation: SetupActivation<ServerRuntime> | undefined;
  let maintenance: ManagedMaintenance | undefined;
  const admission = new ManagedMutationAdmission(() => (activation?.quiescing ?? false) || (maintenance?.closed ?? false));
  const environmentOptions = { ...options, port: marker.port, credentialRoot: path.join(options.stateDir, 'setup', 'runtime-credentials') };
  const initialProbe = await new SetupPathProbe({ allowedRoots: [], spoolRoot: store.active().values.spoolRoot, protectedRoots: [] }).spool();
  const initialImportBudget = initialProbe.suggestedBudget ?? { maxBytes: '67108864', reserveBytes: '8388608' };
  const managed: ManagedSetup = {
    store,
    installAdmission: (app) => admission.register(app),
    applying: () => activation?.applying ?? false,
    requestActivation: (revision) => {
      if (!activation) throw new Error('SETUP_STARTING');
      if (maintenance?.closed) throw new Error('SETUP_BUSY');
      return activation.request(revision);
    },
  };
  const start = async (settings: ReturnType<SetupConfigStore['active']>) => {
    const credential = readBootstrapCredential(options.stateDir);
    return startServer({
      env: managedEnvironment(settings, environmentOptions),
      guidedSetup: true,
      bootstrapCredential: { ...credential, readCredential: () => readBootstrapCredential(options.stateDir) },
      managedSetup: managed,
      initialImportBudget,
      installSignalHandlers: false,
      configureApp(runtime) {
        registerStaticApp(runtime.app, path.join(options.releaseRoot, 'apps', 'web', 'dist'));
      },
    });
  };
  const current = await start(store.active());
  activation = new SetupActivation({
    store, current, start,
    validate: (candidate) => { parseConfig(managedEnvironment(candidate, environmentOptions), { guidedSetup: true }); },
    isIdle: (candidate, runtime) => readSetupIdle({
      db: runtime.db,
      activeHandlers: runtime.worker.activeJobCount + (runtime.importDataPlaneLoop?.activeJobCount ?? 0),
      activeMutations: admission.activeCount,
      childrenIdle: (options.childrenIdle ?? managedChildrenIdle)(),
      relocatingPaths: changesDataLocations(store.active().values, candidate.values),
    }).idle,
  });
  const controller = activation;
  maintenance = new ManagedMaintenance(() => readSetupIdle({
    db: controller.current.db,
    activeHandlers: controller.current.worker.activeJobCount + (controller.current.importDataPlaneLoop?.activeJobCount ?? 0),
    activeMutations: admission.activeCount,
    childrenIdle: (options.childrenIdle ?? managedChildrenIdle)(),
    relocatingPaths: false,
  }), () => controller.applying);
  let failed = false;
  const timer = setInterval(() => {
    if (failed || maintenance.closed) return;
    void controller.tick().then(() => {
      try { controller.current.refreshManagedMounts?.(); }
      catch { controller.current.app.log.warn('public mount registry refresh failed'); }
    }).catch(() => {
      failed = true;
      // A failed stop must never be followed by a second runtime writer.
      options.onFatal?.('SETUP_RUNTIME_UNAVAILABLE');
    });
  }, options.tickMs ?? 2000);
  timer.unref();
  let disposeSignals: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    maintenance.stop();
    clearInterval(timer);
    disposeSignals?.();
    stopping ??= controller.stop();
    return stopping;
  };
  if (options.installSignalHandlers !== false) disposeSignals = installShutdownSignals(stop);
  return { get runtime() { return controller.current; }, store, activation: controller, maintenance, stop };
}
