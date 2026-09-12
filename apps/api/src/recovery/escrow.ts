import { Buffer } from 'node:buffer';

const MAX_ESCROW_BYTES = 4 * 1024 * 1024;
const AGE_HEADER = 'age-encryption.org/v1';

export function assertPassphraseEncryptedAge(value: Uint8Array): void {
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > MAX_ESCROW_BYTES) {
    throw new Error('INVALID_ENCRYPTED_ESCROW');
  }
  if (bytes.includes(Buffer.from('AGE-SECRET-KEY-', 'ascii'))) {
    throw new Error('ESCROW_MUST_ALREADY_BE_ENCRYPTED');
  }

  const footerStart = bytes.indexOf(Buffer.from('\n--- ', 'ascii'));
  const footerEnd = footerStart < 0 ? -1 : bytes.indexOf(0x0a, footerStart + 1);
  if (footerStart < 0 || footerEnd < 0 || footerEnd === bytes.length - 1) {
    throw new Error('INVALID_AGE_ENVELOPE');
  }

  const header = bytes.subarray(0, footerEnd).toString('ascii');
  const lines = header.split('\n');
  if (lines[0] !== AGE_HEADER) throw new Error('INVALID_AGE_ENVELOPE');

  const stanzaLines = lines.filter((line) => line.startsWith('-> '));
  if (
    stanzaLines.length !== 1 ||
    !/^-> scrypt [A-Za-z0-9+/]+={0,2} [1-9][0-9]?$/.test(stanzaLines[0] ?? '')
  ) {
    throw new Error('ESCROW_MUST_USE_PASSPHRASE_ENCRYPTION');
  }

  const footer = lines.at(-1) ?? '';
  if (!/^--- [A-Za-z0-9+/]+={0,2}$/.test(footer)) {
    throw new Error('INVALID_AGE_ENVELOPE');
  }
  const stanzaBody = lines.slice(2, -1);
  if (stanzaBody.length === 0 || stanzaBody.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))) {
    throw new Error('INVALID_AGE_ENVELOPE');
  }
}
