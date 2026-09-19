import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { ServerEventSchema } from '@ptvault/contracts';

import { isDemoSessionActive } from '../demo/demoSession.js';

/**
 * Whether the browser currently holds an open event stream.
 *
 * Surfaced so a page can tell the operator which of two very different things is
 * happening: "nothing has changed" or "we stopped being told about changes".
 */
export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * How long progress ticks are allowed to pile up before one refetch is issued.
 *
 * The API samples telemetry about once a second per running transfer, and every
 * sample publishes a `job.updated`. Eight parallel transfers therefore produce
 * eight invalidations a second, each of which refetches `/api/offloads`,
 * `/api/jobs` and `/api/imports` — the page spent its time re-rendering a table
 * whose figures had moved by a few megabytes.
 *
 * 500 ms is a tail, not a throttle: the first frame does not wait, but frames
 * arriving during the window are absorbed into the one refetch at its end. A
 * transfer still reads as live, and the request count stops scaling with the
 * number of things being watched.
 */
export const JOB_EVENT_MERGE_WINDOW_MS = 500;

/**
 * Subscribes to `/api/events` and invalidates the queries an event affects.
 *
 * The server has published these since the beginning; nothing consumed them, so a
 * migration ran to completion while the page kept showing the step it had loaded
 * with. Watching a transfer meant pressing refresh.
 *
 * Invalidating rather than patching cached rows on purpose: the event carries a
 * job id and a state, but the transfers table shows snapshot fields the event does
 * not include. Refetching keeps one source of truth and costs a small request on a
 * page the operator is already watching.
 */
export function useServerEvents(): LiveStatus {
  const queryClient = useQueryClient();
  const demoActive = isDemoSessionActive();
  const [status, setStatus] = useState<LiveStatus>(() => (demoActive ? 'live' : 'connecting'));

  useEffect(() => {
    if (demoActive) {
      setStatus('live');
      return;
    }
    // `withCredentials` sends the session cookie; the endpoint refuses without it.
    const source = new EventSource('/api/events', { withCredentials: true });

    source.onopen = () => {
      // SSE has no replay cursor. A terminal event can be missed between two
      // connections, so re-read snapshots before relying on the live stream.
      for (const queryKey of [
        ['imports'], ['offloads'], ['jobs'], ['qb', 'torrents'], ['media'],
        ['storage'], ['settings'], ['recovery'], ['cloud-connections'], ['offload-scheduler'],
      ]) void queryClient.invalidateQueries({ queryKey });
      setStatus('live');
    };

    /*
     * Merge state for job frames.
     *
     * `torrentsToo` is sticky across a window: if any frame in it reported a
     * COMPLETED job, the flush has to reach the torrents table even though the
     * frame that closed the window may have been a plain progress tick.
     */
    let mergeTimer: ReturnType<typeof setTimeout> | undefined;
    let torrentsToo = false;

    const flushJobs = (): void => {
      if (mergeTimer !== undefined) {
        clearTimeout(mergeTimer);
        mergeTimer = undefined;
      }
      const withTorrents = torrentsToo;
      torrentsToo = false;
      void queryClient.invalidateQueries({ queryKey: ['offloads'] });
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
      /*
       * Netdisk imports publish the same event kind. Invalidating the list
       * prefix also reaches every open job-detail query, because those keys are
       * `['imports', jobId]` — this hook cannot know which panel is open, and
       * threading that in would give it a dependency on the page.
       *
       * The frame itself is never merged into a cached job. It carries a job id,
       * a state and a fraction; the table and the detail panel show a dozen
       * fields it does not have, and the REST snapshot is the authority. So this
       * says "go re-read" and nothing more.
       */
      void queryClient.invalidateQueries({ queryKey: ['imports'] });
      // Restore jobs use the shared worker stream too. Refresh authoritative
      // snapshots and local/cloud availability instead of leaving a live page stale.
      void queryClient.invalidateQueries({ queryKey: ['media', 'rehydrates'] });
      void queryClient.invalidateQueries({ queryKey: ['media', 'catalog'] });
      // A finished migration changes the torrent's cloud state, so the torrents
      // table is stale too — and that is the table the operator returns to.
      if (withTorrents) void queryClient.invalidateQueries({ queryKey: ['qb', 'torrents'] });
    };

    source.onmessage = (message: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        // A frame we cannot parse is a server we do not understand. Dropping it
        // is safer than acting on a guess, and the next valid frame still works.
        return;
      }
      const event = ServerEventSchema.safeParse(parsed);
      if (!event.success) return;

      if (event.data.type === 'job.updated') {
        if (event.data.state === 'COMPLETED') torrentsToo = true;
        /*
         * A durable control boundary is never coalesced.
         *
         * `eventCode` is set exactly when a pause was requested, took effect, or
         * was lifted — the moments at which the buttons the operator is allowed
         * to press change. Holding one of those for half a second would leave
         * 「暂停」 on screen after the pause was already recorded, and an operator
         * pressing it again is how a second control request gets booked. A
         * completion is flushed for the same reason: it is the transition the
         * cleanup gate turns on, not a byte count.
         */
        if (event.data.eventCode !== undefined || event.data.state === 'COMPLETED') {
          flushJobs();
          return;
        }
        // A progress tick starts the window if none is open, and is absorbed if
        // one is. Either way exactly one refetch happens per window.
        if (mergeTimer === undefined) {
          mergeTimer = setTimeout(() => {
            mergeTimer = undefined;
            flushJobs();
          }, JOB_EVENT_MERGE_WINDOW_MS);
        }
        return;
      }

      if (event.data.type === 'scheduler.updated') {
        /*
         * Re-read rather than believe the frame. It carries `schedulerState` and a
         * monotonic `revision`, but not the drain picture — counts, blockers,
         * `offloadDrained`/`databaseDrained` — and a client that painted the state
         * from the frame alone would show PAUSED beside stale counts saying two
         * handlers are still running. `revision` exists so the re-read can be told
         * apart from an older answer, not so the frame can substitute for it.
         *
         * Not merged: a scheduler transition is exactly the boundary this hook
         * must not delay, and the frames are rare — one per pause-all/resume-all,
         * not one per second.
         */
        void queryClient.invalidateQueries({ queryKey: ['offload-scheduler'] });
        return;
      }

      // `health.updated`. Checked last, and by type rather than by shape: it is no
      // longer the only frame carrying a `component`, so the old
      // `component.startsWith('storage:')` fallthrough would have run for every
      // scheduler frame too.
      if (event.data.component.startsWith('storage:')) {
        void queryClient.invalidateQueries({ queryKey: ['storage', 'accounts'] });
      }
    };

    // EventSource reconnects on its own; this only reports that it is currently
    // between attempts, so the page can fall back to polling meanwhile.
    source.onerror = () => setStatus('offline');

    return () => {
      // The timer outlives the stream otherwise, and would fire an invalidation
      // against a QueryClient the unmounted page no longer reads.
      if (mergeTimer !== undefined) clearTimeout(mergeTimer);
      source.close();
    };
  }, [demoActive, queryClient]);

  return status;
}
