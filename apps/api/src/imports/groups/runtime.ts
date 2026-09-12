import { statfs } from 'node:fs/promises';
import type { AppDatabase } from '../../db/database.js';
import type { ArchiveImportProcessor } from '../archive/processor.js';
import type { ImportWorkerRepository } from '../worker-repository.js';
import type { SpoolManager } from '../data-plane/spool.js';
import type { ImportSpoolCapacityGate } from '../data-plane/spool-capacity.js';
import type { ImportDataPlaneSourceResolver } from '../data-plane/types.js';
import type { RangeDownloader } from '../data-plane/range-downloader.js';
import type { ImportDataPlaneProcessorOptions } from '../data-plane/processor.js';
import { PipelineObservationStore } from '../../system/pipeline-observation-store.js';
import { PipelineObservationService } from '../../system/pipeline-observation-service.js';
import { PipelineActivitySampler } from '../../system/pipeline-activity.js';
import { GroupResourceScheduler } from './resources.js';
import { GroupSettingsService, DEFAULT_GROUP_SETTINGS } from './settings.js';
import { ImportPipelineRepository } from './repository.js';
import { GroupAdmissionCoordinator } from './admission.js';
import { GroupSpoolManager } from './spool.js';

type Options = {
  db: AppDatabase;
  provisioned: () => boolean;
  observationPath: string;
  build: string;
  legacySettings: () => { spoolMaxBytes: string; spoolReserveBytes: string; maxInFlight: number };
  reservedBytes: () => string;
  onCapacityChanged: () => void;
  activity?: Pick<PipelineActivitySampler, 'sample'>;
};

/** The HTTP controls, actual worker permits and observation view share one graph. */
export class GroupPipelineRuntime {
  readonly repository: ImportPipelineRepository;
  readonly resources: GroupResourceScheduler;
  readonly settings: GroupSettingsService;
  readonly observations: PipelineObservationService;
  constructor(private readonly options: Options) {
    this.repository = new ImportPipelineRepository(options.db);
    this.resources = new GroupResourceScheduler(DEFAULT_GROUP_SETTINGS, {
      record: (event) => this.observations?.recordResource(event),
    });
    this.settings = new GroupSettingsService({
      db: options.db,
      resources: this.resources,
      provisioned: options.provisioned,
      residentBudgetBytes: () => this.residentBudgetBytes(),
      onApplied: () => {
        options.onCapacityChanged();
        this.observations?.record({ kind: 'CONFIG', code: 'GROUP_SETTINGS_UPDATED' });
      },
    });
    this.observations = new PipelineObservationService({
      activity: options.activity ?? new PipelineActivitySampler({ db: options.db }),
      db: options.db,
      settings: this.settings,
      resources: this.resources,
      reservedBytes: options.reservedBytes,
      build: options.build,
      store: new PipelineObservationStore({ path: options.observationPath }),
    });
  }
  planLimits(): { residentMaxBytes: string; waitingCacheMaxBytes: string } {
    const current = this.settings.status();
    return {
      residentMaxBytes: current.residentBudgetBytes,
      waitingCacheMaxBytes: current.effective.waitingCacheMaxBytes,
    };
  }
  attach(options: {
    archive: ArchiveImportProcessor;
    worker: ImportWorkerRepository;
    spool: SpoolManager;
    sources: ImportDataPlaneSourceResolver;
    downloader: RangeDownloader;
    capacity: ImportSpoolCapacityGate;
  }): Pick<ImportDataPlaneProcessorOptions, 'groupResources' | 'groupAdmission' | 'claimLimits'> {
    const manager = new GroupSpoolManager({ db: this.options.db, ...options });
    const admission = new GroupAdmissionCoordinator({
      db: this.options.db,
      repository: this.repository,
      capacity: options.capacity,
      minIntervalMs: 1000,
      limits: () => ({
        ...this.planLimits(),
        maxResidentGroups: this.settings.status().effective.maxResidentGroups,
      }),
      reserveBytes: () => this.options.legacySettings().spoolReserveBytes,
      freeBytes: async () => {
        const fs = await statfs(options.spool.root, { bigint: true });
        return (fs.bavail * fs.bsize).toString();
      },
      measure: (id) => manager.measure(id),
      evict: async (id) => {
        const evicted = await manager.evict(id);
        if (evicted)
          this.observations.record({
            kind: 'EVICTION',
            code: 'SOURCE_VERIFIED_CACHE_EVICTED',
            jobId: id,
          });
        return evicted;
      },
      holdNewAdmission: () => this.observations.holdNewAdmission(),
      onAdmitted: (id, redownload) =>
        this.observations.record({
          kind: redownload ? 'REDOWNLOAD' : 'ADMISSION',
          code: redownload ? 'GROUP_READMITTED_FOR_DOWNLOAD' : 'GROUP_ADMITTED',
          jobId: id,
        }),
    });
    return {
      groupResources: this.resources,
      groupAdmission: admission,
      claimLimits: () => ({
        legacy: this.options.legacySettings().maxInFlight,
        grouped: this.settings.status().effective.maxResidentGroups,
      }),
    };
  }
  close(): Promise<void> {
    return this.observations.close();
  }
  private residentBudgetBytes(): string {
    const values = this.options.legacySettings(),
      max = BigInt(values.spoolMaxBytes),
      reserve = BigInt(values.spoolReserveBytes);
    return (max > reserve ? max - reserve : 0n).toString();
  }
}
