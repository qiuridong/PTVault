import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type { AppDatabase } from '../db/database.js';
import type { QbRepository } from '../qb/repository.js';
import type { StorageAccountRepository } from '../storage/accounts.js';
import type { RecoveryBundleService, RecoveryBundleSource } from './bundle.js';
import type { RecoveryWorkflow } from './routes.js';
import type { RecoveryPreparationContext } from './preparation-context.js';

export type DbRecoveryWorkflowOptions = {
  preparation: RecoveryPreparationContext;
  db: AppDatabase;
  bundles: RecoveryBundleService;
  accounts: StorageAccountRepository;
  torrents: Pick<QbRepository, 'listTorrents' | 'listInstances'>;
  /** Absolute path to the rclone.conf whose (sanitized) text goes into the bundle. */
  rcloneConfigPath: string;
  /** Where the staged escrow and transient DB backups live; created 0700. */
  stateDirectory: string;
  now?: () => number;
};

/**
 * Bridges the recovery HTTP routes to `RecoveryBundleService`.
 *
 * The two route calls are deliberately separate — the operator uploads a
 * passphrase-encrypted escrow once, then generates bundles from it — so the
 * escrow has to outlive a single request. It is staged on disk rather than held
 * in memory: these two steps can easily straddle a service restart, and losing
 * the escrow means asking the operator to redo the offline encryption of a
 * passphrase we deliberately never see.
 */
export class DbRecoveryWorkflow implements RecoveryWorkflow {
  private readonly options: DbRecoveryWorkflowOptions;
  private readonly now: () => number;

  constructor(options: DbRecoveryWorkflowOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  private get recoveryDirectory(): string {
    return path.join(path.resolve(this.options.stateDirectory), 'recovery');
  }

  async uploadEncryptedEscrow(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ escrowSha256: string }> {
    if (this.options.preparation.readOnly) throw new Error('RECOVERY_COMPATIBILITY_READ_ONLY');
    return this.options.preparation.writer.replace({
      bytes,
      signal,
      expectedMaterialRevision: this.options.preparation.store.get().materialRevision,
      operationId: randomUUID(),
    });
  }

  async generate(input: {
    destinationAccountIds: readonly string[];
    signal: AbortSignal;
  }): Promise<{
    version: number;
    bundlePath: string;
    bundleSha256: string;
    escrowSha256: string;
    accountIds: string[];
  }> {
    const preparation = this.options.preparation;
    if (preparation.readOnly) throw new Error('RECOVERY_COMPATIBILITY_READ_ONLY');
    const captured = await preparation.coordinator.withRead(async () => {
      const state = preparation.store.get();
      const material = await preparation.observer.read(input.signal);
      const recipient = preparation.repository.getRecipientIdentity();
      if (!recipient) throw new Error('RECOVERY_RECIPIENT_NOT_CONFIGURED');
      const version = preparation.repository.beginExport({
        escrowSha256: material.sha256,
        expectedMaterialRevision: state.materialRevision,
        expectedPublicRecipient: recipient.publicRecipient,
        expectedRecipientGeneration: recipient.recipientGeneration,
      });
      const databaseBackup = await this.onlineBackup();
      const source = await this.buildBundleSource(databaseBackup);
      return { encryptedEscrow: material.bytes, reservation: { version, ...recipient }, source };
    });

    return this.options.bundles.generate({
      ...captured,
      destinationAccountIds: input.destinationAccountIds,
      signal: input.signal,
    });
  }

  /** The staged escrow, or a clear error telling the operator to upload one first. */
  async latestEscrow(): Promise<Uint8Array> {
    try {
      return (await this.options.preparation.observer.read()).bytes;
    } catch {
      throw new Error('RECOVERY_ESCROW_NOT_UPLOADED');
    }
  }

  /**
   * A consistent snapshot via SQLite's online backup API.
   *
   * Never a raw file copy: this database runs in WAL mode, so copying the file
   * while writes are in flight can yield a snapshot that is missing committed
   * transactions — precisely the rows a recovery bundle exists to preserve.
   */
  async onlineBackup(): Promise<Buffer> {
    await mkdir(this.recoveryDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(
      this.recoveryDirectory,
      `.backup-${this.now()}-${randomUUID()}.db`,
    );
    try {
      await this.options.db.backup(destination);
      await chmod(destination, 0o600);
      return await readFile(destination);
    } finally {
      await rm(destination, { force: true });
    }
  }

  /**
   * Everything a future operator needs to rebuild access, and nothing that would
   * hand over live access on its own.
   *
   * `rclone.conf` is sanitized by the bundle service (OAuth tokens stripped), so
   * the bundle proves *which* remotes existed and how crypt was configured
   * without carrying a credential that still works.
   */
  async buildBundleSource(databaseBackup: Buffer): Promise<RecoveryBundleSource> {
    const rcloneConfig = await readFile(this.options.rcloneConfigPath, 'utf8');
    const accounts = this.options.accounts.list();
    const torrents = this.options.torrents.listTorrents();

    return {
      rcloneConfig,
      accountMapping: accounts.map((account) => ({
        id: account.id,
        label: account.label,
        // Both layers: `cryptRemote` is where blobs live, `rawRemote` is the
        // backend underneath it. A recovery reader needs the pair to rebuild
        // rclone.conf, since the crypt remote alone does not say what it wraps.
        cryptRemote: account.cryptRemote,
        rawRemote: account.rawRemote,
      })),
      databaseBackup,
      torrentManifest: torrents.map((torrent) => ({
        instanceId: torrent.instanceId,
        hash: torrent.hash,
        name: torrent.name,
        totalSize: torrent.totalSize,
        contentPath: torrent.contentPath,
        savePath: torrent.savePath,
        cloudState: torrent.cloudState,
      })),
      recoveryInstructions: RECOVERY_INSTRUCTIONS,
    };
  }
}

/**
 * Written for whoever opens this bundle without this codebase, this UI, or this
 * VPS — possibly years later, possibly not the person who created it. It states
 * what the archive is, what is deliberately missing, and the exact commands to
 * get bytes back, because a recovery bundle that needs the original system to
 * interpret it is not a recovery bundle.
 */
const RECOVERY_INSTRUCTIONS = `# PT Vault 恢复说明

本压缩包是 PT Vault 的恢复材料。**你不需要 PT Vault 这套程序也能取回数据。**

## 包内文件

- \`rclone.conf\` —— rclone 配置（**OAuth token 已被移除**，见下）
- \`accounts.json\` —— 云端账户与 crypt remote 的对应关系
- \`ptvault.db\` —— SQLite 数据库，含每个文件的原始路径 ↔ blob 哈希对应表
- \`torrents.json\` —— 种子清单（名称、体积、原始路径、云端状态）
- \`escrow.age\` —— **单独存放于同一云端目录**，不在本压缩包内

## 恢复材料的实际关系

1. **本压缩包**用 age 公钥加密，需要对应的 age **私钥**解开。
2. 新准备的 \`escrow.age\` 应保存上述 age 私钥，以恢复口令加密（scrypt）。
3. 包内 rclone.conf 保留各 crypt profile 的 password/password2；obscure 不是加密保护。

这不是两把独立数据密钥：掌握 age 私钥就能读取包内 crypt 密钥。保护私钥与恢复口令。
服务器只检查 escrow 密文格式，无法识别其明文。历史 escrow 可能保存 crypt 口令；
先在本机核对，并保留对应 age 私钥，不能假定旧材料已自动转换。

## 取回步骤

\`\`\`bash
# 1. 先正常授权 raw 云账户，从页面记录的完整路径取回这两个文件。
#    新包在 raw remote 的 ptvault-recovery/<recipient摘要>/vN/<包摘要>/ 下；
#    不需要预先知道 crypt 密钥。旧 crypt:recovery/vN 副本仍按原路径处理。

# 2. 新材料：age 自己在终端提示恢复口令，先还原私钥再解包。
umask 077
age --decrypt --output identity.key escrow.age
age --decrypt --identity identity.key --output recovery.tar bundle.tar.age
tar -xf recovery.tar

# 3. 补回 rclone.conf 里被移除的 token
#    对每个 OneDrive 后端重新授权（会开浏览器）：
rclone --config rclone.conf config reconnect <后端名>:

# 4. 保留包内每个 crypt 段原 password/password2，不生成替代密钥。

# 5. 列出并取回文件
rclone --config rclone.conf ls ptvault-crypt:blobs
rclone --config rclone.conf copy ptvault-crypt:blobs/ab/abcdef... ./
\`\`\`

## 云端文件名是内容哈希，不是原文件名

云端对象叫 \`blobs/<sha256前2位>/<sha256>\`，**不是**原始文件名。
原始文件名 ↔ 哈希的对应关系**只在 \`ptvault.db\` 里**，云端没有第二份。
所以：**\`ptvault.db\` 丢了，数据还在但你不知道哪个 blob 是哪部片子。**

查对应关系：

\`\`\`sql
SELECT relative_path, sha256 FROM offload_files WHERE job_id IN (
  SELECT job_id FROM offload_snapshots WHERE torrent_hash = '<40位hex>'
);
-- 网盘导入不是上述 PT blobs：按账户映射选择 remote，路径为 ptvault-imports/<committed_key>。
SELECT relative_path, destination_account_id, committed_key, committed_sha256 FROM import_objects
WHERE committed_key IS NOT NULL;
\`\`\`

## 为什么 token 被移除

\`rclone.conf\` 里的 OAuth token 能直接读写你的云盘。恢复包会被复制到云端多个位置，
带着可用 token 就等于把云盘钥匙和锁放在同一个抽屉里。第 3 步重新授权即可，
恢复包仍含敏感数据库与 crypt 密钥，必须作为私密材料保护；不得公开上传解密后的内容。
`;
