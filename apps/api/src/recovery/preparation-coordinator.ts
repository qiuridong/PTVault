/** Single-process ownership shared by readiness, material mutation and cleanup. */
export class RecoveryPreparationCoordinator {
  private readers = 0;
  private writer = false;

  acquireRead(): () => void {
    if (this.writer) throw new Error('RECOVERY_PREPARATION_BUSY');
    this.readers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.readers -= 1;
    };
  }

  acquireWrite(): () => void {
    if (this.writer || this.readers > 0) throw new Error('RECOVERY_PREPARATION_BUSY');
    this.writer = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writer = false;
    };
  }

  async withRead<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.acquireRead();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async withWrite<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.acquireWrite();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
