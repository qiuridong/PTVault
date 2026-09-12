import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import type { RecoveryStatus } from '@ptvault/contracts';

import { ApiError } from '../../api/client.js';
import { getStorageAccounts, storageAccountsQueryKey } from '../storage/accountApi.js';
import { RecoveryPreparation, useRecoveryIntent } from './RecoveryPreparation.js';
import {
  attestRecoveryDrill,
  configureRecoveryRecipient,
  confirmComputerDownload,
  generateRecoveryBundle,
  getRecoveryExports,
  recoveryExportsQueryKey,
  recoveryStatusQueryKey,
  uploadEncryptedEscrow,
} from './recoveryApi.js';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '会话已过期，请重新登录。';
    if (error.status === 403) return '验证码不正确或已被使用，请用当前的新码重试。';
    if (error.status === 409) return '校验和与服务端记录的不一致，请核对后重试。';
    return error.message;
  }
  return '操作失败。';
}

/**
 * The six-digit field every recovery mutation carries.
 *
 * Its own state per step, deliberately: one code is spent per request, so a
 * single shared field would silently send an already-burnt code to the second
 * step the operator tried.
 */
function MfaField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>两步验证码</span>
      <input
        id={id}
        aria-label="两步验证码"
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
        required
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
      />
    </label>
  );
}

function Step({
  index,
  title,
  done,
  hint,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  hint: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="recovery-step" aria-labelledby={titleId} data-done={done}>
      <header className="recovery-step-header">
        {done ? (
          <CircleCheck size={17} strokeWidth={1.9} aria-hidden="true" />
        ) : (
          <CircleDashed size={17} strokeWidth={1.9} aria-hidden="true" />
        )}
        <div>
          <h3 id={titleId}>
            第 {index} 步 · {title}
          </h3>
          <p className="recovery-step-hint">{hint}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function StepError({ error }: { error: unknown }) {
  return (
    <p className="inline-message error-message" role="alert">
      <TriangleAlert size={14} strokeWidth={1.8} aria-hidden="true" /> {errorMessage(error)}
    </p>
  );
}

/**
 * The operator-facing path from "nothing configured" to "deletion may unlock".
 *
 * Rendered in both SHADOW and ACTIVE on purpose. `OffloadHandler` asks the
 * recovery gate for a deletion permit during HASHING — before a single byte
 * moves — so an operator who cannot build this material first cannot upload at
 * all. Hiding these steps until ACTIVE would demand they arm the destructive
 * switch before the material that makes deletion survivable could exist.
 *
 * Nothing here pauses a torrent or deletes a local file: it writes a few MB of
 * encrypted metadata to the operator's own cloud accounts.
 */
export function RecoverySetup({ status }: { status: RecoveryStatus }) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(status.version);
  const exportsQuery = useQuery({ queryKey: recoveryExportsQueryKey, queryFn: getRecoveryExports });
  const target = exportsQuery.data?.find((item) => item.version === selectedVersion);
  if (status.readinessProblems?.includes('COMPATIBILITY_READ_ONLY'))
    return (
      <p className="inline-message" role="note">
        兼容回滚只读：保留恢复状态、历史和原文件下载；暂不更改基线、材料或个人证明。
      </p>
    );
  return (
    <div className="recovery-setup">
      <h2>建立恢复材料</h2>
      <p className="inline-message" role="note">
        <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" /> 恢复材料是
        <strong>上传</strong>的前置条件，不只是删除的：任务在计算哈希阶段就会向恢复门申请删除许可，
        拿不到就整批停在 FAILED_SAFE，一个字节都不会上传。
      </p>
      <RecoveryPreparation
        status={status}
        exports={exportsQuery.data ?? []}
        selectedVersion={selectedVersion}
        onSelect={setSelectedVersion}
      />
      {exportsQuery.isError ? <StepError error={exportsQuery.error} /> : null}
      <RecipientStep
        configured={status.publicRecipientConfigured}
        materialRevision={status.materialRevision}
      />
      {/*
        Both derive "done" from the server's export version rather than from their
        own submit result, which is lost on reload. A version exists only if a
        bundle was generated, and `generate()` refuses without a staged escrow
        (`RECOVERY_ESCROW_NOT_UPLOADED`) — so a version proves both steps ran.
      */}
      <EscrowStep
        bundled={status.escrowConfigured ?? status.version !== null}
        materialRevision={status.materialRevision}
      />
      <GenerateStep version={status.latestSnapshotVersion ?? status.version} />
      <ConfirmStep
        key={`confirm-${target?.version ?? 'none'}`}
        version={target?.version ?? null}
        done={
          target !== undefined &&
          target.computerConfirmedAt !== null &&
          target.computerConfirmedSha256 === target.bundleSha256
        }
      />
      <DrillStep
        key={`drill-${target?.version ?? 'none'}`}
        version={target?.version ?? null}
        done={
          target !== undefined &&
          target.passphraseVerifiedAt !== null &&
          target.passphraseVerifiedSha256 === target.escrowSha256
        }
      />
    </div>
  );
}
/** Invalidates status and the export list, both of which every step changes. */
function useRecoveryRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: recoveryStatusQueryKey });
    await queryClient.invalidateQueries({ queryKey: recoveryExportsQueryKey });
  };
}

