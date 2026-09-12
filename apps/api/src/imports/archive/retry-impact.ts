import type { ArchiveJobStatus, ArchiveRetryImpact } from '@ptvault/contracts';
import type { ArchiveInput, PreparedArchive } from './repository.js';
import { isArchiveSourceManifest, type ImportSourceManifest } from '../source-manifest.js';

export type RetryOutput = {
  id: string;
  sourceFsid: string;
  relativePath: string;
  sourceSize: string;
  sourceMtime: string;
  state: string;
  localSha256: string | null;
  originKind: string;
  originDigest: string | null;
};
export function unknownRetryImpact(sampledAt: number): ArchiveRetryImpact {
  return {
    mode: 'UNKNOWN',
    basis: 'CHECKPOINT_ESTIMATE',
    sampledAt,
    downloadBytes: null,
    retainedInputBytes: null,
    reextract: null,
  };
}
const decimal = /^(?:0|[1-9]\d{0,29})$/;
const hash = /^[a-f0-9]{64}$/;
const uploadedStates = new Set([
  'HASHED',
  'UPLOADING_STAGING',
  'STAGING_UPLOADED',
  'STAGING_READBACK',
  'STAGING_VERIFIED',
  'COMMITTING',
  'COMMITTED',
  'COMMITTED_READBACK',
  'COMMITTED_VERIFIED',
  'CONTROL_PLANE_BACKED_UP',
  'SPOOL_CLEANED',
  'COMPLETED',
]);
/** Pure metadata projection. Never performs filesystem or provider I/O. */
export function projectArchiveRetryImpact(input: {
  phase: ArchiveJobStatus['phase'];
  inputCount: number;
  inputBytes: string;
  videoCount: number;
  videoBytes: string;
  sourceDigest: string;
  manifest: ImportSourceManifest;
  prepared: PreparedArchive | null;
  preparedDigest: string | null;
  inputs: readonly ArchiveInput[];
  outputs: readonly RetryOutput[];
  evicting: boolean;
  sampledAt: number;
}): ArchiveRetryImpact {
  const unknown = unknownRetryImpact(input.sampledAt);
  if (input.evicting || !isArchiveSourceManifest(input.manifest)) return unknown;
  const inputs = new Map(input.inputs.map((x) => [x.sourceFsid, x]));
  const source = input.manifest.objects;
  if (
    inputs.size !== input.inputs.length ||
    inputs.size !== input.inputCount ||
    source.length !== inputs.size ||
    new Set(source.map((x) => x.fsid)).size !== source.length
  )
    return unknown;
  let total = 0n,
    retained = 0n;
  for (const object of source) {
    const x = inputs.get(object.fsid);
    if (
      !x ||
      x.sourceSize !== object.size ||
      x.sourceMtime !== object.mtime ||
      x.relativePath !== object.relativePath ||
      !decimal.test(x.completedBytes)
    )
      return unknown;
    const done = BigInt(x.completedBytes),
      size = BigInt(object.size);
    if (done > size) return unknown;
    total += size;
    switch (x.state) {
      case 'PENDING':
        if (done !== 0n) return unknown;
        break;
      case 'DOWNLOADING':
        if (done > 0n && (x.partialDevice === null || x.partialInode === null)) return unknown;
        retained += done;
        break;
      case 'READY':
        if (
          done !== size ||
          x.readyDevice === null ||
          x.readyInode === null ||
          !hash.test(x.localSha256 ?? '')
        )
          return unknown;
        retained += size;
        break;
      case 'CLEANED':
        if (input.prepared === null || done !== size || !hash.test(x.localSha256 ?? ''))
          return unknown;
        break;
      default:
        return unknown;
    }
  }
  if (total.toString() !== input.inputBytes) return unknown;
  const proof = input.prepared;
  if (proof !== null) {
    if (
      proof.sourceManifestDigest !== input.sourceDigest ||
      input.preparedDigest === null ||
      proof.inputs.length !== inputs.size ||
      new Set(proof.inputs.map((x) => x.fsid)).size !== inputs.size
    )
      return unknown;
    for (const p of proof.inputs) {
      const x = inputs.get(p.fsid);
      if (
        !x ||
        !['READY', 'CLEANED'].includes(x.state) ||
        p.size !== x.sourceSize ||
        p.mtime !== x.sourceMtime ||
        p.relativePath !== x.relativePath ||
        p.sha256 !== x.localSha256
      )
        return unknown;
    }
    if (
      proof.outputs.length !== input.videoCount ||
      proof.outputs.reduce((sum, x) => sum + BigInt(x.size), 0n).toString() !== input.videoBytes
    )
      return unknown;
    if (
      new Set(proof.outputs.map((x) => x.objectId)).size !== proof.outputs.length ||
      new Set(proof.outputs.map((x) => x.localId)).size !== proof.outputs.length ||
      new Set(proof.outputs.map((x) => x.relativePath.normalize('NFC').toLowerCase())).size !==
        proof.outputs.length
    )
      return unknown;
    if (input.phase === 'PREPARING_VIDEOS') {
      if (input.outputs.length !== 0) return unknown;
    } else if (input.phase === 'READY' || input.phase === 'CLEANED') {
      const outputs = new Map(input.outputs.map((x) => [x.id, x]));
      if (outputs.size !== proof.outputs.length || input.outputs.length !== outputs.size)
        return unknown;
      for (const p of proof.outputs) {
        const x = outputs.get(p.objectId);
        if (
          !x ||
          x.sourceFsid !== p.localId ||
          x.relativePath !== p.relativePath ||
          x.sourceSize !== p.size ||
          x.sourceMtime !== '0' ||
          x.localSha256 !== p.sha256 ||
          x.originKind !== 'EXTRACTED' ||
          x.originDigest !== input.preparedDigest ||
          !uploadedStates.has(x.state)
        )
          return unknown;
      }
    } else return unknown;
    return {
      ...unknown,
      mode: 'REUSE_OUTPUTS',
      downloadBytes: '0',
      retainedInputBytes: retained.toString(),
      reextract: false,
    };
  }
  if (
    input.preparedDigest !== null ||
    input.outputs.length !== 0 ||
    ['READY', 'CLEANED'].includes(input.phase)
  )
    return unknown;
  return {
    ...unknown,
    mode:
      retained === 0n ? 'REDOWNLOAD_INPUTS' : retained === total ? 'REUSE_INPUTS' : 'RESUME_INPUTS',
    downloadBytes: (total - retained).toString(),
    retainedInputBytes: retained.toString(),
    reextract: true,
  };
}
