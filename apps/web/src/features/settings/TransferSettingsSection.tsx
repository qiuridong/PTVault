import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpFromLine, CircleDashed, Lock, Save, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  OffloadTransferLimitsSchema,
  type OffloadTransferLimits,
  type TransferResourceStats,
  type TransferSettingsStatus,
} from '@ptvault/contracts';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { isDemoSessionActive } from '../../demo/demoSession.js';
import {
  getTransferSettings,
  transferSettingsQueryKey,
  updateTransferSettings,
} from './settingsApi.js';

type ProvisionReason = TransferSettingsStatus['offload']['provisionReason'];
type ResourceKey = keyof TransferSettingsStatus['offload']['activity']['resources'];
type StageResourceKey = Exclude<ResourceKey, 'remoteHeavy'>;
type OffloadNumericField = Exclude<keyof OffloadTransferLimits, 'creationEnabled'>;

/**
 * Why the runtime cannot take work, in the operator's words.
 *
 * Four sentences rather than one 「尚未启用」, because the next move differs for
 * each: a SHADOW box needs a different deployment, an unconfigured runtime needs
 * credentials on the host, and a disabled parallel runtime is a flag on the
 * service. Collapsing them would send someone to edit the wrong thing.
 */
const PROVISION_LABELS: Record<ProvisionReason, string> = {
  READY: '运行时可用',
  MODE_NOT_ACTIVE: '这台机器不在 ACTIVE 模式，迁移路由根本没有注册',
  RUNTIME_NOT_CONFIGURED: '服务端缺少必要的凭据、路径或 rclone 配置',
  PARALLEL_RUNTIME_DISABLED: '并行运行时关闭；串行迁移仍可用，实际容量为 1',
};

/** The compatibility state still has the established serial qB runtime. */
function offloadRuntimeAvailable(reason: ProvisionReason): boolean {
  return reason === 'READY' || reason === 'PARALLEL_RUNTIME_DISABLED';
}

/**
 * The eight qB/VPS knobs, with the range the contract enforces and the value
 * this deployment was tuned around.
 *
 * A table rather than eight hand-written blocks: the bounds have to match
 * `OffloadTransferLimitsSchema` exactly or the form offers a value the server
 * will reject, and one list is far easier to check against the contract than
 * eight scattered `min=`/`max=` attributes. `resource` links a knob to the live
 * semaphore it resizes, so the reading sits next to the number that set it.
 */
const OFFLOAD_FIELDS: readonly {
  key: OffloadNumericField;
  label: string;
  min: number;
  max: number;
  recommended: number;
  hint: string;
  resource?: ResourceKey;
}[] = [
  {
    key: 'maxInFlight',
    label: '最大在制任务',
    min: 2,
    max: 32,
    recommended: 8,
    hint: '同时处于迁移流程中的任务上限，包含预检、暂停、哈希、上传与回读各阶段。',
  },
  {
    key: 'preflightConcurrency',
    label: '预检并发',
    min: 1,
    max: 32,
    recommended: 8,
    hint: '同时做路径与容量预检的任务数。预检只读，不动种子。',
    resource: 'preflight',
  },
  {
    key: 'pauseSnapshotConcurrency',
    label: '暂停与快照并发',
    min: 1,
    max: 8,
    recommended: 2,
    hint: '同时向 qB 请求暂停并记录快照的任务数。不得大于「已暂停流水线数量」。',
    resource: 'pauseSnapshot',
  },
  {
    key: 'maxPausedPipelines',
    label: '已暂停流水线数量',
    min: 1,
    max: 31,
    recommended: 3,
    hint: '允许多少个种子已经在 qB 里暂停、并进入后续迁移流水线。这个数字直接决定同时停止做种的数量，必须小于「最大在制任务」。',
  },
  {
    key: 'hashConcurrency',
    label: '哈希校验并发',
    min: 1,
    max: 8,
    recommended: 1,
    hint: '哈希是本地磁盘重负载。盲目提高会让所有任务一起变慢，通常保持 1。',
    resource: 'hash',
  },
  {
    key: 'uploadConcurrency',
    label: '同时上传数',
    min: 1,
    max: 4,
    recommended: 2,
    hint: '这是上传槽位的条件上限，不等于任何时刻都能跑满。上传与解密回读共享远端重负载容量；上传上限 2、回读上限 1 时总容量是 2，有 1 条回读时最多 1 条实际上传。',
    resource: 'upload',
  },
  {
    key: 'readbackConcurrency',
    label: '解密回读并发',
    min: 1,
    max: 2,
    recommended: 1,
    hint: '回读同样占用远端带宽与本地 I/O，一般保持 1。',
    resource: 'readback',
  },
];