function RecipientStep({
  configured,
  materialRevision,
}: {
  configured: boolean;
  materialRevision: number | undefined;
}) {
  const recipientId = useId();
  const refresh = useRecoveryRefresh();
  const [recipient, setRecipient] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const request = useRecoveryIntent<{
    publicRecipient: string;
    expectedMaterialRevision: number;
  }>();

  const mutation = useMutation({
    mutationFn: () => {
      const intent = request.capture(() => {
        if (materialRevision === undefined) throw new Error('RECOVERY_REVISION_REQUIRED');
        return { publicRecipient: recipient, expectedMaterialRevision: materialRevision };
      });
      return configureRecoveryRecipient({
        ...intent.identity,
        mfaCode,
        idempotencyKey: intent.key,
      });
    },
    onSuccess: async () => {
      request.reset();
      setMfaCode('');
      await refresh();
    },
  });

  // A recipient is an age *public* key. Changing it starts a new generation, so
  // previously exported bundles stop counting toward the gate — the material must
  // be openable by the key currently on file, not one rotated away from.
  const canSubmit =
    materialRevision !== undefined &&
    /^age1[0-9a-z]{20,100}$/.test(recipient) &&
    /^[0-9]{6}$/.test(mfaCode) &&
    !mutation.isPending;

  return (
    <Step
      index={1}
      title="登记恢复收件人"
      done={configured}
      hint="恢复包用这把 age 公钥加密。对应的私钥请离线保存，服务器永远不接触它。"
    >
      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="field" htmlFor={recipientId}>
          <span>age 公钥</span>
          <input
            id={recipientId}
            aria-label="age 公钥"
            type="text"
            value={recipient}
            onChange={(event) => {
              request.reset();
              mutation.reset();
              setRecipient(event.target.value.trim());
            }}
            disabled={mutation.isPending}
            required
            spellCheck={false}
            placeholder="age1……"
          />
          <small className="field-hint">
            换收件人会另起一代，之前生成的恢复包不再计入解锁条件。
          </small>
        </label>
        <MfaField value={mfaCode} onChange={setMfaCode} />
        {mutation.isError ? <StepError error={mutation.error} /> : null}
        <div className="instance-form-actions">
          {mutation.isError ? (
            <button
              type="button"
              onClick={() => {
                request.reset();
                mutation.reset();
                setMfaCode('');
              }}
            >
              放弃旧请求，按当前状态重来
            </button>
          ) : null}
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在保存……' : '保存收件人'}
          </button>
        </div>
      </form>
    </Step>
  );
}
function EscrowStep({
  bundled,
  materialRevision,
}: {
  bundled: boolean;
  materialRevision: number | undefined;
}) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [digest, setDigest] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const request = useRecoveryIntent<{ bytes: Uint8Array; expectedMaterialRevision: number }>();
  const refresh = useRecoveryRefresh();

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('NO_FILE');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const intent = request.capture(() => {
        if (materialRevision === undefined) throw new Error('RECOVERY_REVISION_REQUIRED');
        return { bytes, expectedMaterialRevision: materialRevision };
      });
      return uploadEncryptedEscrow({
        ...intent.identity,
        mfaCode,
        idempotencyKey: intent.key,
      });
    },
    onSuccess: async (result) => {
      request.reset();
      setDigest(result.escrowSha256);
      setMfaCode('');
      setFile(null);
      await refresh();
    },
  });

  const canSubmit =
    materialRevision !== undefined &&
    file !== null &&
    file.size > 0 &&
    file.size <= 4 * 1024 * 1024 &&
    /^[0-9]{6}$/.test(mfaCode) &&
    !mutation.isPending;
  const done = digest !== null || bundled;

  // Collapsed once done, with an explicit way back in: re-uploading is how the
  // operator corrects a bad escrow, so the form must stay reachable — just not
  // open by default, which reads as "unfinished".
  if (done && !reopened) {
    return (
      <Step index={2} title="上传 escrow.age" done hint="已暂存 escrow，可用于生成恢复包。">
        <div className="instance-form-actions">
          <button type="button" onClick={() => setReopened(true)}>
            重新上传
          </button>
        </div>
      </Step>
    );
  }

  return (
    <Step
      index={2}
      title="上传 escrow.age"
      done={done}
      hint="在你自己的电脑上，用口令短语（不是公钥）加密 crypt 口令，再把生成的 escrow.age 传上来。"
    >
      <p className="inline-message" role="note">
        <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" /> 本机执行：
        <code>age --passphrase --output escrow.age crypt-passphrase.txt</code>
        。crypt 口令<strong>不会</strong>以明文形式到达服务器。
      </p>
      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <label className="field" htmlFor={fileId}>
          <span>escrow.age 文件</span>
          <input
            id={fileId}
            aria-label="escrow.age 文件"
            type="file"
            accept=".age"
            onChange={(event) => {
              request.reset();
              mutation.reset();
              setFile(event.target.files?.[0] ?? null);
            }}
            disabled={mutation.isPending}
          />
          <small className="field-hint">
            服务端会校验它确实是口令加密（scrypt）的 age 文件；用公钥加密的会被拒绝。
          </small>
        </label>
        <MfaField value={mfaCode} onChange={setMfaCode} />
        {mutation.isError ? <StepError error={mutation.error} /> : null}
        {digest !== null ? (
          <p className="inline-message" role="status">
            <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" /> 已暂存，SHA-256：
            <code>{digest}</code>
          </p>
        ) : null}
        <div className="instance-form-actions">
          {mutation.isError ? (
            <button
              type="button"
              onClick={() => {
                request.reset();
                mutation.reset();
                setMfaCode('');
              }}
            >
              放弃旧请求，按当前状态重来
            </button>
          ) : null}
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在上传……' : '上传 escrow'}
          </button>
        </div>
      </form>
    </Step>
  );
}

