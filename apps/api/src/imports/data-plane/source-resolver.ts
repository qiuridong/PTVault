import type { AppDatabase } from '../../db/database.js';
import type { ImportWorkerJob } from '../worker-repository.js';
import { ImportDataPlaneError } from './errors.js';
import type { ImportDataPlaneSource, ImportDataPlaneSourceResolver } from './types.js';
import { legacyBoundSourceJob } from '../legacy-source-binding.js';
import { DatabaseImportSourceConnectionCatalog } from '../source-connections.js';
import { ImportControlError } from '../errors.js';
import { canonicalSourceManifest, sourceManifestDigest } from '../source-manifest.js';

export { legacyBoundSourceJob } from '../legacy-source-binding.js';

export type BoundImportSourceContext = {
  sourceConnectionId: string;
  sourceKind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR';
  sourceProvider: 'BAIDU';
  sourceExternalAccountId: string;
  sourceManifestRevision: number;
  connectionRevision: number;
  secretRefId: string;
};

export type BoundImportSourceFactory = (
  context: BoundImportSourceContext,
) => ImportDataPlaneSource | Promise<ImportDataPlaneSource>;

export function importSourceBindingKey(
  sourceConnectionId: string,
  sourceKind: 'BAIDU_SHARE' | 'BAIDU_APP_DIR',
): string {
  if (!/^[0-9a-f-]{36}$/i.test(sourceConnectionId)) {
    throw new ImportDataPlaneError('IMPORT_SOURCE_BINDING_INVALID');
  }
  return `${sourceConnectionId}\u0000${sourceKind}`;
}

export type DatabaseImportSourceResolverOptions = {
  db: AppDatabase;
  factories: ReadonlyMap<string, BoundImportSourceFactory>;
};

type ConnectionRow = {
  provider: string;
  externalAccountId: string;
  authState: string;
  secretRef: string | null;
  revision: number;
};

/** Exact connection+kind resolver. Labels and provider-global defaults are never consulted. */
export class DatabaseImportSourceResolver implements ImportDataPlaneSourceResolver {
  constructor(private readonly options: DatabaseImportSourceResolverOptions) {}

  async resolve(job: ImportWorkerJob): Promise<ImportDataPlaneSource> {
    const legacy = legacyBoundSourceJob(this.options.db, job);
    job = legacy.job;
    const selection =
      typeof job.selection === 'object' && job.selection !== null
        ? (job.selection as Record<string, unknown>)
        : {};
    if (selection.sourceScope === 'FILE' || job.sourceManifest?.version === 2) {
      if (
        job.sourceKind !== 'BAIDU_APP_DIR' ||
        selection.sourceScope !== 'FILE' ||
        job.sourceManifest?.version !== 2 ||
        selection.sourcePath !== job.sourceManifest.rootPath
      ) {
        throw new ImportDataPlaneError('SOURCE_CHANGED');
      }
    }
    if (
      job.sourceConnectionId == null ||
      job.sourceProvider !== 'BAIDU' ||
      job.sourceExternalAccountId == null ||
      job.sourceManifestRevision == null ||
      !Number.isSafeInteger(job.sourceManifestRevision) ||
      job.sourceManifestRevision < 0 ||
      (job.sourceKind !== 'BAIDU_SHARE' && job.sourceKind !== 'BAIDU_APP_DIR')
    ) {
      throw new ImportDataPlaneError('IMPORT_SOURCE_BINDING_REQUIRED');
    }
    const row = this.options.db
      .prepare(
        `SELECT provider, external_account_id AS externalAccountId,
                auth_state AS authState, secret_ref AS secretRef, revision
         FROM cloud_connections WHERE id = ?`,
      )
      .get(job.sourceConnectionId) as ConnectionRow | undefined;
    if (row === undefined) throw new ImportDataPlaneError('IMPORT_SOURCE_CONNECTION_MISSING');
    if (
      row.provider !== job.sourceProvider ||
      row.externalAccountId !== job.sourceExternalAccountId
    ) {
      throw new ImportDataPlaneError('IMPORT_SOURCE_IDENTITY_DRIFT');
    }
    if (row.authState !== 'CONNECTED' || row.secretRef === null) {
      throw new ImportDataPlaneError('AUTH_REQUIRED');
    }
    const factory = this.options.factories.get(
      importSourceBindingKey(job.sourceConnectionId, job.sourceKind),
    );
    if (factory === undefined) {
      throw new ImportDataPlaneError('IMPORT_SOURCE_BINDING_NOT_CONFIGURED');
    }
    try {
      new DatabaseImportSourceConnectionCatalog(this.options.db).requireBaiduSource(
        job.sourceConnectionId,
        job.sourceKind,
      );
    } catch (error) {
      throw new ImportDataPlaneError(
        error instanceof ImportControlError ? error.code : 'IMPORT_SOURCE_CAPABILITY_MISSING',
      );
    }
    const source = await factory({
      sourceConnectionId: job.sourceConnectionId,
      sourceKind: job.sourceKind,
      sourceProvider: 'BAIDU',
      sourceExternalAccountId: job.sourceExternalAccountId,
      sourceManifestRevision: job.sourceManifestRevision,
      connectionRevision: row.revision,
      secretRefId: row.secretRef,
    });
    if (job.sourceManifest?.version === 2) {
      const manifest = canonicalSourceManifest(job.sourceManifest);
      if (sourceManifestDigest(manifest) !== job.sourceManifestDigest || manifest.version !== 2) {
        throw new ImportDataPlaneError('SOURCE_CHANGED');
      }
      const expected = manifest.objects[0]!;
      return {
        discover: (current, signal) => source.discover(current, signal),
        preflight: async (task, signal) => {
          if (
            task.sourceFsid !== expected.fsid ||
            task.sourceSize !== expected.size ||
            task.sourceMtime !== expected.mtime
          ) {
            throw new ImportDataPlaneError('SOURCE_CHANGED');
          }
          return source.preflight(
            { ...task, sourcePath: expected.path, sourceScope: 'FILE' },
            signal,
          );
        },
        ...(source.releaseCredential === undefined
          ? {}
          : { releaseCredential: (current) => source.releaseCredential!(current) }),
      };
    }
    if (legacy.manifest === null) return source;
    return {
      discover: () => Promise.reject(new ImportDataPlaneError('AUTH_LEGACY_REPLAN_REQUIRED')),
      preflight: (task, signal) => {
        const expected = legacy.manifest!.objects.find((object) => object.fsid === task.sourceFsid);
        if (
          expected === undefined ||
          expected.size !== task.sourceSize ||
          expected.mtime !== task.sourceMtime
        )
          throw new ImportDataPlaneError('SOURCE_CHANGED');
        return source.preflight({ ...task, sourcePath: expected.path }, signal);
      },
      ...(source.releaseCredential === undefined
        ? {}
        : { releaseCredential: (job) => source.releaseCredential!(job) }),
    };
  }
}