const RESOURCE_LABELS: Record<StageResourceKey, string> = {
  preflight: '预检',
  pauseSnapshot: '暂停与快照',
  hash: '哈希校验',
  upload: '上传',
  readback: '解密回读',
};

/** Text of the numeric inputs, so a half-typed field is not silently `NaN`. */
type OffloadDraft = { creationEnabled: boolean } & Record<OffloadNumericField, string>;
type TransferSettingsBase = { revision: number; offload: OffloadTransferLimits };

function toOffloadDraft(limits: OffloadTransferLimits): OffloadDraft {
  return {
    creationEnabled: limits.creationEnabled,
    maxInFlight: String(limits.maxInFlight),
    preflightConcurrency: String(limits.preflightConcurrency),
    pauseSnapshotConcurrency: String(limits.pauseSnapshotConcurrency),
    maxPausedPipelines: String(limits.maxPausedPipelines),
    hashConcurrency: String(limits.hashConcurrency),
    uploadConcurrency: String(limits.uploadConcurrency),
    readbackConcurrency: String(limits.readbackConcurrency),
  };
}

/** A strict integer, or `null` — an empty or half-typed box is not a zero. */
function integerOrNull(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw.trim())) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numberOutside(raw: string, min: number, max: number): boolean {
  const value = integerOrNull(raw);
  return value === null || value < min || value > max;
}

/**
 * The draft as a full profile, or `null` if any box is not yet a number.
 *
 * Whole-profile rather than per-field, because the server merges the delta into
 * the stored row and then validates the *result*: `pauseSnapshotConcurrency <=
 * maxPausedPipelines` cannot be judged from either box alone.
 */
function toOffloadLimits(draft: OffloadDraft): OffloadTransferLimits | null {
  const numbers = OFFLOAD_FIELDS.map(
    (field) => [field.key, integerOrNull(draft[field.key])] as const,
  );
  if (numbers.some(([, value]) => value === null)) return null;
  return {
    creationEnabled: draft.creationEnabled,
    ...(Object.fromEntries(numbers) as Record<OffloadNumericField, number>),
  };
}

/**
 * Every reason this draft would be refused, named so the operator knows which
 * box to change.
 *
 * The cross-field rules are spelled out for the message, and then the contract
 * schema is asked as the final gate. Both halves are needed: the schema alone
 * cannot say *which* pair conflicts, and the hand-written list alone would drift
 * the moment the contract gains a rule — in which case the generic sentence
 * fires and the save is still blocked rather than bounced by the server.
 */
function offloadProblems(draft: OffloadDraft): string[] {
  const problems: string[] = [];
  for (const field of OFFLOAD_FIELDS) {
    const value = integerOrNull(draft[field.key]);
    if (value === null || value < field.min || value > field.max) {
      problems.push(`「${field.label}」要填 ${field.min}–${field.max} 之间的整数。`);
    }
  }
  const limits = toOffloadLimits(draft);
  if (limits === null) return problems;

  if (limits.maxPausedPipelines >= limits.maxInFlight) {
    problems.push('「已暂停流水线数量」必须小于「最大在制任务」。');
  }
  if (limits.pauseSnapshotConcurrency > limits.maxPausedPipelines) {
    problems.push('「暂停与快照并发」不能大于「已暂停流水线数量」。');
  }
  for (const field of OFFLOAD_FIELDS) {
    if (field.key === 'maxInFlight' || field.key === 'maxPausedPipelines') continue;
    if (limits[field.key] > limits.maxInFlight) {
      problems.push(`「${field.label}」不能大于「最大在制任务」。`);
    }
  }

  if (problems.length === 0 && !OffloadTransferLimitsSchema.safeParse(limits).success) {
    problems.push('这组并发参数不是服务端接受的组合，请调整后再保存。');
  }
  return problems;
}

