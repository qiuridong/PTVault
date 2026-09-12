import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { LoginRequestSchema } from '@ptvault/contracts';

import { AuthRepository } from '../auth/repository.js';
import { AuthService, type AdminEnrollment } from '../auth/service.js';
import { resolveMasterKeyCredential } from '../config/credentials.js';
import { parseConfig } from '../config/env.js';
import { SecretBox } from '../core/crypto.js';
import { openDatabase } from '../db/database.js';

export type HiddenInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type CliOutput = Writable & { isTTY?: boolean };
export type CreateAdminAuth = Pick<AuthService, 'createInitialAdmin'>;
export type LineReader = (prompt: string, input: HiddenInput, output: CliOutput) => Promise<string>;

export type RunCreateAdminOptions = {
  auth: CreateAdminAuth;
  stdin?: HiddenInput;
  stdout?: CliOutput;
  readLine?: LineReader;
  readPassword?: LineReader;
};

async function readVisibleLine(
  prompt: string,
  input: HiddenInput,
  output: CliOutput,
): Promise<string> {
  const lines = createInterface({ input, output, terminal: true, historySize: 0 });
  try {
    return await lines.question(prompt);
  } finally {
    lines.close();
  }
}

export async function readHiddenPassword(
  prompt: string,
  input: HiddenInput,
  output: CliOutput,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('CREATE_ADMIN_TTY_REQUIRED');
  }

  output.write(prompt);
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = '';
    let settled = false;
    const cleanup = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onClose);
      input.off('error', onError);
      input.setRawMode?.(wasRaw);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          finish(new Error('CREATE_ADMIN_ABORTED'));
          return;
        }
        if (character === '\u0004') {
          finish(new Error('CREATE_ADMIN_EOF'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    const onEnd = (): void => finish(new Error('CREATE_ADMIN_EOF'));
    const onClose = (): void => finish(new Error('CREATE_ADMIN_EOF'));
    const onError = (): void => finish(new Error('CREATE_ADMIN_INPUT_FAILED'));

    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onClose);
    input.once('error', onError);
  });
}

function writeFailure(output: CliOutput, message: string): number {
  output.write(`${message}\n`);
  return 1;
}

export async function runCreateAdmin(options: RunCreateAdminOptions): Promise<number> {
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return writeFailure(output, 'Interactive TTY input is required.');
  }

  const readLine = options.readLine ?? readVisibleLine;
  const readPassword = options.readPassword ?? readHiddenPassword;

  try {
    const username = (await readLine('Username: ', input, output)).trim();
    if (!LoginRequestSchema.shape.username.safeParse(username).success) {
      return writeFailure(output, 'Username must be 1-64 characters.');
    }

    const password = await readPassword('Password: ', input, output);
    const confirmation = await readPassword('Confirm password: ', input, output);
    if (password !== confirmation) return writeFailure(output, 'Passwords do not match.');
    if (!LoginRequestSchema.shape.password.safeParse(password).success) {
      return writeFailure(output, 'Password must be 12-256 characters.');
    }

    let enrollment: AdminEnrollment;
    try {
      enrollment = await options.auth.createInitialAdmin(username, password);
    } catch (error) {
      return writeFailure(
        output,
        error instanceof Error && error.message === 'Initial admin already exists'
          ? 'Initial admin already exists.'
          : 'Admin creation failed.',
      );
    }

    output.write(`${enrollment.otpauthUrl}\n`);
    return 0;
  } catch {
    return writeFailure(output, 'Admin creation cancelled.');
  }
}

export async function main(): Promise<void> {
  let exitCode = 1;
  let db: ReturnType<typeof openDatabase> | undefined;

  try {
    const config = parseConfig(resolveMasterKeyCredential(process.env));
    mkdirSync(config.stateDir, { recursive: true });
    db = openDatabase(path.join(config.stateDir, 'ptvault.db'));
    const auth = new AuthService({
      repository: new AuthRepository(db),
      secretBox: new SecretBox(config.masterKey),
      now: () => new Date(),
    });
    exitCode = await runCreateAdmin({ auth });
  } catch {
    if (process.stdout.isTTY) process.stdout.write('Admin creation failed.\n');
  } finally {
    db?.close();
  }

  process.exitCode = exitCode;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
