import { SetupConfigError, type SetupConfigStore } from './config-store.js';
import type { SetupSaveResult } from '@ptvault/contracts';

type Settings = ReturnType<SetupConfigStore['active']>;
type Runtime = { stop: () => Promise<void> };

/** One owner switches runtime graphs; database/token rollback is deliberately absent. */
export class SetupActivation<T extends Runtime> {
  current: T;
  quiescing = false;
  persistenceWarning = false;
  private requested: number | undefined;
  private running: Promise<void> | undefined;
  private fatal: string | undefined;
  private stopping = false;
  private markFailed(revision: number): void {
    // A full disk must not prevent restoring the last working graph.
    try { this.options.store.markActivationFailed(revision); } catch { /* the draft remains unapplied */ }
  }
  constructor(private readonly options: {
    store: SetupConfigStore;
    current: T;
    isIdle: (candidate: Settings, current: T) => boolean;
    validate: (candidate: Settings) => void;
    start: (settings: Settings) => Promise<T>;
  }) { this.current = options.current; }

  get applying(): boolean { return this.requested !== undefined || this.running !== undefined; }

  request(revision: number): SetupSaveResult['activation'] {
    if (this.fatal || this.stopping) throw new SetupConfigError('SETUP_UNAVAILABLE');
    if (this.quiescing) throw new SetupConfigError('SETUP_BUSY');
    const view = this.options.store.view();
    if (view.revision !== revision) throw new SetupConfigError('SETUP_REVISION_CONFLICT');
    if (!view.pendingChanges) return 'ALREADY_APPLIED';
    const candidate = this.options.store.candidate(revision);
    this.options.validate(candidate);
    this.requested = revision;
    return this.options.isIdle(candidate, this.current) ? 'APPLYING' : 'WAITING_FOR_IDLE';
  }

  tick(): Promise<void> {
    if (this.fatal) return Promise.reject(new Error(this.fatal));
    if (this.stopping) return Promise.resolve();
    this.running ??= this.activate().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async activate(): Promise<void> {
    const revision = this.requested;
    if (revision === undefined) return;
    if (this.options.store.view().revision !== revision) { this.requested = undefined; return; }
    const candidate = this.options.store.candidate(revision);
    if (!this.options.isIdle(candidate, this.current)) return;
    this.quiescing = true;
    // No await between closing admission and this second synchronous gate.
    if (!this.options.isIdle(candidate, this.current)) { this.quiescing = false; return; }
    const previous = this.options.store.active();
    this.requested = undefined;
    try { await this.current.stop(); }
    catch {
      this.fatal = 'SETUP_STOP_FAILED';
      this.markFailed(revision);
      throw new Error(this.fatal);
    }
    let started: T | undefined;
    try {
      started = await this.options.start(candidate);
      this.current = started; // Keep ownership even if durable activation/cleanup fails.
      this.options.store.commitActivation(revision);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SERVER_STARTUP_CLEANUP_FAILED') {
        this.fatal = 'SETUP_STOP_FAILED';
        this.markFailed(revision);
        throw new Error(this.fatal);
      }
      if (started) {
        // rename can succeed before the directory fsync fails. Read back the
        // authority rather than claiming the previous bytes are still active.
        let committed = false;
        try { const view = this.options.store.view(); committed = view.appliedRevision === revision && !view.pendingChanges; } catch { /* cannot prove commit */ }
        if (committed) { this.persistenceWarning = true; this.quiescing = false; return; }
      }
      // If persistence failed after a new graph started, close it before rollback.
      if (started) {
        try { await started.stop(); }
        catch { this.fatal = 'SETUP_STOP_FAILED'; throw new Error(this.fatal); }
      }
      this.markFailed(revision);
      try { this.current = await this.options.start(previous); }
      catch { this.fatal = 'SETUP_ROLLBACK_FAILED'; throw new Error(this.fatal); }
    }
    this.quiescing = false;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.requested = undefined;
    this.quiescing = true;
    await this.running?.catch(() => undefined);
    await this.current.stop();
  }
}