/** Fields implicated by the same local rules, for per-control a11y state. */
function invalidOffloadFields(draft: OffloadDraft): ReadonlySet<OffloadNumericField> {
  const invalid = new Set<OffloadNumericField>();
  for (const field of OFFLOAD_FIELDS) {
    if (numberOutside(draft[field.key], field.min, field.max)) invalid.add(field.key);
  }

  const limits = toOffloadLimits(draft);
  if (limits === null) return invalid;
  if (limits.maxPausedPipelines >= limits.maxInFlight) {
    invalid.add('maxPausedPipelines');
    invalid.add('maxInFlight');
  }
  if (limits.pauseSnapshotConcurrency > limits.maxPausedPipelines) {
    invalid.add('pauseSnapshotConcurrency');
    invalid.add('maxPausedPipelines');
  }
  for (const field of OFFLOAD_FIELDS) {
    if (field.key === 'maxInFlight' || field.key === 'maxPausedPipelines') continue;
    if (limits[field.key] > limits.maxInFlight) {
      invalid.add(field.key);
      invalid.add('maxInFlight');
    }
  }
  return invalid;
}

function changedOffload(
  draft: OffloadDraft,
  base: OffloadTransferLimits,
): Partial<OffloadTransferLimits> {
  const limits = toOffloadLimits(draft);
  if (limits === null) return {};
  return OFFLOAD_FIELDS.reduce<Partial<OffloadTransferLimits>>(
    (delta, field) =>
      limits[field.key] === base[field.key] ? delta : { ...delta, [field.key]: limits[field.key] },
    limits.creationEnabled === base.creationEnabled
      ? {}
      : { creationEnabled: limits.creationEnabled },
  );
}

/**
 * Whether the raw draft still represents the profile it was seeded from.
 *
 * This is deliberately separate from `changed*`: a malformed value cannot be
 * sent in a PATCH, but it is still an edit. Treating the resulting empty delta
 * as a clean form would show both a validation error and 「没有改动」 at once,
 * and could let a background refresh overwrite what the operator is typing.
 */
function offloadDraftMatches(draft: OffloadDraft, base: OffloadTransferLimits): boolean {
  return (
    draft.creationEnabled === base.creationEnabled &&
    OFFLOAD_FIELDS.every((field) => integerOrNull(draft[field.key]) === base[field.key])
  );
}

function errorSays(error: unknown, code: string): boolean {
  return error instanceof ApiError && (error.code === code || error.message.includes(code));
}

