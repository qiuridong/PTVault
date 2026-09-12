import {
  DownloadFailureDiagnosticSchema,
  type DownloadFailureDiagnostic,
} from '@ptvault/contracts';

/** Invalid or historical unstructured text is unavailable, never a guessed cause. */
export function readDownloadDiagnostic(
  value: string | null,
): DownloadFailureDiagnostic | undefined {
  if (value === null || value.length > 300) return undefined;
  try {
    const parsed = DownloadFailureDiagnosticSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function encodeDownloadDiagnostic(value: unknown): string | null {
  const parsed = DownloadFailureDiagnosticSchema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}
