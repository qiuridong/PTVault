import type { DownloadFailureDiagnostic } from '@ptvault/contracts';

export class ImportDataPlaneError extends Error {
  constructor(
    readonly code: string,
    message = 'Import data-plane operation failed',
    readonly downloadDiagnostic?: DownloadFailureDiagnostic,
  ) {
    super(message);
    this.name = 'ImportDataPlaneError';
  }
}

export function dataPlaneInvariant(
  condition: unknown,
  code: string,
  message = 'Import data-plane invariant failed',
): asserts condition {
  if (!condition) throw new ImportDataPlaneError(code, message);
}

export class ImportControlStop extends Error {
  constructor(readonly control: 'PAUSED' | 'CANCELLED') {
    super(`IMPORT_CONTROL_${control}`);
    this.name = 'ImportControlStop';
  }
}