function GenerateStep({ version }: { version: number | null }) {
  const refresh = useRecoveryRefresh();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [mfaCode, setMfaCode] = useState('');
  const [result, setResult] = useState<{ version: number; bundleSha256: string } | null>(null);
  const [reopened, setReopened] = useState(false);

  const accountsQuery = useQuery({
    queryKey: storageAccountsQueryKey,
    queryFn: getStorageAccounts,
  });

  const mutation = useMutation({
    mutationFn: () => generateRecoveryBundle({ destinationAccountIds: [...selected], mfaCode }),
    onSuccess: async (bundle) => {
      setResult({ version: bundle.version, bundleSha256: bundle.bundleSha256 });
      setMfaCode('');
      await refresh();
    },
  });

  // Two distinct destinations, matching what the gate later demands: one cloud
  // copy is a single point of failure for the material that exists precisely to
  // survive failures.
  const canSubmit = selected.size >= 2 && /^[0-9]{6}$/.test(mfaCode) && !mutation.isPending;
  const currentVersion = result?.version ?? version;
  const done = currentVersion !== null;

  // Regenerating is a legitimate action (rotating the recipient, adding a
  // destination), so the form stays reachable behind an explicit button rather
  // than sitting open and reading as unfinished work.
  if (done && !reopened) {
    return (
      <Step
        index={3}
        title="生成并分发恢复包"
        done
        hint={`已生成 v${currentVersion} 并分发到云端。重新生成会另起一个版本。`}
      >
        {result !== null ? (
          <p className="inline-message" role="status">
            <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" /> 包 SHA-256：
            <code>{result.bundleSha256}</code>
          </p>
        ) : null}
        <div className="instance-form-actions">
          <button type="button" onClick={() => setReopened(true)}>
            重新生成
          </button>
        </div>
      </Step>
    );
  }

  return (
    <Step
      index={3}
      title="生成并分发恢复包"
      done={done}
      hint="打包 rclone 配置、账户映射、数据库快照与种子清单，用收件人公钥加密后复制到至少两个云端账户。"
    >
      <form
        className="instance-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) mutation.mutate();
        }}
      >
        <fieldset className="recovery-destinations">
          <legend>目标账户（至少 2 个）</legend>
          {accountsQuery.isPending ? <p>正在加载账户…</p> : null}
          {accountsQuery.isError ? <p role="alert">无法加载存储账户。</p> : null}
          {(accountsQuery.data ?? []).map((account) => (
            <label key={account.id} className="recovery-destination">
              <input
                type="checkbox"
                aria-label={`账户 ${account.label}`}
                checked={selected.has(account.id)}
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (!next.delete(account.id)) next.add(account.id);
                    return next;
                  })
                }
              />
              <span>{account.label}</span>
              <span className="recovery-destination-health">{account.health}</span>
            </label>
          ))}
        </fieldset>
        <MfaField value={mfaCode} onChange={setMfaCode} />
        {mutation.isError ? <StepError error={mutation.error} /> : null}
        {result !== null ? (
          <p className="inline-message" role="status">
            <CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" /> 已生成 v{result.version}
            ，包 SHA-256：<code>{result.bundleSha256}</code>
          </p>
        ) : null}
        <div className="instance-form-actions">
          <button type="submit" className="primary-action" disabled={!canSubmit}>
            {mutation.isPending ? '正在生成……' : '生成恢复包'}
          </button>
        </div>
      </form>
    </Step>
  );
}
/**
 * Steps 4 and 5 share a shape: paste a SHA-256 you computed on your own machine,
 * plus a fresh code. Typing the digest by hand is the point — the server compares
 * it against what it recorded, so a confirmation can only come from someone who
 * actually holds the file.
 */
