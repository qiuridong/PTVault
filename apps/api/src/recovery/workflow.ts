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

## 两把钥匙，缺一不可

1. **本压缩包**用 age 公钥加密，需要对应的 age **私钥**解开。
2. **crypt 口令**在 \`escrow.age\` 里，用你自己设的**口令短语**加密（scrypt）。

私钥能解开压缩包，但解不开 escrow；口令短语能解开 escrow，但解不开压缩包。
这是有意的：任何单一泄露都不足以读取你的数据。

## 取回步骤

\`\`\`bash
# 1. 解开本压缩包
age --decrypt --identity ~/age-key.txt recovery-vN.tar.age | tar -xf -

# 2. 解开 escrow，拿到 crypt 口令
age --decrypt escrow.age > crypt-passphrase.txt

# 3. 补回 rclone.conf 里被移除的 token
#    对每个 OneDrive 后端重新授权（会开浏览器）：
rclone config reconnect <后端名>:

# 4. 把口令填进 rclone.conf 的 crypt 段
#    password = $(rclone obscure "$(cat crypt-passphrase.txt)")

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
\`\`\`

## 为什么 token 被移除

\`rclone.conf\` 里的 OAuth token 能直接读写你的云盘。恢复包会被复制到云端多个位置，
带着可用 token 就等于把云盘钥匙和锁放在同一个抽屉里。第 3 步重新授权即可，
成本是开一次浏览器，换来的是这个包本身不构成一条攻击路径。
`;