/**
 * The server's refusal, translated.
 *
 * Read off the message rather than the status alone, because 409 covers two
 * situations with opposite remedies: a revision conflict means reload and
 * re-decide, while an idempotency conflict means this key was already spent on a
 * different body and the save must be re-submitted fresh.
 *
 * Two spellings are matched per condition because the route has two paths to the
 * same refusal, and only one of them puts the code in `error`. A body that fails
 * `TransferSettingsPatchSchema` at the route boundary answers
 * `{error: 'Invalid transfer settings'}`, while the same rule failing inside the
 * service answers `{error: 'TRANSFER_SETTINGS_INVALID_PROFILE'}`. The safe error
 * parser retains a bounded machine code when present and the public message when
 * not, so both forms remain distinguishable without trusting an arbitrary body.
 * Matching one spelling only would print 「缺少幂等键」 for a rejected profile
 * and send the operator hunting the wrong thing.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return '保存结果尚未确认。请查看刷新后的服务端版本；如仍需保存，请输入新的验证码并保持同一组参数重试。';
  }
  const said = `${error.code ?? ''} ${error.message}`;
  if (said.includes('TRANSFER_SETTINGS_REVISION_CONFLICT')) {
    return '设置已被其他页面或会话修改，请重新载入后再保存。';
  }
  if (said.includes('TRANSFER_SETTINGS_IDEMPOTENCY_CONFLICT')) {
    return '这次保存的幂等键已经用在另一组参数上，请重新提交一次。';
  }
  if (said.includes('OFFLOAD_RUNTIME_NOT_PROVISIONED')) {
    return 'qB/VPS 迁移运行时尚未就绪，无法打开新建开关。';
  }
  if (said.includes('TRANSFER_SETTINGS_INVALID_PROFILE') || said.includes('Invalid transfer')) {
    return '这组并发参数不是服务端接受的组合，设置没有改动。';
  }
  if (said.includes('IDEMPOTENCY_KEY_REQUIRED') || said.includes('Idempotency-Key')) {
    return '这次请求缺少幂等键，服务器已拒绝；请重试。';
  }
  // The demo answers every write with this. It shares 403 with a failed step-up,
  // so it is matched by code first — telling a demo visitor their code was wrong
  // would send them to re-read an authenticator they never set up.
  if (said.includes('DEMO_READ_ONLY')) return '演示模式是只读的，不能保存设置。';
  if (error.status === 401) return '会话已过期，请重新登录。';
  if (/csrf/i.test(said)) return '请求校验令牌已失效，请重新提交；设置没有改动。';
  if (/step-up|mfa|totp/i.test(said)) {
    return '验证码不正确或已被使用，请用当前的新码重试。';
  }
  if (error.status === 403) return '服务器拒绝了这次保存；请确认当前账号权限后重试。';
  if (error.status === 409) return '设置已被其他会话修改，请重新载入后再保存。';
  if (error.status === 400) return '服务端拒绝了这次保存，设置没有改动。';
  if (error.status >= 500) {
    return '保存结果尚未确认。请查看刷新后的服务端版本；如仍需保存，请输入新的验证码并保持同一组参数重试。';
  }
  return error.message;
}

/** One semaphore reading, with data-plane execution kept separate from stage ownership. */
function ResourceMeter({
  label,
  stats,
  emphasis = false,
  kind = 'standard',
}: {
  label: string;
  stats: TransferResourceStats;
  emphasis?: boolean;
  kind?: 'standard' | 'dataPlane' | 'shared';
}) {
  const detail =
    kind === 'dataPlane'
      ? stats.executing === undefined
        ? `阶段占用 ${stats.active}，上限 ${stats.capacity}，等待 ${stats.pending} 个阶段槽位；旧版 API 未上报数据平面运行数`
        : `实际执行 ${stats.executing}，阶段占用 ${stats.active}，上限 ${stats.capacity}，等待 ${stats.pending} 个阶段槽位`
      : kind === 'shared'
        ? `共享实际占用 ${stats.active}，上限 ${stats.capacity}，等待 ${stats.pending}`
        : `正在使用 ${stats.active}，上限 ${stats.capacity}，等待 ${stats.pending}`;
  const figure =
    kind === 'dataPlane' && stats.executing !== undefined ? stats.executing : stats.active;
  return (
    <div className="transfer-resource" data-emphasis={emphasis}>
      <dt>{label}</dt>
      <dd>
        <span className="transfer-resource-figure">
          {figure} / {stats.capacity}
        </span>
        <small>{detail}</small>
      </dd>
    </div>
  );
}

