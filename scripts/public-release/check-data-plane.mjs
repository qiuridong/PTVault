import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic, zero-network smoke test of the actual compiled release, not source aliases.
const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('RELEASE_ROOT_REQUIRED');
const modulePath = path.join(root, 'apps/api/dist/imports/data-plane/destination.js');
const { VerifiedDestinationAdapter } = await import(pathToFileURL(modulePath).href);
const bytes = Buffer.from('PTVault synthetic release data-plane proof');
const sha = createHash('sha256').update(bytes).digest('hex');
const stageKey = 'staging/fixture-job/fixture-object', finalKey = 'objects/' + sha;
const passed = [];
for (const scenario of ['fresh', 'duplicate', 'quarantine']) {
  const objects = new Map();
  if (scenario === 'duplicate') { objects.set(stageKey, bytes); objects.set(finalKey, bytes); }
  if (scenario === 'quarantine') objects.set(stageKey, Buffer.alloc(0));
  let committedRead = false, pending = null;
  const receipts = [];
  const transport = {
    stat: key => Promise.resolve(objects.has(key) ? { size: String(objects.get(key).length) } : null),
    upload: (_local, key) => { objects.set(key, bytes); return Promise.resolve(); },
    read: async function* (key) {
      await Promise.resolve();
      if (key === finalKey) committedRead = true;
      assert(objects.has(key)); yield objects.get(key);
    },
    move: (from, to, _signal, options) => {
      assert(objects.has(from));
      if (options?.immutable) assert(!objects.has(to));
      objects.set(to, objects.get(from)); objects.delete(from); return Promise.resolve({});
    },
    deleteFile: key => {
      assert.equal(key, stageKey);
      assert(committedRead, 'CLEANUP_BEFORE_COMMITTED_READBACK');
      objects.delete(key); return Promise.resolve();
    },
  };
  await new VerifiedDestinationAdapter(transport).commit({
    localReadyPath: 'synthetic-only', expectedSize: String(bytes.length), expectedSha256: sha,
    stagingKey: stageKey, committedKey: finalKey, reconcileCommittedFirst: scenario === 'duplicate',
    loadPendingStagingQuarantine: () => pending,
    onStagingQuarantine: event => { pending = event.phase === 'INTENT' ? event : null; },
    onDurableReceipt: receipt => {
      if (receipt.kind === 'STAGING_VERIFIED') assert(objects.has(stageKey), 'STAGING_REMOVED_BEFORE_COMMIT');
      if (receipt.kind === 'COMMITTED_VERIFIED') assert(committedRead && !objects.has(stageKey));
      receipts.push(receipt.kind);
    },
  });
  assert.deepEqual(objects.get(finalKey), bytes);
  assert.equal(receipts.at(-1), 'COMMITTED_VERIFIED');
  assert.equal(pending, null);
  if (scenario === 'quarantine') assert.equal([...objects.keys()].filter(k => k.startsWith('quarantine/')).length, 1);
  passed.push(scenario);
}
console.log(JSON.stringify({ ok: true, passed, networkRequests: 0, compiledModuleSha256: createHash('sha256').update(await readFile(modulePath)).digest('hex') }));

