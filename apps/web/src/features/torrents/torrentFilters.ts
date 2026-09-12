import type { TorrentState, TorrentSummary } from '@ptvault/contracts';

export type TorrentHistoryFilter = 'ALL' | 'NEVER' | 'HAS';
export type TorrentSort = 'NAME' | 'SIZE' | 'RATIO' | 'SEEDING' | 'CLOUD';
export type SortDirection = 'ASC' | 'DESC';

export type TorrentFilterInput = {
  query: string;
  cloudStates: readonly TorrentSummary['cloudState'][];
  torrentStates: readonly TorrentState[];
  history: TorrentHistoryFilter;
};

export function torrentIdentity(torrent: Pick<TorrentSummary, 'instanceId' | 'hash'>): string {
  return `${torrent.instanceId}:${torrent.hash.toLowerCase()}`;
}

export function applyTorrentFilters(
  torrents: readonly TorrentSummary[],
  offloadKeys: ReadonlySet<string>,
  input: TorrentFilterInput,
): TorrentSummary[] {
  const query = input.query.trim().toLocaleLowerCase();
  const cloudStates = new Set(input.cloudStates);
  const torrentStates = new Set(input.torrentStates);

  return torrents.filter((torrent) => {
    if (
      query !== '' &&
      !torrent.name.toLocaleLowerCase().includes(query) &&
      !torrent.hash.toLowerCase().startsWith(query)
    ) {
      return false;
    }
    if (cloudStates.size > 0 && !cloudStates.has(torrent.cloudState)) return false;
    if (torrentStates.size > 0 && !torrentStates.has(torrent.state)) return false;
    const hasHistory = offloadKeys.has(torrentIdentity(torrent));
    if (input.history === 'NEVER' && hasHistory) return false;
    if (input.history === 'HAS' && !hasHistory) return false;
    return true;
  });
}

const CLOUD_ORDER: Record<TorrentSummary['cloudState'], number> = {
  LOCAL: 0,
  MIGRATING: 1,
  CLOUD_COMMITTED: 2,
  CLOUD: 3,
  REHYDRATING: 4,
  BLOCKED: 5,
};

export function sortTorrents(
  torrents: readonly TorrentSummary[],
  sort: TorrentSort,
  direction: SortDirection,
): TorrentSummary[] {
  const factor = direction === 'ASC' ? 1 : -1;
  return [...torrents].sort((left, right) => {
    let compared = 0;
    switch (sort) {
      case 'NAME':
        compared = left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        break;
      case 'SIZE':
        compared = left.totalSize - right.totalSize;
        break;
      case 'RATIO':
        compared = left.ratio - right.ratio;
        break;
      case 'SEEDING':
        compared = left.seedingSeconds - right.seedingSeconds;
        break;
      case 'CLOUD':
        compared = CLOUD_ORDER[left.cloudState] - CLOUD_ORDER[right.cloudState];
        break;
    }
    if (compared !== 0) return compared * factor;
    return torrentIdentity(left).localeCompare(torrentIdentity(right));
  });
}
