import type { OffloadControlEventCode, OffloadSnapshot } from '@ptvault/contracts';

import type { AppConfig } from '../config/env.js';
import { SecretBox } from '../core/crypto.js';
import type { AppDatabase } from '../db/database.js';
import type { JobHandler, JobHandlers } from '../jobs/worker.js';
import type { TorrentPreflightService } from '../qb/preflight.js';
import type { QbRepository } from '../qb/repository.js';
import type { QbControlRegistry } from '../qb/types.js';
import { RecoveryBundleService } from '../recovery/bundle.js';
import { RecoveryGate } from '../recovery/gate.js';
import type { RecoveryRepository } from '../recovery/repository.js';
import type { RecoveryPreparationContext } from '../recovery/preparation-context.js';
import type { JobRepository } from '../jobs/repository.js';
import type { TransferSettingsRepository } from '../settings/transfer-settings.js';
import { DbRecoveryWorkflow } from '../recovery/workflow.js';
import { StorageAccountRepository } from './accounts.js';
import {
  CleanupService,
  type CatalogCleanup,
  type MountRefresh,
  type PlaybackProbe,
} from './cleanup.js';
import { OffloadHandler, type CatalogRecorder } from './offload-handler.js';
import type { OffloadSnapshotPublication } from './offload-event-publisher.js';
import { OffloadMachine } from './offload-machine.js';
import { ProcessRunner, type CommandRunner } from './process-runner.js';
import { ReplicaPromoteHandler, queueReplicaPromote } from './replica-promote-handler.js';
import { RcloneClient } from './rclone.js';
import { OffloadResourceScheduler } from './resource-scheduler.js';
import { SecondaryReplicator } from './secondary-replica.js';

export type RecoveryServices = {
  preparation: RecoveryPreparationContext;
  repository: RecoveryRepository;
  accounts: StorageAccountRepository;
  workflow: DbRecoveryWorkflow;
};

export type CreateRecoveryServicesOptions = {
  preparation: RecoveryPreparationContext;
  db: AppDatabase;
  rcloneRunner: CommandRunner;
  config: Pick<AppConfig, 'rcloneBin' | 'ageBin' | 'stateDir'> & { rcloneConfigPath: string };
  torrentRepository: QbRepository;
  now?: () => number;
};

/**
 * Assembles the recovery-material graph.
 *
 * Deliberately built in **both** modes, unlike the offload executor. Recovery
 * material is a precondition for uploading at all — `OffloadHandler` asks the
 * gate for a deletion permit during HASHING, before a single byte moves — so
 * gating this behind ACTIVE would force the operator to arm the destructive
 * switch *before* they could create the material that makes deletion survivable.
 * That is exactly backwards.
 *
 * This does not weaken what SHADOW promises. Generating a bundle writes a few MB
 * of encrypted metadata to the operator's own cloud accounts; it pauses no
 * torrent, uploads no media, and deletes nothing local.
 */
export function createRecoveryServices(options: CreateRecoveryServicesOptions): RecoveryServices {
  const now = options.now ?? (() => Date.now());
  const repository = options.preparation.repository;
  const accounts = new StorageAccountRepository(options.db, now, {
    legacyRcloneConfigured: true,
    webOAuthRuntimeConfigured: true,
  });
  const runner = new ProcessRunner();
  const rclone = new RcloneClient({
    runner: options.rcloneRunner,
    executable: options.config.rcloneBin,
    configPath: options.config.rcloneConfigPath,
  });

  const bundles = new RecoveryBundleService({
    repository,
    accounts,
    runner,
    rclone,
    ageExecutable: options.config.ageBin,
    outputDirectory: `${options.config.stateDir}/recovery`,
    now,
  });

  const workflow = new DbRecoveryWorkflow({
    preparation: options.preparation,
    db: options.db,
    bundles,
    accounts,
    torrents: options.torrentRepository,
    rcloneConfigPath: options.config.rcloneConfigPath,
    stateDirectory: options.config.stateDir,
    now,
  });

  return { repository, accounts, workflow, preparation: options.preparation };
}

