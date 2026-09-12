export type MaintenanceStatus = { idle: boolean; nonterminal: boolean; retainedWork: boolean };
export type MaintenanceLease = { probe: () => MaintenanceStatus; release: () => void };

/** A short local-operator lease. No database state is rewritten to manufacture idleness. */
export class ManagedMaintenance {
  private owner: symbol | undefined;
  private stopping = false;
  constructor(private readonly status: () => MaintenanceStatus, private readonly applying: () => boolean) {}
  get closed(): boolean { return this.owner !== undefined || this.stopping; }
  stop(): void { this.stopping = true; }
  prepare(): MaintenanceLease {
    if (this.closed || this.applying()) throw Error('SETUP_BUSY');
    const owner = Symbol('maintenance');
    this.owner = owner; // Synchronous admission close BEFORE the authoritative gate.
    const release = () => { if (this.owner === owner) this.owner = undefined; };
    const probe = () => {
      if (this.owner !== owner || this.stopping || this.applying()) throw Error('SETUP_BUSY');
      const status = this.status();
      if (!status.idle) throw Error('SETUP_BUSY');
      return status;
    };
    try { probe(); return { probe, release }; }
    catch (error) { release(); throw error; }
  }
}
