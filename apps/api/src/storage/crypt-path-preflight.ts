import { createHash } from 'node:crypto';
import path from 'node:path';

import type { OffloadImportance } from '@ptvault/contracts';

import { libraryBlobPath, stagingBlobPath } from './blob-path.js';

export const PROVIDER_FULL_PATH_LIMIT = 400;
export const PROVIDER_SEGMENT_LIMIT = 255;

export type CryptPathEncoder = {
  encodePaths(remote: string, plaintextPaths: readonly string[]): Promise<string[]>;
};

export type CryptPathNamespace = 'STAGING' | 'LIBRARY' | 'SECONDARY_STAGING';

export type CryptPathMeasurement = {
  namespace: CryptPathNamespace;
  sourceRelativePath: string;
  plaintextPath: string;
  encodedPath: string;
  providerPath: string;
  fullPathCharacters: number;
  maxSegmentCharacters: number;
};

export type CryptPathIssue = {
  code: 'FULL_PATH_TOO_LONG' | 'SEGMENT_TOO_LONG';
  namespace: CryptPathNamespace;
  sourceRelativePath: string;
  plaintextPath: string;
  encodedProviderPath: string;
  measuredCharacters: number;
  limitCharacters: number;
  segment?: string;
  segmentIndex?: number;
};

export type CryptPathPreflightInput = {
  cryptRemote: string;
  providerPrefix: string;
  torrentHash: string;
  jobId: string;
  importance: OffloadImportance;
  relativePaths: readonly string[];
};

export type CryptPathPreflightReport = {
  version: 1;
  eligible: boolean;
  cryptRemote: string;
  providerPrefix: string;
  torrentHash: string;
  jobId: string;
  importance: OffloadImportance;
  limits: {
    fullPathCharacters: typeof PROVIDER_FULL_PATH_LIMIT;
    segmentCharacters: typeof PROVIDER_SEGMENT_LIMIT;
  };
  sourcePathCount: number;
  evaluatedPathCount: number;
  measurements: CryptPathMeasurement[];
  issues: CryptPathIssue[];
  evidenceSha256: string;
};

type ExpandedPath = {
  namespace: CryptPathNamespace;
  sourceRelativePath: string;
  plaintextPath: string;
};

const REMOTE_ALIAS = /^[A-Za-z0-9_-]+:$/;
const TORRENT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const UUID_SHAPED = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class CryptPathPreflight {
  constructor(private readonly options: { encoder: CryptPathEncoder }) {}

  async check(input: CryptPathPreflightInput): Promise<CryptPathPreflightReport> {
    const normalized = normalizeInput(input);
    const expanded = expandPaths(normalized);
    const encodedPaths = await this.options.encoder.encodePaths(
      normalized.cryptRemote,
      expanded.map((candidate) => candidate.plaintextPath),
    );
    if (encodedPaths.length !== expanded.length) throw new Error('INVALID_ENCODER_OUTPUT');

    const measurements: CryptPathMeasurement[] = [];
    const issues: CryptPathIssue[] = [];
    for (let index = 0; index < expanded.length; index += 1) {
      const candidate = expanded[index];
      const encodedPath = encodedPaths[index];
      if (!candidate || encodedPath === undefined) throw new Error('INVALID_ENCODER_OUTPUT');
      assertRelativePath(encodedPath, 'encoded path');

      const providerPath = joinProviderPath(normalized.providerPrefix, encodedPath);
      const segments = providerPath.split('/');
      const segmentLengths = segments.map(countCharacters);
      const fullPathCharacters = countCharacters(providerPath);
      measurements.push({
        namespace: candidate.namespace,
        sourceRelativePath: candidate.sourceRelativePath,
        plaintextPath: candidate.plaintextPath,
        encodedPath,
        providerPath,
        fullPathCharacters,
        maxSegmentCharacters: Math.max(...segmentLengths),
      });

      if (fullPathCharacters > PROVIDER_FULL_PATH_LIMIT) {
        issues.push({
          code: 'FULL_PATH_TOO_LONG',
          namespace: candidate.namespace,
          sourceRelativePath: candidate.sourceRelativePath,
          plaintextPath: candidate.plaintextPath,
          encodedProviderPath: providerPath,
          measuredCharacters: fullPathCharacters,
          limitCharacters: PROVIDER_FULL_PATH_LIMIT,
        });
      }
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
        const measuredCharacters = segmentLengths[segmentIndex];
        const segment = segments[segmentIndex];
        if (
          measuredCharacters === undefined ||
          segment === undefined ||
          measuredCharacters <= PROVIDER_SEGMENT_LIMIT
        ) {
          continue;
        }
        issues.push({
          code: 'SEGMENT_TOO_LONG',
          namespace: candidate.namespace,
          sourceRelativePath: candidate.sourceRelativePath,
          plaintextPath: candidate.plaintextPath,
          encodedProviderPath: providerPath,
          measuredCharacters,
          limitCharacters: PROVIDER_SEGMENT_LIMIT,
          segment,
          segmentIndex,
        });
      }
    }

    const unsignedReport: Omit<CryptPathPreflightReport, 'evidenceSha256'> = {
      version: 1,
      eligible: issues.length === 0,
      cryptRemote: normalized.cryptRemote,
      providerPrefix: normalized.providerPrefix,
      torrentHash: normalized.torrentHash,
      jobId: normalized.jobId,
      importance: normalized.importance,
      limits: {
        fullPathCharacters: PROVIDER_FULL_PATH_LIMIT,
        segmentCharacters: PROVIDER_SEGMENT_LIMIT,
      },
      sourcePathCount: normalized.relativePaths.length,
      evaluatedPathCount: measurements.length,
      measurements,
      issues,
    };
    const evidenceSha256 = createHash('sha256')
      .update(JSON.stringify(unsignedReport), 'utf8')
      .digest('hex');
    return { ...unsignedReport, evidenceSha256 };
  }
}