export type OffloadServices = {
  preparation: RecoveryPreparationContext;
  machine: OffloadMachine;
  accounts: StorageAccountRepository;
  recovery: RecoveryRepository;
  handler: OffloadHandler;
  /** Runs the second cloud copy as its own job, after a primary has committed. */
  promoteHandler: ReplicaPromoteHandler;
  cleanup: CleanupService;
  recoveryGate: RecoveryGate;
  resources: OffloadResourceScheduler;
};

export type CreateOffloadServicesOptions = {
  preparation: RecoveryPreparationContext;
  db: AppDatabase;
  rcloneRunner: CommandRunner;
  /**
   * `rcloneConfigPath` is non-null here, unlike on `AppConfig`. Execution needs a
   * definite rclone.conf, and `parseConfig` already refuses to start in ACTIVE
   * mode without one — so the caller that builds this has a concrete path.
   */
  config: Pick<
    AppConfig,
    | 'masterKey'
    | 'rcloneBin'
    | 'offloadParallelEnabled'
    | 'offloadPreflightConcurrency'
    | 'offloadPauseSnapshotConcurrency'
    | 'offloadMaxPausedPipelines'
    | 'offloadHashConcurrency'
    | 'offloadRemoteDataConcurrency'
  > & { rcloneConfigPath: string };
  registry: QbControlRegistry;
  torrentRepository: QbRepository;
  preflight: TorrentPreflightService;
  /** Needed to queue the follow-up `REPLICA_PROMOTE` job when a primary commits. */
  jobs: Pick<JobRepository, 'insert'>;
  /**
   * Holder for the media catalog recorder, read at commit time rather than at
   * construction.
   *
   * A holder because the media graph is built after this one — it needs the same
   * database and the real disk capacity — while the recorder must be reachable from
   * a commit that can only happen once both exist. Capturing the value here would
   * capture `undefined` forever.
   */
  catalogRecorder?: { current?: CatalogRecorder };
  cleanupCatalog?: { current?: CatalogCleanup };
  /** Runs the farm reconcile immediately after cleanup changes local precedence. */
  cleanupRefresh?: { current?: MountRefresh };
  playback?: PlaybackProbe;
  now?: () => number;
  onSnapshot?: (
    snapshot: OffloadSnapshot,
    eventCode?: OffloadControlEventCode,
    publication?: OffloadSnapshotPublication,
  ) => void;
  settings?: Pick<TransferSettingsRepository, 'read'>;
};

/**
 * Assembles the offload execution graph.
 *
 * The caller decides whether to build this at all: the server only does so in
 * ACTIVE mode, so a SHADOW process holds no object capable of pausing a torrent,
 * uploading a byte, or deleting a local file. `rcloneConfigPath` is required
 * rather than nullable for the same reason `parseConfig` refuses to start ACTIVE
 * without one — the executor must know exactly which rclone.conf it speaks
 * through.
 *
 * The real `RecoveryGate` is used deliberately — not the pilot's sentinel. It
 * refuses to issue a deletion permit unless the full recovery chain is satisfied
 * (public recipient, escrow verified, ≥2 cloud copies, computer confirmation), so
 * an offload that reaches LOCAL_CLEANUP without recovery material cannot delete.
 */
