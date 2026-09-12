import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  NetdiskSettingsValuesSchema,
  type NetdiskSettingsStatus,
  type NetdiskSettingsValues,
  type PublicationPolicy,
} from '@ptvault/contracts';

import { ApiError, newIdempotencyKey } from '../../api/client.js';
import { isDemoSessionActive } from '../../demo/demoSession.js';
import {
  getNetdiskSettings,
  netdiskSettingsQueryKey,
  updateNetdiskSettings,
} from './netdiskSettingsApi.js';

export const NETDISK_MAX_IN_FLIGHT_MIN = 1;
export const NETDISK_MAX_IN_FLIGHT_MAX = 8;
export const NETDISK_LOCAL_PREPARATION_MAX = 4;
export const NETDISK_UPLOAD_MAX = 4;
export const NETDISK_DELETE_GRACE_MAX_SECONDS = 30 * 24 * 60 * 60;

/** Text fields stay textual until save so a half-typed value never becomes NaN. */
export type NetdiskDraft = {
  creationEnabled: boolean;
  maxInFlight: string;
  localPreparationConcurrency: string;
  uploadConcurrency: string;
  spoolMaxBytes: string;
  spoolReserveBytes: string;
  defaultSourceConnectionId: string;
  defaultDestinationAccountId: string;
  defaultPublicationPolicy: PublicationPolicy;
  sourceStagingCleanupEnabled: boolean;
  sourceDeleteEnabled: boolean;
  sourceDeleteGraceSeconds: string;
};

export type NetdiskUnavailable =
  | { kind: 'ROUTE_ABSENT' }
  | { kind: 'NOT_ENABLED'; status: number }
  | { kind: 'UNAUTHENTICATED' }
  | { kind: 'READ_FAILED' };

function toDraft(values: NetdiskSettingsValues): NetdiskDraft {
  return {
    creationEnabled: values.creationEnabled,
    maxInFlight: String(values.maxInFlight),
    localPreparationConcurrency: String(values.localPreparationConcurrency),
    uploadConcurrency: String(values.uploadConcurrency),
    spoolMaxBytes: values.spoolMaxBytes,
    spoolReserveBytes: values.spoolReserveBytes,
    defaultSourceConnectionId: values.defaultSourceConnectionId ?? '',
    defaultDestinationAccountId: values.defaultDestinationAccountId ?? '',
    defaultPublicationPolicy: values.defaultPublicationPolicy,
    sourceStagingCleanupEnabled: values.sourceStagingCleanupEnabled,
    sourceDeleteEnabled: values.sourceDeleteEnabled,
    sourceDeleteGraceSeconds: String(values.sourceDeleteGraceSeconds),
  };
}

