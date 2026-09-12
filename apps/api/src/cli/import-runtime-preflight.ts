import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  inspectImportPreparation,
  type ImportPreparationInput,
} from '../config/import-preflight.js';

// Private JSON input only, no dotenv sourcing, subprocesses, installation or writes.
const file = process.argv[2];
try {
  if (!file || !path.isAbsolute(file)) throw new Error('input');
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 256 * 1024 ||
    process.platform === 'win32' ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error('private input');
  const input: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !input ||
    typeof input !== 'object' ||
    !('environment' in input) ||
    !('expectedUid' in input) ||
    typeof input.expectedUid !== 'number' ||
    !('spoolMaxBytes' in input) ||
    typeof input.spoolMaxBytes !== 'string' ||
    !('hostReserveBytes' in input) ||
    typeof input.hostReserveBytes !== 'string'
  )
    throw new Error('shape');
  const report = await inspectImportPreparation(input as ImportPreparationInput);
  console.log(JSON.stringify(report, null, 2));
  if (!report.assemblyPreflightPassed) process.exitCode = 2;
} catch {
  console.log(
    JSON.stringify({ error: 'PRIVATE_PREFLIGHT_INPUT_INVALID', executionAuthorized: false }),
  );
  process.exitCode = 2;
}
