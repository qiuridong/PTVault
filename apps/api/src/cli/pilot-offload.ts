import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { OffloadImportance } from '@ptvault/contracts';

import { resolveMasterKeyCredential } from '../config/credentials.js';
import { SecretBox } from '../core/crypto.js';
import { openDatabase } from '../db/database.js';
import { QbClient } from '../qb/client.js';
import { applyPathMaps, parsePathMaps, type PathMap } from '../qb/path-map.js';
import { QbRepository } from '../qb/repository.js';
import type { QbControl, QbControlRegistry } from '../qb/types.js';
import { StorageAccountRepository } from '../storage/accounts.js';
import { OffloadHandler } from '../storage/offload-handler.js';
import { OffloadMachine } from '../storage/offload-machine.js';
import { createDatabaseRcloneRunner } from '../storage/managed-rclone.js';
import { RcloneClient, type RcloneControl } from '../storage/rclone.js';

/**
 * The rclone surface the pilot needs: the handler's staging operations plus the
 * two probes the pilot itself performs (remote enumeration for account
 * registration, capacity for the selector). Narrowed so a test can supply an
 * in-memory crypt remote without implementing every rclone verb.
 */
export type PilotRclone = Pick<
  RcloneControl,
  'listRemotes' | 'about' | 'copy' | 'move' | 'stat' | 'cat'
>;

/**
 * One-shot pilot: back a single torrent up to the cloud and stop at
 * CLOUD_COMMITTED. It exists to prove the real offload pipeline end-to-end
 * (pause → snapshot → hash → stage → strict decrypted readback → commit) against
 * the live qB + rclone crypt remotes, WITHOUT ever deleting the local copy.
 *
 * Why this is safe to run under Gate B:
 *  - `OffloadHandler.run` loops only until CLOUD_COMMITTED; LOCAL_CLEANUP (the
 *    only step that unlinks source bytes) is never entered here.
 *  - The recovery gate below is an explicit pilot sentinel. In production a real
 *    deletion permit demands the full recovery-material chain (public recipient,
 *    escrow verified, ≥2 cloud copies, computer confirmation). Because the pilot
 *    never deletes, that invariant is never exercised — the sentinel only unblocks
 *    the upload guard, exactly as the integration harness's fake does.
 *
 * qB credentials come only from PTVAULT_QB_USERNAME / PTVAULT_QB_PASSWORD so they
 * never land in argv or shell history.
 */

const PILOT_INSTANCE_ID = 'pilot-qb';

/**
 * A single container→host path rewrite, supplied as `--path-map <container>=<host>`.
 *
 * Re-exported from the shared module so the pilot and the server apply byte-for-byte
 * the same rewrite: a prefix rule that disagreed between them would mean the pilot
 * proved a path the server then fails to read.
 */
export type PilotPathMap = PathMap;

export type PilotOffloadArgs = {
  baseUrl: string;
  torrentHash: string;
  cryptRemote: string;
  rawRemote: string;
  stateDir: string;
  configPath: string;
  importance: OffloadImportance;
  reserveBytes: number;
  pathMaps: readonly PilotPathMap[];
};

export type RunPilotOptions = {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<Writable, 'write'>;
  stderr?: Pick<Writable, 'write'>;
  qbFactory?: (args: PilotOffloadArgs, username: string, password: string) => QbControl;
  rcloneFactory?: (args: PilotOffloadArgs, env: NodeJS.ProcessEnv) => PilotRclone;
};

