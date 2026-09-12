import { z } from 'zod';
import type { PipelineMetrics } from '@ptvault/contracts';
import type { AppDatabase } from '../db/database.js';

export type JellyfinActivityOptions = {
  baseUrl: string;
  readToken: () => Promise<string>;
  fetch?: typeof fetch;
};
const Session = z.object({
  NowPlayingItem: z.object({ Id: z.string() }).nullable().optional(),
  PlayState: z.object({ IsPaused: z.boolean().optional() }).nullable().optional(),
  TranscodingInfo: z.object({}).nullable().optional(),
});

/** Counts only: existing qB inventory plus one bounded, read-only Jellyfin request per minute. */
export class PipelineActivitySampler {
  private jellyfinAt = -Infinity;
  private jellyfin: { playing: number; transcoding: number } | null = null;
  constructor(private readonly options: { db: AppDatabase; jellyfin?: JellyfinActivityOptions }) {}
  async sample(at: number): Promise<PipelineMetrics> {
    const metrics: PipelineMetrics = {
      qbDownloading: null,
      qbSeeding: null,
      qbInventoryAgeSeconds: null,
      jellyfinPlaying: null,
      jellyfinTranscoding: null,
      jellyfinSampleAgeSeconds: null,
    };
    try {
      const instances = this.options.db
        .prepare('SELECT last_sync_at,last_sync_error FROM qb_instances WHERE enabled=1')
        .all() as Array<{ last_sync_at: number | null; last_sync_error: string | null }>;
      const stamps = instances
        .map((row) => row.last_sync_at)
        .filter((value): value is number => value !== null);
      if (stamps.length)
        metrics.qbInventoryAgeSeconds = Math.max(0, (at - Math.min(...stamps)) / 1000);
      if (
        instances.length &&
        instances.every(
          (row) =>
            row.last_sync_at !== null &&
            row.last_sync_error === null &&
            at >= row.last_sync_at &&
            at - row.last_sync_at <= 600000,
        )
      ) {
        const rows = this.options.db
          .prepare(
            `SELECT t.state,count(*) AS count FROM torrents t JOIN qb_instances i ON i.id=t.instance_id WHERE i.enabled=1 AND t.absent_since IS NULL GROUP BY t.state`,
          )
          .all() as Array<{ state: string; count: number }>;
        metrics.qbDownloading = rows.find((row) => row.state === 'DOWNLOADING')?.count ?? 0;
        metrics.qbSeeding = rows.find((row) => row.state === 'SEEDING')?.count ?? 0;
      }
    } catch {
      /* unavailable inventory is not an idle qB */
    }
    if (this.options.jellyfin && at - this.jellyfinAt >= 60000) {
      this.jellyfinAt = at;
      this.jellyfin = await this.readSessions().catch(() => null);
    }
    if (this.jellyfin && at >= this.jellyfinAt && at - this.jellyfinAt <= 120000) {
      metrics.jellyfinPlaying = this.jellyfin.playing;
      metrics.jellyfinTranscoding = this.jellyfin.transcoding;
      metrics.jellyfinSampleAgeSeconds = (at - this.jellyfinAt) / 1000;
    }
    return metrics;
  }
  private async readSessions(): Promise<{ playing: number; transcoding: number }> {
    const options = this.options.jellyfin!;
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Error('JELLYFIN_ACTIVITY_UNAVAILABLE');
    url.pathname = url.pathname.replace(/\/$/, '') + '/Sessions';
    url.search = 'activeWithinSeconds=120';
    url.hash = '';
    const token = (await options.readToken()).trim();
    if (!token || token.length > 4096 || /[\r\n]/.test(token))
      throw Error('JELLYFIN_ACTIVITY_UNAVAILABLE');
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method: 'GET',
        headers: { 'x-emby-token': token, accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      const max = 512 * 1024;
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > max) {
        await response.body?.cancel();
        throw Error('JELLYFIN_ACTIVITY_UNAVAILABLE');
      }
      if (!response.body) throw Error('JELLYFIN_ACTIVITY_UNAVAILABLE');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > max) {
            controller.abort();
            throw Error('JELLYFIN_ACTIVITY_UNAVAILABLE');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const sessions = Session.array()
        .max(1000)
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const playing = sessions.filter(
        (session) => session.NowPlayingItem != null && session.PlayState?.IsPaused === false,
      );
      return {
        playing: playing.length,
        transcoding: playing.filter((session) => session.TranscodingInfo != null).length,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