/** One knob: label, bounds, the recommended value, and what it really controls. */
function NumberField({
  id,
  label,
  value,
  min,
  max,
  recommended,
  hint,
  configured,
  effective,
  invalid,
  problemsId,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min: number;
  max: number;
  recommended: number;
  hint: string;
  configured: number;
  effective: number;
  invalid: boolean;
  problemsId: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const draftValue = integerOrNull(value);
  const hintId = `${id}-hint`;
  return (
    <div className="field transfer-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        className="transfer-number"
        value={value}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-describedby={`${hintId}${invalid ? ` ${problemsId}` : ''}`}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <small id={hintId} className="field-hint">
        范围 {min}–{max}，推荐 {recommended}。{hint}
        {/*
          These are three different facts: the draft in this input, the profile
          last saved by the service, and the limit the runtime currently applies.
          Keeping their labels explicit prevents an unsaved keystroke from being
          presented as a saved setting.
        */}
        {configured !== effective ? (
          <>
            {' '}
            <strong>
              当前生效值是 {effective}，与服务端已保存的 {configured} 不同。
            </strong>
          </>
        ) : null}
        {draftValue !== null && draftValue !== configured ? (
          <>
            {' '}
            <strong>当前输入 {draftValue}，尚未保存。</strong>
          </>
        ) : null}
      </small>
    </div>
  );
}

/**
 * The creation gate for one track, stated as a new-job gate and nothing more.
 *
 * Deliberately never worded as a stop: closing it prevents new transfers being
 * planned, and leaves every existing job free to continue, pause, resume, cancel
 * and finish safely. 「全部暂停」 is the other control, on the transfers page.
 */
function CreationSwitch({
  id,
  label,
  checked,
  runtimeAvailable,
  savedEnabled,
  effectiveEnabled,
  reason,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  runtimeAvailable: boolean;
  savedEnabled: boolean;
  effectiveEnabled: boolean;
  reason: ProvisionReason;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  // Unprovisioned *and* currently off is the one combination that must not look
  // enableable — the server refuses it (`..._RUNTIME_NOT_PROVISIONED`). When the
  // saved value is on, the box stays operable so it can be turned off, which is
  // a legitimate thing to want on a box whose runtime is not ready.
  const lockedOff = !runtimeAvailable && !savedEnabled;
  return (
    <div className="transfer-gate">
      <label className="instance-form-checkbox" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled || lockedOff}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {lockedOff ? (
        <p className="inline-message" role="note">
          <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            运行时未就绪，这个开关现在无法打开：{PROVISION_LABELS[reason]}。
            这里不能替服务端补配置——路径、凭据与 rclone remote 都要在宿主机上设置。
          </span>
        </p>
      ) : null}
      {/*
        The saved intent and the running reality disagreeing is its own sentence.
        Drawing a checked box with no note would claim new transfers can be
        created, when in fact none can.
      */}
      {savedEnabled && !effectiveEnabled ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            配置希望启用，但<strong>运行时未就绪，此刻创建不了新任务</strong>：
            {PROVISION_LABELS[reason]}。
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * qB/VPS transfer scheduling: this track's creation gate and concurrency, read
 * from the service and written back with a revision and a code.
 *
 * One track, not two. The netdisk half used to sit in this same card, which made
 * it read as two more knobs on the qB scheduler; it now has `/settings/netdisk`,
 * its own runtime status and its own safety gates. The two still share one
 * durable record, so each page sends only its own half of the patch rather than
 * re-asserting numbers its operator never looked at.
 *
 * Everything on screen is read from `GET /api/settings/transfers`; nothing here
 * carries a default of its own, so a failed read says so instead of drawing
 * zeroes that look like 「全部关闭」.
 */
export function TransferSettingsSection() {
  const fieldId = useId();
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: transferSettingsQueryKey,
    queryFn: getTransferSettings,
    // Activity is telemetry, not a static preference. The app-wide client
    // intentionally disables focus refetches, so this section owns a small poll
    // instead of leaving 「当前占用」 frozen for the lifetime of the page.
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const status = settings.data?.supported === true ? settings.data.data : undefined;

  const [offload, setOffload] = useState<OffloadDraft | null>(null);
  const [base, setBase] = useState<TransferSettingsBase | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [saved, setSaved] = useState(false);
  const demoReadOnly = isDemoSessionActive();

  /*
   * One key per intent, minted at the first attempt and reused until the body
   * changes.
   *
   * That reuse is the whole point of the receipt: a save whose answer was lost
   * to a dropped connection can be re-sent and will replay rather than book a
   * second revision bump. The key is dropped whenever the draft changes, because
   * the server fingerprints the body — sending a different profile under a spent
   * key is the 409 this avoids.
   */
  const idempotencyKey = useRef<string | null>(null);

  const dirty = useMemo(() => {
    if (base === null || offload === null) return false;
    return !offloadDraftMatches(offload, base.offload);
  }, [base, offload]);

  const baseRevision = base?.revision ?? null;

  const reseed = (next: TransferSettingsStatus): void => {
    setOffload(toOffloadDraft(next.offload.configured));
    setBase({ revision: next.revision, offload: { ...next.offload.configured } });
    idempotencyKey.current = null;
  };

  /*
   * Seed once, and re-seed on a new revision only while the form is clean.
   *
   * A background refetch landing on a half-edited form would replace the
   * operator's numbers mid-sentence, and the version they were editing is
   * exactly what the revision check exists to protect. So an unedited form
   * follows the server, and an edited one holds still and says a newer version
   * exists.
   */
  useEffect(() => {
    if (status === undefined) return;
    if (baseRevision === null) {
      reseed(status);
      return;
    }
    if (status.revision !== baseRevision && !dirty) {
      setSaved(false);
      reseed(status);
    }
  }, [status, baseRevision, dirty]);

  const save = useMutation({
    mutationFn: async () => {
      if (status === undefined || offload === null || base === null) {
        throw new Error('TRANSFER_SETTINGS_NOT_LOADED');
      }
      if (idempotencyKey.current === null) idempotencyKey.current = newIdempotencyKey();
      return updateTransferSettings({
        idempotencyKey: idempotencyKey.current,
        // Only this track's delta. The netdisk half of the same record is edited
        // on its own page, and re-asserting it from here would let a qB save
        // restore netdisk numbers the operator never looked at.
        patch: { revision: base.revision, mfaCode, offload: changedOffload(offload, base.offload) },
      });
    },
    onSuccess: (next) => {
      // The answer is the full status, so the cache is seeded from it rather than
      // waiting a round trip — then reconciled, since the applied capacities the
      // response projects are the scheduler's future admission, not its present.
      queryClient.setQueryData(transferSettingsQueryKey, { supported: true, data: next });
      idempotencyKey.current = null;
      setMfaCode('');
      setSaved(true);
      reseed(next);
      // The PATCH already returned a complete status. Telemetry reconciliation
      // happens in the background so a slow/offline GET cannot leave an already
      // successful mutation looking pending and keep the form locked.
      void queryClient.invalidateQueries({ queryKey: transferSettingsQueryKey });
    },
    onError: (error) => {
      // A step-up code is one-time input even when the server refuses the save.
      // Keeping it in the form invites an immediate retry with a code that may
      // already have been consumed before a response was lost.
      setMfaCode('');
      // A generic transport/server failure keeps the durable receipt so the same
      // intent can replay safely. This particular 409 says the receipt belongs
      // to another fingerprint, so retrying it can only produce the same 409.
      if (errorSays(error, 'TRANSFER_SETTINGS_IDEMPOTENCY_CONFLICT')) {
        idempotencyKey.current = null;
      }
      // Pull the competing revision into the cache while preserving this draft.
      // That turns the stateless 409 into the normal actionable stale state with
      // an explicit reload button.
      if (
        errorSays(error, 'TRANSFER_SETTINGS_REVISION_CONFLICT') ||
        !(error instanceof ApiError) ||
        error.status >= 500
      ) {
        // Surface the mutation error immediately. A connectivity failure often
        // affects this follow-up GET too; awaiting its retry budget here would
        // leave every control disabled behind 「正在保存」.
        void queryClient.invalidateQueries({ queryKey: transferSettingsQueryKey });
      }
    },
  });

  const editDraft = (mutate: () => void): void => {
    // A new body needs a new receipt, and any previous outcome no longer
    // describes what is on screen.
    idempotencyKey.current = null;
    setSaved(false);
    if (save.isError) save.reset();
    mutate();
  };

  if (settings.isPending) {
    return <p className="settings-loading">正在读取迁移调度设置…</p>;
  }
  if (settings.data?.supported === false) {
    return (
      <p className="inline-message" role="note">
        <CircleDashed size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          这台机器上的 API 版本还没有迁移调度设置接口，所以这里读不到。
          <strong>这不表示迁移已全部关闭</strong>——当前的开关与并发只能在宿主机的服务配置里看。
        </span>
      </p>
    );
  }
  if (status === undefined) {
    return (
      <p className="inline-message error-message" role="alert">
        <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
        <span className="note-text">
          读不到迁移调度设置。
          <strong>别把这当成「都已关闭」或「都已启用」</strong>——这里没有读数。
        </span>
      </p>
    );
  }
  if (offload === null || baseRevision === null) {
    return <p className="settings-loading">正在读取迁移调度设置…</p>;
  }

  const problems = offloadProblems(offload);
  const invalidOffload = invalidOffloadFields(offload);
  const staleRevision = status.revision !== baseRevision;
  const codeReady = /^[0-9]{6}$/.test(mfaCode);
  const canSave =
    !demoReadOnly &&
    dirty &&
    problems.length === 0 &&
    codeReady &&
    !save.isPending &&
    !staleRevision;
  const resources = status.offload.activity.resources;
  const offloadAvailable = offloadRuntimeAvailable(status.offload.provisionReason);
  const problemsId = `${fieldId}-problems`;

  return (
    <div className="transfer-settings">
      <p className="field-hint">
        这一栏只控制 <strong>qB/VPS 种子迁移</strong>
        ；网盘迁移有自己的运行时与安全门，设置在上一层的「网盘迁移」分区里进入独立页面。
        改并发只影响
        <strong>之后放行的任务</strong>——调低不会强杀、暂停或破坏正在运行的任务，
        已在跑的先跑完，之后才按新上限放行；调高则让排队的任务陆续拿到槽位。 「允许创建」与
        <strong>「全部暂停」是两件事</strong>，后者在迁移页。
        保存设置不会自动部署、重启服务，也不会改动 qB、Nginx 或防火墙。
      </p>

      {demoReadOnly ? (
        <p className="inline-message" role="note">
          <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            <strong>演示模式只读。</strong>
            以下设置与占用都是本地样本，只用于查看界面；控件已锁定，不会发送到真实服务器。
          </span>
        </p>
      ) : null}

      {settings.isError ? (
        <p className="inline-message error-message" role="alert">
          <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="note-text">
            刷新迁移调度设置失败；下面保留的是最后一次成功读到的设置和占用，
            <strong>当前读数可能已经过期。</strong>
          </span>
        </p>
      ) : null}

      {/* ---- qB/VPS ---------------------------------------------------- */}
      <div className="settings-card">
        <h3>
          <ArrowUpFromLine size={15} strokeWidth={1.9} aria-hidden="true" /> qB/VPS 种子迁移
        </h3>
        <p className="field-hint">
          运行时状态：<strong>{PROVISION_LABELS[status.offload.provisionReason]}</strong>
        </p>

        <CreationSwitch
          id={`${fieldId}-offload-gate`}
          label="允许创建新的 qB/VPS 迁移"
          checked={offload.creationEnabled}
          runtimeAvailable={
            status.offload.provisioned || offloadRuntimeAvailable(status.offload.provisionReason)
          }
          savedEnabled={status.offload.configured.creationEnabled}
          effectiveEnabled={status.offload.effective.creationEnabled}
          reason={status.offload.provisionReason}
          disabled={save.isPending || demoReadOnly}
          onChange={(next) => editDraft(() => setOffload({ ...offload, creationEnabled: next }))}
        />
        <p className="field-hint">
          这只是<strong>新建门</strong>。关闭后已有任务仍可继续、暂停、恢复、取消和安全收尾，
          不会停止当前正在进行的上传。
        </p>

        <div className="transfer-grid">
          {OFFLOAD_FIELDS.map((field) => (
            <NumberField
              key={field.key}
              id={`${fieldId}-${field.key}`}
              label={field.label}
              value={offload[field.key]}
              min={field.min}
              max={field.max}
              recommended={field.recommended}
              hint={field.hint}
              configured={status.offload.configured[field.key]}
              effective={status.offload.effective[field.key]}
              invalid={invalidOffload.has(field.key)}
              problemsId={problemsId}
              disabled={save.isPending || demoReadOnly}
              onChange={(next) => editDraft(() => setOffload({ ...offload, [field.key]: next }))}
            />
          ))}
        </div>

        <h4 className="transfer-subhead">当前占用</h4>
        {offloadAvailable ? (
          <>
            <dl className="transfer-resources">
              <div className="transfer-resource">
                <dt>迁移处理器</dt>
                <dd>
                  <span className="transfer-resource-figure">
                    {status.offload.activity.activeHandlers}
                  </span>
                  <small>进程内正在运行的迁移处理器</small>
                </dd>
              </div>
              {(Object.keys(RESOURCE_LABELS) as StageResourceKey[]).map((key) => (
                <ResourceMeter
                  key={key}
                  label={RESOURCE_LABELS[key]}
                  stats={resources[key]}
                  emphasis={key === 'upload'}
                  kind={key === 'upload' || key === 'readback' ? 'dataPlane' : 'standard'}
                />
              ))}
              {resources.remoteHeavy === undefined ? null : (
                <ResourceMeter
                  label="上传/回读共享容量"
                  stats={resources.remoteHeavy}
                  emphasis
                  kind="shared"
                />
              )}
            </dl>
            <p className="field-hint">
              <strong>
                上传上限 {status.offload.effective.uploadConcurrency}{' '}
                是条件上限，不是上传上限再加回读。
              </strong>
              上传与解密回读会共同占用
              {resources.remoteHeavy === undefined
                ? '同一个远端重负载预算；旧版 API 没有上报这个共享总容量。'
                : `上面的共享容量 ${resources.remoteHeavy.capacity}；有回读占用时，可实际上传的数量会相应减少。`}
              「阶段占用」可能还在等待共享容量，只有新版 API
              上报的「实际执行」才代表数据平面正在运行。
            </p>
          </>
        ) : (
          <p className="inline-message" role="note">
            <CircleDashed size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">
              运行时未就绪，所以这里<strong>没有占用读数</strong>；不要把它读成「占用为 0」。
            </span>
          </p>
        )}
      </div>

      {/* ---- Save ------------------------------------------------------ */}
      <div className="settings-card transfer-save">
        <h3>保存改动</h3>
        <p className="field-hint">
          服务端版本号 <strong>{status.revision}</strong>，正在编辑的是{' '}
          <strong>{baseRevision}</strong>。保存会带上这个版本号，
          如果期间有人改过设置，服务端会拒绝而不是覆盖。
        </p>

        {staleRevision ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">
              设置已被其他页面或会话修改（服务端已到 {status.revision}），请重新载入后再保存。
              <strong>这里不会静默覆盖对方的改动。</strong>
            </span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                save.reset();
                setSaved(false);
                setMfaCode('');
                reseed(status);
              }}
            >
              重新载入
            </button>
          </p>
        ) : null}

        {problems.length > 0 ? (
          <div id={problemsId} className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <div className="note-text">
              <p>这组参数还不能保存：</p>
              <ul className="transfer-problems">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {save.isError &&
        !(staleRevision && errorSays(save.error, 'TRANSFER_SETTINGS_REVISION_CONFLICT')) ? (
          <p className="inline-message error-message" role="alert">
            <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">{errorMessage(save.error)}</span>
          </p>
        ) : null}

        {saved ? (
          <p className="inline-message" role="status">
            <Save size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="note-text">
              已保存，服务端版本号现在是 {status.revision}。新上限只对之后放行的任务生效。
            </span>
          </p>
        ) : null}

        <div className="field">
          <label htmlFor={`${fieldId}-code`}>两步验证码</label>
          <input
            id={`${fieldId}-code`}
            type="text"
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="one-time-code"
            placeholder="000000"
            aria-describedby={`${fieldId}-code-hint`}
            aria-invalid={mfaCode.length > 0 && !codeReady ? true : undefined}
            disabled={save.isPending || demoReadOnly}
          />
          <small id={`${fieldId}-code-hint`} className="field-hint">
            改并发会改变真实的上传行为，所以要一个当前的 6 位验证码。 它不会被保留，请求结束就清空。
          </small>
        </div>

        <div className="instance-form-actions">
          <button
            type="button"
            className="primary-action"
            onClick={() => save.mutate()}
            disabled={!canSave}
          >
            <Save size={15} strokeWidth={1.8} aria-hidden="true" />
            {save.isPending ? '正在保存……' : '保存迁移调度设置'}
          </button>
        </div>
        {dirty ? null : <p className="field-hint">还没有改动，没有需要保存的内容。</p>}
      </div>
    </div>
  );
}
