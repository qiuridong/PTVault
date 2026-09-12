import { Download, Gauge, Timer, Upload } from 'lucide-react';

import type { OffloadSnapshot, OffloadStep } from '@ptvault/contracts';

import {
  NOT_REPORTED,
  formatDecimalBytes,
  formatEta,
  formatOptionalRate,
  formatPercent,
  percentOfDecimal,
} from '../imports/importFormatting.js';
import { ResourceWaitStatus, resourceWaitText } from './ResourceWait.js';

/**
 * Live figures for one torrent offload, drawn only for the legs the server
 * actually measured.
 *
 * A different component from the importer's `ImportProgress` even though it
 * renders the same three rates, because the two contracts differ in the one way
 * that decides what may be drawn: every telemetry field on `OffloadSnapshot` is
 * optional. The importer's are required, so that panel can assume a meter always
 * has a number. Here absence is the normal case on any API build not yet taught
 * to measure a leg, and it has to render as a statement rather than as a zero.
 * Sharing one component would have meant either defaulting absent fields to `0` —
 * which claims a stall — or threading "maybe absent" through a panel where it is
 * never true.
 *
 * The formatters *are* shared, from `importFormatting`. That is where the BigInt
 * arithmetic and the 「未报告」 wording live, and a second copy would be a second
 * answer to how a 30-digit figure renders.
 */

/**
 * What the leg in flight is called, for the meter label.
 *
 * `FINALIZING_REMOTE` is here and not only in the step list because it is a leg
 * that moves bytes: the handler places each staged object into its PRIMARY
 * location and reads it back decrypted to record the per-file evidence the
 * deletion gate is later checked against. Omitting it drew a running transfer
 * with no meter at all for the whole commit — the step an operator is most
 * likely to be watching, because it is the last one before the cloud copy counts
 * as verified.
 */
const LEG_LABELS: Partial<Record<OffloadStep, string>> = {
  HASHING: '哈希校验（本地读盘）',
  UPLOADING_STAGING: '上传到暂存区',
  VERIFYING: '解密回读校验',
  FINALIZING_REMOTE: '定稿远端（提交并回读取证）',
};

/**
 * Which rate field the server writes for a given step.
 *
 * `FINALIZING_REMOTE` maps to `verifyRateBps` because that is what the API
 * actually records for it — the commit leg is a decrypted read-back, and the
 * reporter files its throughput under the verify field rather than inventing a
 * fourth one. Reading a different field here would render 「未报告」 for a leg the
 * server is measuring.
 */
const STEP_RATE_FIELD: Partial<
  Record<OffloadStep, 'hashRateBps' | 'uploadRateBps' | 'verifyRateBps'>
> = {
  HASHING: 'hashRateBps',
  UPLOADING_STAGING: 'uploadRateBps',
  VERIFYING: 'verifyRateBps',
  FINALIZING_REMOTE: 'verifyRateBps',
};

/**
 * The rate that belongs to the leg in flight, for a single-line summary.
 *
 * Chosen by which reading exists rather than by the step, so a build that
 * measures upload but not hashing still shows something useful while hashing.
 * Returns `null` when nothing was measured — the caller renders 「未报告」, never
 * `0 B/s`.
 */
export function activeTransferRate(
  snapshot: OffloadSnapshot,
): { label: string; value: string } | null {
  const { currentStep, uploadRateBps, hashRateBps, verifyRateBps } = snapshot;
  if (currentStep === 'HASHING' && hashRateBps !== undefined) {
    return { label: '哈希', value: hashRateBps };
  }
  if (
    (currentStep === 'VERIFYING' || currentStep === 'FINALIZING_REMOTE') &&
    verifyRateBps !== undefined
  ) {
    return { label: '回读', value: verifyRateBps };
  }
  if (uploadRateBps !== undefined) return { label: '上传', value: uploadRateBps };
  if (hashRateBps !== undefined) return { label: '哈希', value: hashRateBps };
  if (verifyRateBps !== undefined) return { label: '回读', value: verifyRateBps };
  return null;
}

