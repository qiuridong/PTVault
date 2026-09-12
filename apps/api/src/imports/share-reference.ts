import { createHash } from 'node:crypto';

import { ImportControlError, importInvariant } from './errors.js';

export type SanitizedShareReference = {
  sanitizedUrl: string;
  inlinePasscode: string | null;
  fingerprint: string;
};

const SECRET_QUERY_KEYS = new Set([
  'password',
  'passcode',
  'extract_code',
  'extraction_code',
  'token',
  'access_token',
  'authorization',
  'cookie',
]);

function normalizePasscode(value: string): string {
  const passcode = value.trim();
  importInvariant(/^[A-Za-z0-9]{4}$/.test(passcode), 'IMPORT_PASSCODE_INVALID', 400);
  return passcode;
}

function extractPwd(params: URLSearchParams): string[] {
  const found: string[] = [];
  for (const key of [...params.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized === 'pwd') {
      found.push(...params.getAll(key));
      params.delete(key);
      continue;
    }
    importInvariant(!SECRET_QUERY_KEYS.has(normalized), 'IMPORT_SECRET_QUERY_REJECTED', 400);
  }
  return found;
}

export function sanitizeBaiduShareReference(
  raw: string,
  allowedHosts: readonly string[] = ['pan.baidu.com'],
): SanitizedShareReference {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImportControlError('IMPORT_SHARE_URL_INVALID', 400);
  }
  importInvariant(url.protocol === 'https:', 'IMPORT_SHARE_HTTPS_REQUIRED', 400);
  importInvariant(
    url.username === '' && url.password === '',
    'IMPORT_SHARE_USERINFO_REJECTED',
    400,
  );
  importInvariant(url.port === '', 'IMPORT_SHARE_PORT_REJECTED', 400);
  const allowlist = new Set(allowedHosts.map((host) => host.toLowerCase()));
  importInvariant(allowlist.has(url.hostname.toLowerCase()), 'IMPORT_SHARE_HOST_REJECTED', 400);
  importInvariant(url.pathname !== '/', 'IMPORT_SHARE_PATH_INVALID', 400);

  const passcodes = extractPwd(url.searchParams);
  if (url.hash.includes('=')) {
    passcodes.push(...extractPwd(new URLSearchParams(url.hash.slice(1).replace(/^\?/, ''))));
  }
  url.hash = '';
  const normalized = new Set(passcodes.map(normalizePasscode));
  importInvariant(normalized.size <= 1, 'IMPORT_PASSCODE_CONFLICT', 400);
  url.searchParams.sort();
  const sanitizedUrl = url.toString();
  return {
    sanitizedUrl,
    inlinePasscode: [...normalized][0] ?? null,
    fingerprint: createHash('sha256').update(sanitizedUrl).digest('hex'),
  };
}

export function normalizeInlinePasscode(value: string): string {
  return normalizePasscode(value);
}
