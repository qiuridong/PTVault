import { useId, useRef, useState } from 'react';
import type { ImportEvent } from '@ptvault/contracts';
import { IMPORT_STEP_LABELS } from './importLabels.js';
import { downloadFailureViewModel } from './downloadFailureViewModel.js';

const PAGE_SIZE = 20;
const DOWNLOAD_RETRY_EVENTS = new Map([
  ['IMPORT_DOWNLOAD_RETRY_SCHEDULED', '准备从断点重连'],
  ['IMPORT_DOWNLOAD_RETRY_STARTED', '开始就地续传尝试'],
]);

/** A bounded viewport over the API's newest tail, not a deletion of history. */
export function ImportEventTimeline({ events }: { events: readonly ImportEvent[] }) {
  const regionId = useId();
  const scrollRegion = useRef<HTMLDivElement>(null);
  // Anchor by identity instead of offset so SSE cannot move an older page under
  // someone reading it. Null follows the newest events without scrolling the page.
  const [anchor, setAnchor] = useState<string | null>(null);
  const newestFirst = [...events].reverse();
  const anchorIndex = anchor === null ? 0 : newestFirst.findIndex((event) => event.id === anchor);
  const start = Math.max(0, anchorIndex);
  const visible = newestFirst.slice(start, start + PAGE_SIZE);
  const olderAvailable = start + visible.length < newestFirst.length;

  const showFrom = (index: number) => {
    setAnchor(index <= 0 ? null : (newestFirst[index]?.id ?? null));
    if (scrollRegion.current) scrollRegion.current.scrollTop = 0;
  };

  return (
    <section className="import-detail-section import-event-timeline" aria-label="脱敏事件时间线">
      <h3>事件时间线</h3>
      {events.length === 0 ? (
        <p className="import-publication-none">还没有事件。</p>
      ) : (
        <>
          <p className="field-hint import-timeline-range" aria-live="polite">
            第 {start + 1}–{start + visible.length} 条 / 已载入 {events.length} 条 · 最新在前
          </p>
          {anchorIndex < 0 ? (
            <p className="field-hint">原阅读位置已超出本次返回范围，已显示最新记录。</p>
          ) : null}
          <div
            ref={scrollRegion}
            id={regionId}
            className="import-timeline-viewport"
            role="region"
            aria-label="事件列表（内部滚动）"
            tabIndex={0}
          >
            <ul className="timeline-events">
              {visible.map((event) => {
                const diagnostic = downloadFailureViewModel(event.detail, event.downloadDiagnostic);
                return (
                  <li key={event.id}>
                    <span className="timeline-event-type">
                      {DOWNLOAD_RETRY_EVENTS.get(event.code) ?? event.code}
                      {event.step === null ? '' : ` · ${IMPORT_STEP_LABELS[event.step]}`}
                      {event.detail === null ? null : (
                        <small className="import-event-detail">{event.detail}</small>
                      )}
                      {diagnostic ? (
                        <small className="import-event-detail">
                          {diagnostic.label} · {diagnostic.hint} {diagnostic.evidence.join(' · ')}
                        </small>
                      ) : null}
                    </span>
                    <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
                  </li>
                );
              })}
            </ul>
          </div>
          <nav className="import-timeline-pages" aria-label="事件翻页">
            <button
              type="button"
              className="ghost-button"
              aria-controls={regionId}
              disabled={start === 0}
              onClick={() => showFrom(start - PAGE_SIZE)}
            >
              较新事件
            </button>
            <button
              type="button"
              className="ghost-button"
              aria-controls={regionId}
              disabled={!olderAvailable}
              onClick={() => showFrom(start + PAGE_SIZE)}
            >
              较早事件
            </button>
            {start > 0 ? (
              <button
                type="button"
                className="ghost-button"
                aria-controls={regionId}
                onClick={() => showFrom(0)}
              >
                回到最新
              </button>
            ) : null}
          </nav>
        </>
      )}
      <p className="field-hint">
        每页 20 条，可在列表内滚动；接口最多返回最近 500 条，不改动服务端事件记录。
        时间线已脱敏，提取码、token、dlink 与原始错误响应都不进入事件。
      </p>
    </section>
  );
}