function normalizeInput(input: CryptPathPreflightInput): CryptPathPreflightInput {
  if (!REMOTE_ALIAS.test(input.cryptRemote)) throw new Error('INVALID_CRYPT_REMOTE');
  if (!TORRENT_HASH.test(input.torrentHash)) throw new Error('INVALID_TORRENT_HASH');
  if (!UUID_SHAPED.test(input.jobId)) throw new Error('INVALID_JOB_ID');
  if (input.importance !== 'STANDARD' && input.importance !== 'IMPORTANT') {
    throw new Error('INVALID_IMPORTANCE');
  }

  const relativePaths = [...input.relativePaths];
  if (relativePaths.length === 0) throw new Error('EMPTY_SOURCE_MANIFEST');
  for (const relativePath of relativePaths) assertRelativePath(relativePath, 'source path');
  relativePaths.sort(compareStrings);
  if (relativePaths.some((value, index) => index > 0 && value === relativePaths[index - 1])) {
    throw new Error('DUPLICATE_SOURCE_PATH');
  }

  return {
    cryptRemote: input.cryptRemote,
    providerPrefix: normalizeProviderPrefix(input.providerPrefix),
    torrentHash: input.torrentHash.toLowerCase(),
    jobId: input.jobId.toLowerCase(),
    importance: input.importance,
    relativePaths,
  };
}

/**
 * The worst-case digest. Preflight runs before HASHING, so no real SHA-256 exists
 * yet — but a content-addressed path's length does not depend on *which* digest it
 * carries, only that a digest is 64 lowercase hex characters. Measuring the
 * all-`f` digest therefore bounds every possible real path exactly, which is what
 * makes this check sound without hashing 2 TB first.
 */
const WORST_CASE_DIGEST = 'f'.repeat(64);

function expandPaths(input: CryptPathPreflightInput): ExpandedPath[] {
  const expanded: ExpandedPath[] = [];
  for (const sourceRelativePath of input.relativePaths) {
    expanded.push({
      namespace: 'STAGING',
      sourceRelativePath,
      plaintextPath: stagingBlobPath(`staging/${input.jobId}`, WORST_CASE_DIGEST),
    });
    expanded.push({
      namespace: 'LIBRARY',
      sourceRelativePath,
      plaintextPath: libraryBlobPath(WORST_CASE_DIGEST),
    });
    if (input.importance === 'IMPORTANT') {
      expanded.push({
        namespace: 'SECONDARY_STAGING',
        sourceRelativePath,
        plaintextPath: stagingBlobPath(`staging-secondary/${input.jobId}`, WORST_CASE_DIGEST),
      });
    }
  }
  return expanded;
}

function normalizeProviderPrefix(providerPrefix: string): string {
  if (providerPrefix.includes('\0')) throw new Error('INVALID_PROVIDER_PREFIX');
  const normalized = providerPrefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('INVALID_PROVIDER_PREFIX');
  }
  return normalized;
}

function assertRelativePath(candidate: string, label: string): void {
  const segments = candidate.split(/[\\/]/);
  if (
    candidate.length === 0 ||
    candidate.includes('\0') ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`INVALID_${label.toUpperCase().replaceAll(' ', '_')}`);
  }
}

function joinProviderPath(providerPrefix: string, encodedPath: string): string {
  return providerPrefix.length > 0 ? `${providerPrefix}/${encodedPath}` : encodedPath;
}

function countCharacters(value: string): number {
  return [...value].length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
