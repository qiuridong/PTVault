import { importInvariant } from './errors.js';

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,29})$/;
const FORBIDDEN_KEY =
  /(?:^|_)(?:pwd|password|passcode|extraction_?code|access_?token|refresh_?token|authorization|cookie|dlink)(?:_|$)/i;
const FORBIDDEN_VALUE =
  /(?:[?&](?:pwd|password|passcode|access_token)=|%3f(?:pwd|password)%3d|bearer\s+[a-z0-9._~-]+)/i;

export function decimalString(value: string, field: string): string {
  importInvariant(
    DECIMAL_PATTERN.test(value),
    'IMPORT_INVALID_DECIMAL',
    500,
    `${field} is invalid`,
  );
  return value;
}

export function sanitizedJson(value: unknown, field: string): string {
  const ancestors = new Set<object>();
  const walk = (current: unknown): void => {
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      importInvariant(!FORBIDDEN_VALUE.test(current), 'IMPORT_SECRET_REJECTED', 400);
      return;
    }
    if (typeof current === 'number') {
      importInvariant(Number.isFinite(current), 'IMPORT_INVALID_JSON', 400);
      return;
    }
    importInvariant(typeof current === 'object', 'IMPORT_INVALID_JSON', 400);
    importInvariant(!ancestors.has(current), 'IMPORT_INVALID_JSON', 400);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach(walk);
        return;
      }
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        importInvariant(!FORBIDDEN_KEY.test(key), 'IMPORT_SECRET_REJECTED', 400);
        walk(item);
      }
    } finally {
      ancestors.delete(current);
    }
  };
  walk(value);
  const encoded = JSON.stringify(value);
  importInvariant(encoded !== undefined, 'IMPORT_INVALID_JSON', 400, `${field} is invalid`);
  return encoded;
}

export function sanitizedDetail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  importInvariant(trimmed.length <= 300, 'IMPORT_DETAIL_TOO_LONG', 500);
  importInvariant(!FORBIDDEN_VALUE.test(trimmed), 'IMPORT_SECRET_REJECTED', 500);
  return trimmed;
}

export function assertSecretRef(value: string): string {
  importInvariant(
    /^import-secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
    'IMPORT_SECRET_REF_INVALID',
    400,
  );
  return value;
}