export function createOffloadServices(options: CreateOffloadServicesOptions): OffloadServices {
  const now = options.now ?? (() => Date.now());
  const parallel = options.config.offloadParallelEnabled;
  const configured = options.settings?.read().offload;
  const resources = new OffloadResourceScheduler({
    preflightConcurrency: parallel
      ? (configured?.preflightConcurrency ?? options.config.offloadPreflightConcurrency)
      : 1,
    pauseSnapshotConcurrency: parallel
      ? (configured?.pauseSnapshotConcurrency ?? options.config.offloadPauseSnapshotConcurrency)
      : 1,
    hashConcurrency: parallel
      ? (configured?.hashConcurrency ?? options.config.offloadHashConcurrency)
      : 1,
    uploadConcurrency: parallel
      ? (configured?.uploadConcurrency ?? options.config.offloadRemoteDataConcurrency)
      : 1,
    readbackConcurrency: parallel ? (configured?.readbackConcurrency ?? 1) : 1,
    metadataConcurrency: parallel ? Math.min(options.config.offloadPreflightConcurrency, 4) : 1,
  });
  const machine = new OffloadMachine(
    options.db,
    now,
    (snapshot, eventCode, publication) => {
      queueMicrotask(() => {
        resources.notifyPausedCapacityChanged();
        try {
          options.onSnapshot?.(snapshot, eventCode, publication);
        } catch {
          // Telemetry fan-out is advisory; the durable state is already committed.
        }
      });
    },
    // The rollout flag controls parallel execution only. A closed flag must
    // retain the pre-v22 serial creation behavior while the durable setting can
    // still close that creation gate explicitly.
    () => options.settings?.read().offload.creationEnabled ?? true,
  );
  const accounts = new StorageAccountRepository(options.db, now, {
    legacyRcloneConfigured: true,
    webOAuthRuntimeConfigured: true,
  });
  const recovery = options.preparation.repository;
  const recoveryGate = new RecoveryGate(options.preparation.readiness, () => new Date(now()));

  const rclone = new RcloneClient({
    runner: options.rcloneRunner,
    executable: options.config.rcloneBin,
    configPath: options.config.rcloneConfigPath,
  });

  const handler = new OffloadHandler({
    db: options.db,
    machine,
    preflight: options.preflight,
    registry: options.registry,
    torrentRepository: options.torrentRepository,
    recoveryGate,
    accounts,
    rclone,
    secretBox: new SecretBox(options.config.masterKey),
    resources,
    maxPausedPipelines: () =>
      parallel
        ? (options.settings?.read().offload.maxPausedPipelines ??
          options.config.offloadMaxPausedPipelines)
        : 1,
    // Queued here rather than stepped through inside the offload: a second full
    // upload would double the wall-clock time of a job the operator is watching,
    // and deletion eligibility never depends on the secondary.
    onCommitted: (snapshot) => {
      queueReplicaPromote({
        jobs: options.jobs,
        offloadJobId: snapshot.jobId,
        importance: snapshot.importance,
      });
    },
    // Read through the holder at commit time. An absent recorder means no media
    // surface is configured, and the commit then records no catalog row — the
    // behaviour before the catalog existed.
    catalogRecorder: {
      record: (input) => options.catalogRecorder?.current?.record(input),
    },
    now,
  });

  const promoteHandler = new ReplicaPromoteHandler({
    machine,
    replicator: new SecondaryReplicator({ db: options.db, accounts, rclone, now }),
  });

  const cleanup = new CleanupService({
    db: options.db,
    machine,
    recovery: options.preparation.readiness,
    preparationCoordinator: options.preparation.coordinator,
    registry: options.registry,
    torrentRepository: options.torrentRepository,
    ...(options.playback ? { playback: options.playback } : {}),
    catalog: {
      setLocalHot: (input) => options.cleanupCatalog?.current?.setLocalHot(input),
    },
    refresh: {
      refresh: (paths) => options.cleanupRefresh?.current?.refresh(paths) ?? Promise.resolve(),
    },
    now,
  });

  return {
    machine,
    accounts,
    recovery,
    handler,
    promoteHandler,
    cleanup,
    recoveryGate,
    resources,
    preparation: options.preparation,
  };
}

/**
 * Returns the worker's handler table for the given mode.
 *
 * SHADOW yields an empty table on purpose. An `OFFLOAD` job that somehow reaches
 * a SHADOW worker then lands in BLOCKED with `HANDLER_NOT_REGISTERED` rather than
 * executing — the job is preserved for inspection, and nothing is paused,
 * uploaded, or deleted. This is the second of two independent guards: the trigger
 * route is not registered in SHADOW either, so arming the pipeline takes both a
 * mode flip and a restart, never a single stray request.
 */
export function registerOffloadHandlers(input: {
  mode: AppConfig['mode'];
  handler: Pick<OffloadHandler, 'run'>;
  promoteHandler?: Pick<ReplicaPromoteHandler, 'run'>;
}): JobHandlers {
  if (input.mode !== 'ACTIVE') return {};

  const offload: JobHandler = async (job, context) => {
    await input.handler.run(job.id, context.signal);
  };
  const handlers: JobHandlers = { OFFLOAD: offload };
  if (input.promoteHandler) {
    const promote = input.promoteHandler;
    handlers.REPLICA_PROMOTE = async (job, context) => {
      await promote.run(job.payload, context.signal);
    };
  }
  return handlers;
}