/**
 * What a rate cell says once its sample is too old to repeat.
 *
 * Distinct from 「未报告」 and from a figure. 「未报告」 means this API build does not
 * measure the leg; a figure means "this is the throughput now". A worker that died
 * mid-upload leaves its last sample in the row, and repeating it hours later would
 * report 30 MiB/s for a transfer that stopped — the one reading that makes an
 * operator walk away from a stalled job believing it is fine.
 */
export const RATE_SAMPLE_STALE = '样本已过期';

/**
 * How long a rate sample is allowed to stand.
 *
 * The API samples every second while bytes move, and this page re-reads the
 * snapshot on every `job.updated` — or every 5 s when the event stream is down.
 * Fifteen seconds is three missed polls: long enough that a slow refetch or a
 * coalesced burst of events never blanks a healthy transfer, short enough that a
 * dead worker stops being quoted well inside the time an operator would take to
 * notice by eye.
 */
export const RATE_SAMPLE_MAX_AGE_MS = 15_000;

/**
 * Whether the rates in this snapshot are too old to be repeated as current.
 *
 * `false` when the server sent no `ratesSampledAt` at all, and that is deliberate:
 * an API build that reports rates without a sample time gives no basis for ageing
 * them, and inventing one would blank figures that may well be live. Absence of
 * evidence is not staleness — it is the older wire format.
 */
export function ratesAreStale(snapshot: OffloadSnapshot, now: number): boolean {
  const sampledAt = snapshot.ratesSampledAt;
  if (sampledAt === undefined) return false;
  return now - sampledAt > RATE_SAMPLE_MAX_AGE_MS;
}

/**
 * `true` when the snapshot carries at least one telemetry field.
 *
 * Gates the whole section. An API build reporting none of these shows the
 * timeline it always showed, rather than a block of 「未报告」 rows that reads as a
 * malfunction — a uniform absence is worth stating once, not eight times.
 */
export function hasTransferTelemetry(snapshot: OffloadSnapshot): boolean {
  return (
    snapshot.stepBytesTotal !== undefined ||
    snapshot.totalBytes !== undefined ||
    snapshot.verifiedBytes !== undefined ||
    snapshot.uploadRateBps !== undefined ||
    snapshot.hashRateBps !== undefined ||
    snapshot.verifyRateBps !== undefined ||
    snapshot.etaSeconds !== undefined
  );
}

/**
 * A labelled meter that may have no percentage at all.
 *
 * Renders nothing when either figure is absent: a meter drawn for bytes the
 * server never sent is a claim that the transfer has made no progress. An empty
 * track with a stated total is fine — that is a real "size known, nothing moved
 * yet" — but an invented one is not.
 */