function integerOrNull(raw: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function decimalCapacity(raw: string): boolean {
  return /^(?:0|[1-9][0-9]{0,29})$/.test(raw);
}

function valuesFromDraft(draft: NetdiskDraft): NetdiskSettingsValues | null {
  const candidate = {
    creationEnabled: draft.creationEnabled,
    maxInFlight: integerOrNull(draft.maxInFlight),
    localPreparationConcurrency: integerOrNull(draft.localPreparationConcurrency),
    uploadConcurrency: integerOrNull(draft.uploadConcurrency),
    spoolMaxBytes: draft.spoolMaxBytes,
    spoolReserveBytes: draft.spoolReserveBytes,
    defaultSourceConnectionId:
      draft.defaultSourceConnectionId === '' ? null : draft.defaultSourceConnectionId,
    defaultDestinationAccountId:
      draft.defaultDestinationAccountId === '' ? null : draft.defaultDestinationAccountId,
    defaultPublicationPolicy: draft.defaultPublicationPolicy,
    sourceStagingCleanupEnabled: draft.sourceStagingCleanupEnabled,
    sourceDeleteEnabled: draft.sourceDeleteEnabled,
    sourceDeleteGraceSeconds: integerOrNull(draft.sourceDeleteGraceSeconds),
  };
  const parsed = NetdiskSettingsValuesSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function netdiskProblems(draft: NetdiskDraft): string[] {
  const problems: string[] = [];
  const maxInFlight = integerOrNull(draft.maxInFlight);
  const local = integerOrNull(draft.localPreparationConcurrency);
  const upload = integerOrNull(draft.uploadConcurrency);
  const grace = integerOrNull(draft.sourceDeleteGraceSeconds);
  if (
    maxInFlight === null ||
    maxInFlight < NETDISK_MAX_IN_FLIGHT_MIN ||
    maxInFlight > NETDISK_MAX_IN_FLIGHT_MAX
  ) {
    problems.push('「最大在途任务」要填 1–8 之间的整数。');
  }
  if (local === null || local < 1 || local > NETDISK_LOCAL_PREPARATION_MAX) {
    problems.push('「本地准备并发」要填 1–4 之间的整数。');
  }
  if (upload === null || upload < 1 || upload > NETDISK_UPLOAD_MAX) {
    problems.push('「上传并发」要填 1–4 之间的整数。');
  }
  if (!decimalCapacity(draft.spoolMaxBytes) || draft.spoolMaxBytes === '0') {
    problems.push('「spool 最大字节」要填正十进制整数。');
  }
  if (!decimalCapacity(draft.spoolReserveBytes)) {
    problems.push('「spool 保留字节」要填非负十进制整数。');
  }
  if (
    decimalCapacity(draft.spoolMaxBytes) &&
    decimalCapacity(draft.spoolReserveBytes) &&
    BigInt(draft.spoolReserveBytes) >= BigInt(draft.spoolMaxBytes)
  ) {
    problems.push('spool 保留字节必须小于最大字节。');
  }
  if (grace === null || grace < 0 || grace > NETDISK_DELETE_GRACE_MAX_SECONDS) {
    problems.push('「来源删除宽限秒数」要填 0–2592000 之间的整数。');
  }
  if (problems.length === 0 && valuesFromDraft(draft) === null) {
    problems.push('这组设置不符合服务端冻结契约，请检查账户和策略选择。');
  }
  return problems;
}

const VALUE_KEYS = [
  'creationEnabled',
  'maxInFlight',
  'localPreparationConcurrency',
  'uploadConcurrency',
  'spoolMaxBytes',
  'spoolReserveBytes',
  'defaultSourceConnectionId',
  'defaultDestinationAccountId',
  'defaultPublicationPolicy',
  'sourceStagingCleanupEnabled',
  'sourceDeleteEnabled',
  'sourceDeleteGraceSeconds',
] as const satisfies readonly (keyof NetdiskSettingsValues)[];

function changed(
  values: NetdiskSettingsValues,
  base: NetdiskSettingsValues,
): Partial<NetdiskSettingsValues> {
  const delta: Partial<NetdiskSettingsValues> = {};
  for (const key of VALUE_KEYS) {
    if (values[key] !== base[key]) Object.assign(delta, { [key]: values[key] });
  }
  return delta;
}

function matches(draft: NetdiskDraft, base: NetdiskSettingsValues): boolean {
  const values = valuesFromDraft(draft);
  return values !== null && VALUE_KEYS.every((key) => values[key] === base[key]);
}

export function netdiskSaveErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return '保存结果尚未确认。刷新服务端版本后，可用同一组参数和新的验证码重试。';
  }
  switch (error.code) {
    case 'NETDISK_SETTINGS_REVISION_CONFLICT':
      return '设置已被其他页面或会话修改，请重新载入后再保存。';
    case 'NETDISK_SETTINGS_IDEMPOTENCY_CONFLICT':
      return '这次保存的幂等键已经用于另一组参数，请修改后重新提交。';
    case 'NETDISK_SETTINGS_INVALID_PROFILE':
      return '这组网盘设置不符合服务端限制，设置没有改动。';
    case 'NETDISK_DEFAULT_SOURCE_INVALID':
      return '默认来源连接不存在或不具备来源能力，请重新选择。';
    case 'NETDISK_DEFAULT_DESTINATION_INVALID':
      return '默认归档目的地不存在或当前不可用，请重新选择。';
    case 'IDEMPOTENCY_KEY_REQUIRED':
      return '这次请求缺少幂等键，服务器已拒绝；设置没有改动。';
    case 'DEMO_READ_ONLY':
      return '演示模式是只读的，设置没有改动。';
  }
  if (error.status === 401) return '会话已过期，请重新登录。';
  if (error.status === 404) return '这台机器上的 API 版本还没有这个接口，保存没有发生。';
  if (error.status === 501 || error.status === 503) {
    return '后端尚未启用或配置网盘设置能力，保存没有发生。';
  }
  if (error.status === 403) return '验证码不正确、已使用或当前账号没有保存权限。';
  if (error.status === 409) return '设置已被其他会话修改，请重新载入后再保存。';
  if (error.status >= 500) {
    return '保存结果尚未确认。刷新服务端版本后，可用同一组参数和新的验证码重试。';
  }
  return `服务端拒绝了这次保存（HTTP ${error.status}）；设置没有改动。`;
}

