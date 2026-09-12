import { Download, Gauge, Timer, Upload } from 'lucide-react';

import type { ImportProgressSnapshot } from '@ptvault/contracts';

import {
  formatCountdown,
  formatDecimalBytes,
  formatEta,
  formatOptionalRate,
  formatPercent,
  percentOfDecimal,
} from './importFormatting.js';
import { importResourceWaitText } from './importResourceWait.js';
import { IMPORT_STEP_HINTS } from './importLabels.js';
import { importRetryWaitViewModel } from './importRetryWaitViewModel.js';
import {
  importTelemetryIsVisible,
  importTelemetryState,
  type ImportTelemetryState,
} from './importTelemetry.js';

/**
 * A labelled meter whose percentage may be unknown.
 *
 * `null` renders an empty track and the words, rather than a zero-width bar: a
 * job whose total size has not been discovered yet has no percentage, and a bar
 * pinned at the left is read as "nothing has happened".
 */
function ProgressMeter({
  label,
  percent,
  figure,
}: {
  label: string;
  percent: number | null;
  figure: string;
}) {
  return (
    <div className="import-meter">
      <div className="import-meter-head">
        <span className="import-meter-label">{label}</span>
        <span className="import-meter-figure">
          {figure}
          <span className="import-meter-percent">{formatPercent(percent)}</span>
        </span>
      </div>
      <div
        className="meter-track"
        role="img"
        aria-label={`${label}：${figure}，进度 ${formatPercent(percent)}`}
      >
        <span className="meter-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
    </div>
  );
}

/**
 * One measured rate, or an explicit statement that it was not measured.
 *
 * The three legs are drawn separately and never summed. A single blended figure
 * hides which leg is the bottleneck, and identifying the bottleneck is the only
 * thing the number is read for: a job at 12 MiB/s download and 31 MiB/s upload
 * is source-bound, and the reverse is a OneDrive problem.
 */
function RateCell({
  label,
  value,
  icon: Icon,
  telemetryState,
}: {
  label: string;
  value: string | undefined;
  icon: typeof Download;
  telemetryState: ImportTelemetryState;
}) {
  const visible = importTelemetryIsVisible(telemetryState);
  const display =
    telemetryState === 'waiting'
      ? '当前未在传输'
      : telemetryState === 'stale'
        ? '样本已过期'
        : formatOptionalRate(value);
  const reported = visible && value !== undefined;
  return (
    <div className="import-rate" data-reported={reported}>
      <dt>
        <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
        {label}
      </dt>
      <dd className={reported ? undefined : 'is-unknown'}>{display}</dd>
    </div>
  );
}

/**
 * The live figures for one import.
 *
 * Two meters rather than one: the job's verified fraction answers "how far
 * through this whole import am I", and the current object's answers "is the
 * thing on screen moving". A single overall bar on a 24-object job looks frozen
 * for twenty minutes at a time while an object uploads, which is how a healthy
 * transfer gets reported as stalled.
 */
export function ImportProgress({
  progress,
  now,
}: {
  progress: ImportProgressSnapshot;
  now: number;
}) {
  const jobPercent = percentOfDecimal(progress.jobBytesVerified, progress.jobBytesTotal);
  const objectPercent = percentOfDecimal(progress.objectBytesDone, progress.objectBytesTotal);
  const telemetryState = importTelemetryState(progress, now);
  const waitText = importResourceWaitText(progress);
  const inPlace = progress.state === 'RUNNING' && progress.downloadRetryInPlace === true;
  const retry =
    progress.state === 'RETRY_WAIT' || inPlace
      ? importRetryWaitViewModel(progress.retryAt, now)
      : null;
  const etaVisible = importTelemetryIsVisible(telemetryState);
  const etaDisplay =
    telemetryState === 'waiting'
      ? '当前未在传输'
      : telemetryState === 'stale'
        ? '样本已过期'
        : formatEta(progress.etaSeconds);

  return (
    <div className="import-progress">
      <ProgressMeter
        label="整体（已验证字节）"
        percent={jobPercent}
        figure={`${formatDecimalBytes(progress.jobBytesVerified)} / ${formatDecimalBytes(progress.jobBytesTotal)}`}
      />
      {progress.state !== 'COMPLETED' && jobPercent === 100 ? (
        <p className="field-hint" role="status">
          字节校验已到 100%，任务尚未完成；请以任务状态和当前收尾步骤为准。
        </p>
      ) : null}
      {progress.state !== 'COMPLETED' && IMPORT_STEP_HINTS[progress.currentStep] ? (
        <p className="field-hint">{IMPORT_STEP_HINTS[progress.currentStep]}</p>
      ) : null}
      <ProgressMeter
        label={`当前文件（第 ${progress.objectIndex} / ${progress.objectCount} 个）`}
        percent={objectPercent}
        figure={`${formatDecimalBytes(progress.objectBytesDone)} / ${formatDecimalBytes(progress.objectBytesTotal)}`}
      />

      {progress.currentObjectAlias === undefined ? null : (
        <p className="import-current-object">
          当前对象 <code>{progress.currentObjectAlias}</code>
        </p>
      )}

      {progress.resourceWait === undefined ? null : (
        <p className="inline-message import-resource-wait" role="status">
          <Timer size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>
            {waitText} · 当前未在传输 · 从{' '}
            <time dateTime={progress.resourceWait.since}>
              {new Date(progress.resourceWait.since).toLocaleString()}
            </time>{' '}
            开始等待
          </span>
        </p>
      )}

      {/*
        A named group, because 「百度下载」 is also the name of a *step*: the same
        words labelling two different things on one panel is what makes a reader
        stop and re-read. This label says these three are rates.
      */}
      <dl className="import-rate-grid" role="group" aria-label="分段速率">
        <RateCell
          label="百度下载"
          value={progress.downloadRateBps}
          icon={Download}
          telemetryState={telemetryState}
        />
        <RateCell
          label="OneDrive 上传"
          value={progress.uploadRateBps}
          icon={Upload}
          telemetryState={telemetryState}
        />
        <RateCell
          label="回读校验"
          value={progress.verifyRateBps}
          icon={Gauge}
          telemetryState={telemetryState}
        />
        <div
          className="import-rate"
          data-reported={etaVisible && progress.etaSeconds !== undefined}
        >
          <dt>
            <Timer size={13} strokeWidth={1.9} aria-hidden="true" />
            预计剩余
          </dt>
          <dd
            className={etaVisible && progress.etaSeconds !== undefined ? undefined : 'is-unknown'}
          >
            {etaDisplay}
          </dd>
        </div>
      </dl>

      {retry === null ? null : (
        <p className="import-retry-line">
          {retry.kind === 'BACKOFF' && progress.retryAt !== undefined ? (
            <>
              {inPlace ? '就地续传 · ' : ''}退避中 · 最早重试时间{' '}
              <strong>{formatCountdown(progress.retryAt, now)}</strong>
              <time dateTime={progress.retryAt}>{new Date(progress.retryAt).toLocaleString()}</time>
            </>
          ) : (
            <>
              <strong>{inPlace ? '等待就地续传名额' : retry.label}</strong> · {retry.hint}
            </>
          )}
        </p>
      )}
    </div>
  );
}
