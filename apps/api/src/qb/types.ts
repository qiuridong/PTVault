export type NormalizedTorrentState =
  'DOWNLOADING' | 'SEEDING' | 'PAUSED' | 'CHECKING' | 'MISSING_FILES' | 'ERROR' | 'UNKNOWN';

export type QbTorrent = {
  hash: string;
  name: string;
  progress: number;
  state: string;
  size: number;
  amount_left: number;
  content_path: string;
  save_path: string;
  ratio: number;
  seeding_time: number;
  completion_on: number;
};

export interface QbControl {
  version(): Promise<string>;
  list(): Promise<QbTorrent[]>;
  pause(hash: string): Promise<void>;
  exportTorrent(hash: string): Promise<Uint8Array>;
  forceRecheck(hash: string): Promise<void>;
  resume(hash: string): Promise<void>;
  addTag(hash: string, tag: string): Promise<void>;
}

export interface QbControlRegistry {
  listInstanceIds(): readonly string[];
  get(instanceId: string): QbControl;
}
