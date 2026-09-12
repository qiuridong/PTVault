export class ImportControlError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message = 'Import operation failed',
  ) {
    super(message);
    this.name = 'ImportControlError';
  }
}

export function importInvariant(
  condition: unknown,
  code: string,
  statusCode: number,
  message = 'Import operation failed',
): asserts condition {
  if (!condition) throw new ImportControlError(code, statusCode, message);
}