function AttestationStep({
  index,
  title,
  hint,
  digestLabel,
  digestHint,
  submitLabel,
  done,
  version,
  onSubmit,
}: {
  index: number;
  title: string;
  hint: string;
  digestLabel: string;
  digestHint: string;
  submitLabel: string;
  done: boolean;
  version: number | null;
  onSubmit: (input: { version: number; digest: string; mfaCode: string }) => Promise<unknown>;
}) {
  const digestId = useId();
  const refresh = useRecoveryRefresh();
  const [digest, setDigest] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [reopened, setReopened] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      if (version === null) throw new Error('NO_VERSION');
      return onSubmit({ version, digest, mfaCode });
    },
    onSuccess: async () => {
      setMfaCode('');
      setDigest('');
      await refresh();
    },
  });

  const canSubmit =
    version !== null &&
    /^[a-f0-9]{64}$/.test(digest) &&
    /^[0-9]{6}$/.test(mfaCode) &&
    !mutation.isPending;

  // An attested step collapses: leaving a filled-in digest form open next to a
  // green check invites re-submitting an attestation that already holds.
  if (done && !reopened) {
    return (
      <Step index={index} title={title} done hint={`已确认（v${version ?? '?'}）。`}>
        <div className="instance-form-actions">
          <button type="button" onClick={() => setReopened(true)}>
            重新确认
          </button>
        </div>
      </Step>
    );
  }

  return (
    <Step index={index} title={title} done={done} hint={hint}>
      {version === null ? (
        <p className="inline-message" role="note">
          <CircleDashed size={14} strokeWidth={1.8} aria-hidden="true" /> 先完成第 3 步生成恢复包。
        </p>
      ) : (
        <form
          className="instance-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <label className="field" htmlFor={digestId}>
            <span>{digestLabel}</span>
            <input
              id={digestId}
              aria-label={digestLabel}
              type="text"
              value={digest}
              onChange={(event) => setDigest(event.target.value.trim().toLowerCase())}
              required
              spellCheck={false}
              placeholder="64 位十六进制"
            />
            <small className="field-hint">{digestHint}</small>
          </label>
          <MfaField value={mfaCode} onChange={setMfaCode} />
          {mutation.isError ? <StepError error={mutation.error} /> : null}
          <div className="instance-form-actions">
            <button type="submit" className="primary-action" disabled={!canSubmit}>
              {mutation.isPending ? '正在提交……' : submitLabel}
            </button>
          </div>
        </form>
      )}
    </Step>
  );
}

function ConfirmStep({ version, done }: { version: number | null; done: boolean }) {
  return (
    <AttestationStep
      index={4}
      title="确认已下载到本机"
      hint="把恢复包下载到你自己的电脑并校验哈希——云端副本再多，都不能替代一份离线副本。"
      digestLabel="恢复包 SHA-256"
      digestHint={`本步骤仅确认 recovery-v${version ?? '<版本>'}.tar.age 的恢复包 SHA；不要填写 escrow 摘要，也不要混用其他版本。`}
      submitLabel="确认已下载"
      done={done}
      version={version}
      onSubmit={({ version: v, digest, mfaCode }) =>
        confirmComputerDownload({ version: v, bundleSha256: digest, mfaCode })
      }
    />
  );
}

function DrillStep({ version, done }: { version: number | null; done: boolean }) {
  return (
    <AttestationStep
      index={5}
      title="口令演练"
      hint="真的用恢复口令解一次 escrow.age。一个从没解开过的口令，等于没有口令。"
      digestLabel="escrow.age SHA-256"
      digestHint={`解密成功后校验该版本 escrow-v${version ?? '<版本>'}.age 的 SHA；这是第 5 步的密封件摘要，不是第 4 步恢复包的 SHA。`}
      submitLabel="确认演练成功"
      done={done}
      version={version}
      onSubmit={({ version: v, digest, mfaCode }) =>
        attestRecoveryDrill({ version: v, escrowSha256: digest, mfaCode })
      }
    />
  );
}