function ProgressMeter({
  label,
  done,
  total,
}: {
  label: string;
  done: string | undefined;
  total: string | undefined;
}) {
  if (done === undefined || total === undefined) return null;

  const percent = percentOfDecimal(done, total);
  const figure = `${formatDecimalBytes(done)} / ${formatDecimalBytes(total)}`;

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
 * One measured rate, or an explicit statement about why there is no figure.
 *
 * Three outcomes, not two: a rate, 「未报告」 for a leg this build does not measure,
 * and 「样本已过期」 for a figure whose sample has aged out. The third used to be
 * drawn as the first, which is how a dead worker's last sample kept being
 * presented as the current throughput.
 */
function RateCell({
  label,
  value,
  stale,
  icon: Icon,
}: {
  label: string;
  value: string | undefined;
  stale: boolean;
  icon: typeof Download;
}) {
  const reported = value !== undefined;
  const withheld = !reported || stale;
  return (
    <div className="import-rate" data-reported={reported} data-stale={reported && stale}>
      <dt>
        <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
        {label}
      </dt>
      <dd className={withheld ? 'is-unknown' : undefined}>
        {!reported ? NOT_REPORTED : stale ? RATE_SAMPLE_STALE : formatOptionalRate(value)}
      </dd>
    </div>
  );
}

/**
 * The step's byte figure, for a table cell.
 *
 * In the row and not only in the timeline, because the question 「现在传到哪了」
 * is asked of the list — needing to open a panel per transfer to see whether one
 * is moving is what makes an operator watch the wrong one. Absent renders as
 * 「未报告」 rather than a bar at zero, for the same reason it does everywhere else.
 */
export function TransferBytesCell({ snapshot }: { snapshot: OffloadSnapshot }) {
  const { stepBytesDone, stepBytesTotal } = snapshot;
  if (stepBytesDone === undefined || stepBytesTotal === undefined) {
    return <span className="is-unknown">{NOT_REPORTED}</span>;
  }
  const percent = percentOfDecimal(stepBytesDone, stepBytesTotal);
  return (
    <span className="transfer-bytes-cell">
      {/*
        The figure in its own element rather than as bare text beside the percent.
        Two sibling text nodes in one span read as a single run of text to anything
        matching on content — a test, a screen reader picking a phrase, a
        translation pass — so 「3 GiB / 5 GiB」 and 「60.0%」 ran together.
      */}
      <span className="transfer-bytes-figure">
        {formatDecimalBytes(stepBytesDone)} / {formatDecimalBytes(stepBytesTotal)}
      </span>
      <small className="transfer-bytes-percent">{formatPercent(percent)}</small>
    </span>
  );
}

/**
 * The one rate that belongs in a row, chosen by which leg the step is in.
 *
 * Chosen by step rather than by which field happens to be present: a leftover
 * sample from a finished leg would otherwise win over the leg actually running,
 * and the row would report hashing throughput for an upload. The step-to-field
 * map is shared with the meter label so the two cannot disagree about which
 * field `FINALIZING_REMOTE` is measured in.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so a test can age
 * a sample without faking the clock globally.
 */
export function TransferRateCell({
  snapshot,
  now = Date.now(),
}: {
  snapshot: OffloadSnapshot;
  now?: number;
}) {
  const field = STEP_RATE_FIELD[snapshot.currentStep];
  const value = field === undefined ? undefined : snapshot[field];
  if (value === undefined) return <span className="is-unknown">{NOT_REPORTED}</span>;
  // An aged-out sample is withheld rather than repeated: the row is where an
  // operator decides which transfer to look at, and a dead worker's last figure
  // is the one reading that sends them to the wrong one.
  if (ratesAreStale(snapshot, now)) {
    return <span className="is-unknown">{RATE_SAMPLE_STALE}</span>;
  }
  return <>{formatOptionalRate(value)}</>;
}

/**
 * The remaining-time text, withheld on the same evidence as the rates.
 *
 * Shared by the list row and the detail panel so the two cannot drift apart on
 * this decision again — the row previously aged its rate while the panel kept
 * quoting an ETA derived from that same withheld rate.
 *
 * Why the ETA ages at all: the server derives `etaSeconds` from remaining bytes
 * over the throughput it sampled at `ratesSampledAt`. Once that sample is too old
 * to quote as current, an ETA extrapolated from it is not just late by the age of
 * the sample — it assumes a rate that may have been zero the whole time. 「还剩 50
 * 分」 on a transfer whose worker died is precisely the reading that makes an
 * operator wait instead of investigate.
 *
 * An absent `ratesSampledAt` keeps the figure, matching `ratesAreStale`: with no
 * sample time there is no basis for ageing, and blanking it would hide a live ETA
 * on every API build older than schema-v20 rather than a dead one.
 */
export function transferEtaText(snapshot: OffloadSnapshot, now: number): string {
  if (snapshot.etaSeconds === undefined) return NOT_REPORTED;
  if (ratesAreStale(snapshot, now)) return RATE_SAMPLE_STALE;
  return formatEta(snapshot.etaSeconds);
}

/** The list-row ETA cell. Mirrors `TransferRateCell`, and ages with it. */
export function TransferEtaCell({
  snapshot,
  now = Date.now(),
}: {
  snapshot: OffloadSnapshot;
  now?: number;
}) {
  const text = transferEtaText(snapshot, now);
  if (text === NOT_REPORTED || text === RATE_SAMPLE_STALE) {
    return <span className="is-unknown">{text}</span>;
  }
  return <>{text}</>;
}

export function TransferProgress({
  snapshot,
  now = Date.now(),
}: {
  snapshot: OffloadSnapshot;
  now?: number;
}) {
  const legLabel = LEG_LABELS[snapshot.currentStep];
  const stale = ratesAreStale(snapshot, now);
  const waiting = resourceWaitText(snapshot) !== null;
  const waitingAction =
    snapshot.currentStep === 'UPLOADING_STAGING'
      ? '上传'
      : snapshot.currentStep === 'HASHING'
        ? '哈希校验'
        : snapshot.currentStep === 'VERIFYING' || snapshot.currentStep === 'FINALIZING_REMOTE'
          ? '解密回读'
          : '当前阶段的数据动作';

  return (
    <div className="import-progress transfer-progress">
      <ResourceWaitStatus snapshot={snapshot} />
      {/*
       * The leg in flight first, because on a running transfer it is the only
       * line that changes. The verified meter below is the one cleanup gates on,
       * so it stays drawn after the active leg is over.
       */}
      {legLabel === undefined ? null : (
        <ProgressMeter
          label={legLabel}
          done={snapshot.stepBytesDone}
          total={snapshot.stepBytesTotal}
        />
      )}
      <ProgressMeter
        label="已验证字节（决定能否删本地）"
        done={snapshot.verifiedBytes}
        total={snapshot.totalBytes}
      />

      {snapshot.currentFileAlias === undefined ? null : (
        <p className="import-current-object">
          当前文件 <code>{snapshot.currentFileAlias}</code>
          {snapshot.filesDone !== undefined && snapshot.fileCount !== undefined ? (
            <span className="transfer-file-counter">
              {' '}
              第 {snapshot.filesDone + 1} / {snapshot.fileCount} 个
            </span>
          ) : null}
        </p>
      )}

      <dl className="import-rate-grid" role="group" aria-label="分段速率">
        <RateCell label="哈希校验" value={snapshot.hashRateBps} stale={stale} icon={Gauge} />
        <RateCell
          label="OneDrive 上传"
          value={snapshot.uploadRateBps}
          stale={stale}
          icon={Upload}
        />
        <RateCell label="回读校验" value={snapshot.verifyRateBps} stale={stale} icon={Download} />
        {/*
          The ETA ages with the rates, because it is computed from them: the
          server divides remaining bytes by the throughput it sampled at
          `ratesSampledAt`. Keeping it after that sample aged out would go on
          making exactly the claim the withheld rate stopped making.
        */}
        <div
          className="import-rate"
          data-reported={snapshot.etaSeconds !== undefined}
          data-stale={snapshot.etaSeconds !== undefined && stale}
        >
          <dt>
            <Timer size={13} strokeWidth={1.9} aria-hidden="true" />
            预计剩余
          </dt>
          <dd className={snapshot.etaSeconds === undefined || stale ? 'is-unknown' : undefined}>
            {transferEtaText(snapshot, now)}
          </dd>
        </div>
      </dl>

      {/*
       * Said once, here, rather than repeated as 「未报告」 in every cell. A rate
       * the server measured as zero and a rate it never measured are different
       * facts, and only the second one is about the deployment.
       */}
      {waiting ? (
        <p className="field-hint">
          当前没有执行{waitingAction}；请以资源等待为准。上面的速率与预计剩余只保留为历史样本，
          不代表当前正在传输。
        </p>
      ) : snapshot.uploadRateBps === undefined &&
        snapshot.hashRateBps === undefined &&
        snapshot.verifyRateBps === undefined ? (
        <p className="field-hint">
          这台机器上的 API 版本还没有上报实时速率。上面的{NOT_REPORTED}
          不代表传输停了——阶段和字节数仍然是真实的。
        </p>
      ) : stale ? (
        /*
         * The other honest absence, and a different sentence: figures existed and
         * have aged out. Says when the last sample was taken rather than only that
         * it is old, because 「40 秒前」 and 「3 小时前」 are the difference between a
         * slow poll and a worker that is gone.
         */
        <p className="field-hint">
          速率样本停在 {new Date(snapshot.ratesSampledAt ?? now).toLocaleString()}
          ，已超过 {Math.round(RATE_SAMPLE_MAX_AGE_MS / 1000)} 秒未更新，因此不再当作当前速度显示。
          字节数与阶段仍是数据库里最后写入的真实值；如果一直不动，请检查处理该任务的 worker。
        </p>
      ) : null}
    </div>
  );
}