export type NetdiskSettingsController = {
  isPending: boolean;
  status: NetdiskSettingsStatus | undefined;
  unavailable: NetdiskUnavailable | null;
  refreshFailed: boolean;
  draft: NetdiskDraft | null;
  baseRevision: number | null;
  dirty: boolean;
  staleRevision: boolean;
  problems: string[];
  mfaCode: string;
  setMfaCode: (next: string) => void;
  saved: boolean;
  saveError: unknown;
  isSaving: boolean;
  canSave: boolean;
  demoReadOnly: boolean;
  setField: <K extends keyof NetdiskDraft>(field: K, value: NetdiskDraft[K]) => void;
  save: () => void;
  reload: () => void;
};

export function useNetdiskSettings(): NetdiskSettingsController {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: netdiskSettingsQueryKey,
    queryFn: getNetdiskSettings,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const status = query.data?.supported === true ? query.data.data : undefined;
  const [draft, setDraft] = useState<NetdiskDraft | null>(null);
  const [base, setBase] = useState<{
    revision: number;
    values: NetdiskSettingsValues;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [saved, setSaved] = useState(false);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const demoReadOnly = isDemoSessionActive();

  const dirty = useMemo(
    () => (base === null || draft === null ? false : !matches(draft, base.values)),
    [base, draft],
  );
  const baseRevision = base?.revision ?? null;

  const reseed = (next: NetdiskSettingsStatus): void => {
    setDraft(toDraft(next.configured));
    setBase({ revision: next.revision, values: { ...next.configured } });
    intent.current = null;
  };

  useEffect(() => {
    if (status === undefined) return;
    if (baseRevision === null || (status.revision !== baseRevision && !dirty)) {
      setSaved(false);
      reseed(status);
    }
  }, [status, baseRevision, dirty]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (draft === null || base === null) throw new Error('NETDISK_SETTINGS_NOT_LOADED');
      const values = valuesFromDraft(draft);
      if (values === null) throw new Error('NETDISK_SETTINGS_INVALID_DRAFT');
      const settings = changed(values, base.values);
      const fingerprint = JSON.stringify({ revision: base.revision, settings });
      if (intent.current?.fingerprint !== fingerprint) {
        intent.current = { fingerprint, key: newIdempotencyKey() };
      }
      return updateNetdiskSettings({
        idempotencyKey: intent.current.key,
        patch: { revision: base.revision, mfaCode, settings },
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(netdiskSettingsQueryKey, { supported: true, data: next });
      reseed(next);
      setMfaCode('');
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: netdiskSettingsQueryKey });
    },
    onError: (error) => {
      setMfaCode('');
      if (
        !(error instanceof ApiError) ||
        error.status === 409 ||
        error.status === 403 ||
        error.status >= 500
      ) {
        void queryClient.invalidateQueries({ queryKey: netdiskSettingsQueryKey });
      }
    },
  });

  const edit = <K extends keyof NetdiskDraft>(field: K, value: NetdiskDraft[K]): void => {
    intent.current = null;
    setSaved(false);
    if (mutation.isError) mutation.reset();
    setDraft((current) => (current === null ? current : { ...current, [field]: value }));
  };

  const hasReading = status !== undefined;
  const readError = query.error;
  const unavailable: NetdiskUnavailable | null =
    query.data?.supported === false
      ? { kind: 'ROUTE_ABSENT' }
      : hasReading
        ? null
        : readError instanceof ApiError
          ? readError.status === 501 || readError.status === 503
            ? { kind: 'NOT_ENABLED', status: readError.status }
            : readError.status === 401
              ? { kind: 'UNAUTHENTICATED' }
              : readError.status === 404
                ? { kind: 'ROUTE_ABSENT' }
                : { kind: 'READ_FAILED' }
          : readError
            ? { kind: 'READ_FAILED' }
            : null;
  const problems = draft === null ? [] : netdiskProblems(draft);
  const staleRevision =
    status !== undefined && baseRevision !== null && status.revision !== baseRevision;

  return {
    isPending: query.isPending,
    status,
    unavailable,
    refreshFailed: query.isError && hasReading,
    draft,
    baseRevision,
    dirty,
    staleRevision,
    problems,
    mfaCode,
    setMfaCode: (next) => setMfaCode(next.replace(/[^0-9]/g, '').slice(0, 6)),
    saved,
    saveError: mutation.isError ? mutation.error : null,
    isSaving: mutation.isPending,
    canSave:
      !demoReadOnly &&
      dirty &&
      problems.length === 0 &&
      /^[0-9]{6}$/.test(mfaCode) &&
      !mutation.isPending &&
      !staleRevision,
    demoReadOnly,
    setField: edit,
    save: () => mutation.mutate(),
    reload: () => {
      mutation.reset();
      setSaved(false);
      setMfaCode('');
      if (status !== undefined) reseed(status);
    },
  };
}