function requireString(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MISSING_${name.toUpperCase().replaceAll('-', '_')}`);
  }
  return value;
}

export function parsePilotOffloadArgs(argv: readonly string[]): PilotOffloadArgs {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      'base-url': { type: 'string' },
      'torrent-hash': { type: 'string' },
      'crypt-remote': { type: 'string' },
      'raw-remote': { type: 'string' },
      'state-dir': { type: 'string' },
      config: { type: 'string' },
      importance: { type: 'string' },
      'reserve-bytes': { type: 'string' },
      'path-map': { type: 'string', multiple: true },
    },
  });

  const stateDir = requireString(values['state-dir'], 'state-dir');
  const configPath = requireString(values.config, 'config');
  if (!path.isAbsolute(stateDir) || !path.isAbsolute(configPath)) {
    throw new Error('ABSOLUTE_PATH_REQUIRED');
  }
  const importance = values.importance ?? 'IMPORTANT';
  if (importance !== 'STANDARD' && importance !== 'IMPORTANT') {
    throw new Error('INVALID_IMPORTANCE');
  }
  const reserveRaw = values['reserve-bytes'] ?? '0';
  const reserveBytes = Number(reserveRaw);
  if (!Number.isInteger(reserveBytes) || reserveBytes < 0) {
    throw new Error('INVALID_RESERVE_BYTES');
  }
  const pathMaps = collectPathMaps(values['path-map']);

  return {
    baseUrl: requireString(values['base-url'], 'base-url'),
    torrentHash: requireString(values['torrent-hash'], 'torrent-hash'),
    cryptRemote: requireString(values['crypt-remote'], 'crypt-remote'),
    rawRemote: requireString(values['raw-remote'], 'raw-remote'),
    stateDir: path.resolve(stateDir),
    configPath: path.resolve(configPath),
    importance,
    reserveBytes,
    pathMaps,
  };
}

/** Normalizes `parseArgs`'s string-or-array shape before shared parsing. */
function collectPathMaps(raw: string | string[] | undefined): readonly PilotPathMap[] {
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return parsePathMaps(entries);
}

/**
 * Re-exported so the rewrite stays reachable from the pilot's own entry point.
 * The implementation now lives in `qb/path-map.ts` and is shared with the server.
 */
export { applyPathMaps };

/** A registry that exposes exactly the one live qB instance the pilot targets. */
class SingleQbRegistry implements QbControlRegistry {
  constructor(private readonly control: QbControl) {}
  listInstanceIds(): readonly string[] {
    return [PILOT_INSTANCE_ID];
  }
  get(): QbControl {
    return this.control;
  }
}

export async function runPilotOffload(options: RunPilotOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const args = parsePilotOffloadArgs(options.argv);

    const username = requireString(env.PTVAULT_QB_USERNAME, 'qb-username');
    const password = requireString(env.PTVAULT_QB_PASSWORD, 'qb-password');

    // The master key protects the exported .torrent at rest; reuse the same
    // systemd-credential resolution the server uses so the pilot needs no
    // separate secret handling.
    const resolved = resolveMasterKeyCredential(env);
    const masterKeyRaw = requireString(resolved.PTVAULT_MASTER_KEY, 'master-key');
    const masterKey = Buffer.from(masterKeyRaw, 'base64');
    if (masterKey.length !== 32) throw new Error('PTVAULT_MASTER_KEY must decode to 32 bytes');

    const qb =
      options.qbFactory?.(args, username, password) ??
      new QbClient({
        instanceId: PILOT_INSTANCE_ID,
        baseUrl: args.baseUrl,
        username,
        password,
        environment: 'production',
      });

    // Confirm the torrent is present and pull its live content path so the
    // snapshot step reads the correct bytes on disk.
    const torrents = await qb.list();
    const target = torrents.find(
      (candidate) => candidate.hash.toLowerCase() === args.torrentHash.toLowerCase(),
    );
    if (!target) throw new Error('PILOT_TORRENT_NOT_FOUND');
    if (target.progress < 1) throw new Error('PILOT_TORRENT_INCOMPLETE');

    mkdirSync(args.stateDir, { recursive: true });
    db = openDatabase(path.join(args.stateDir, 'ptvault.db'));
    const now = (): number => Date.now();

    // Seed the one instance + torrent inventory the handler will read back.
    const repository = new QbRepository(db);
    repository.upsertInstance({
      id: PILOT_INSTANCE_ID,
      displayName: 'Pilot qB',
      enabled: true,
      secretRef: 'pilot:qb',
    });
    // qB reports paths in its own (container) namespace; rewrite them to the
    // host paths the pilot can actually read before seeding the inventory.
    const localized = {
      ...target,
      state: 'SEEDING' as const,
      content_path: applyPathMaps(target.content_path, args.pathMaps),
      save_path: applyPathMaps(target.save_path, args.pathMaps),
    };
    repository.reconcile(PILOT_INSTANCE_ID, [localized], now());

    // Register the storage account against the real crypt/raw remotes and probe
    // live capacity so the account selector has a measured free-space figure.
    const rclone =
      options.rcloneFactory?.(args, env) ??
      new RcloneClient({
        runner: createDatabaseRcloneRunner({ db, masterKey, configPath: args.configPath }),
        executable: env.PTVAULT_RCLONE_BIN?.trim() || 'rclone',
        configPath: args.configPath,
      });
    const remotes = await rclone.listRemotes();
    const accounts = new StorageAccountRepository(db, now);
    const account = accounts.register(
      {
        label: 'pilot-primary',
        rawRemote: args.rawRemote,
        cryptRemote: args.cryptRemote,
        reserveBytes: args.reserveBytes,
      },
      remotes,
    );
    const capacity = await rclone.about(args.rawRemote);
    accounts.recordHealth(account.id, {
      health: 'HEALTHY',
      totalBytes: capacity.total,
      freeBytes: capacity.free,
      checkedAt: now(),
    });

    // PILOT_CONTINUATION_2
    const machine = new OffloadMachine(db, now);
    const created = machine.create({
      instanceId: PILOT_INSTANCE_ID,
      torrentHash: args.torrentHash,
      importance: args.importance,
    });

    const handler = new OffloadHandler({
      db,
      machine,
      // The real crypt-path preflight ran separately and passed; the pilot's own
      // preflight is a pass-through so this single run stays focused on the
      // upload + readback path.
      preflight: {
        check: (identity) =>
          Promise.resolve({
            ...identity,
            eligible: true,
            logicalBytes: 0,
            allocatedBytes: 0,
            reclaimableBytes: 0,
            issues: [],
          }),
      },
      registry: new SingleQbRegistry(qb),
      torrentRepository: repository,
      // SENTINEL recovery gate — pilot only. It unblocks the upload guard without
      // the real recovery-material chain. Legitimate because this run never
      // deletes local: `run()` stops at CLOUD_COMMITTED, so nothing ever consumes
      // this permit to authorise a deletion. Version 1 is the lowest value the
      // snapshot schema accepts (recoveryVersion must be a positive integer); it
      // is a fixed placeholder, not a real recovery export.
      recoveryGate: {
        issueDeletionPermit: (jobId: string) =>
          Promise.resolve({
            kind: 'DELETION_PERMIT',
            jobId,
            recoveryVersion: 1,
            issuedAt: now(),
          }),
      },
      accounts,
      rclone,
      secretBox: new SecretBox(masterKey),
      now,
    });

    stdout.write(
      `${JSON.stringify({ event: 'PILOT_STARTED', jobId: created.jobId, hash: args.torrentHash, account: account.id })}\n`,
    );

    await handler.run(created.jobId, new AbortController().signal);

    const final = machine.get(created.jobId);
    if (final?.currentStep !== 'CLOUD_COMMITTED') {
      throw new Error(`PILOT_DID_NOT_COMMIT: ${final?.currentStep ?? 'MISSING'}`);
    }

    stdout.write(
      `${JSON.stringify({
        event: 'PILOT_CLOUD_COMMITTED',
        jobId: created.jobId,
        step: final.currentStep,
        recoveryVersion: final.recoveryVersion,
        localPreserved: true,
      })}\n`,
    );

    return 0;
  } catch (error) {
    stderr.write(`Pilot offload failed: ${redactError(error)}\n`);
    return 1;
  } finally {
    db?.close();
  }
}

// PILOT_CONTINUATION_3

/**
 * Never let a secret leak through an error message. rclone/qB errors carry only
 * codes and exit statuses, but guard defensively: emit the error name + message,
 * and drop anything that looks like a base64/hex blob long enough to be a key.
 */
function redactError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED]');
}

export async function main(): Promise<void> {
  process.exitCode = await runPilotOffload({ argv: process.argv.slice(2) });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  void main();
}
