import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SetupConfigStore } from './config-store.js';
import {
  initializeManagedInstallation,
  readBootstrapCredential,
  readManagedInstallation,
  rotateSetupLink,
} from './managed-installation.js';
import { startManagedServer } from './managed-server.js';
import { ensurePrivateDirectory, readPrivateText } from './private-files.js';
import { acquirePublicLock } from './public-lock.js';
import { startControlSocket } from './control-socket.js';
import { MAX_RCLONE_CONFIG_BYTES } from '../storage/rclone-config-files.js';

export type PublicOptions = {
  stateDir: string;
  masterKeyFile: string;
  releaseRoot: string;
  mediaExportRoot: string;
  port: number;
};
export type PublicCommand = 'init' | 'run' | 'setup-link' | 'doctor' | 'help';
const argumentError = () => new Error('SETUP_ARGUMENT_INVALID');
export function parsePublicArguments(
  args: readonly string[],
): PublicOptions & { command: PublicCommand } {
  const command = args[0] ?? 'help';
  if (!['init', 'run', 'setup-link', 'doctor', 'help'].includes(command)) throw argumentError();
  const options: PublicOptions = {
    stateDir: '/var/lib/ptvault-public',
    masterKeyFile: '/etc/ptvault-public/master.key',
    releaseRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
    mediaExportRoot: '/srv/ptvault-public',
    port: 3210,
  };
  const keys = {
    '--state-dir': 'stateDir',
    '--master-key-file': 'masterKeyFile',
    '--release-root': 'releaseRoot',
    '--media-export-root': 'mediaExportRoot',
  } as const;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!,
      value = args[index + 1];
    if (command === 'help' || seen.has(flag) || value === undefined || /[\r\n\0]/.test(value))
      throw argumentError();
    seen.add(flag);
    if (flag === '--port') {
      if (
        command !== 'init' ||
        !/^[1-9]\d{3,4}$/.test(value) ||
        Number(value) < 1024 ||
        Number(value) > 65535
      )
        throw argumentError();
      options.port = Number(value);
    } else if (Object.hasOwn(keys, flag) && path.isAbsolute(value))
      options[keys[flag as keyof typeof keys]] = path.resolve(value);
    else throw argumentError();
  }
  return { ...options, command: command as PublicCommand };
}
function existing(filename: string): boolean {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function requireDirectory(directory: string): void {
  // Unlike ensurePrivateDirectory this is deliberately read-only, even on failure.
  let current = path.resolve(directory);
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SETUP_FILE_UNSAFE');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (process.platform !== 'win32' && (lstatSync(directory).mode & 0o077) !== 0)
    throw new Error('SETUP_FILE_NOT_PRIVATE');
}
export function loadPublicMasterKey(
  options: Pick<PublicOptions, 'masterKeyFile'>,
  env: NodeJS.ProcessEnv,
): Buffer {
  const file = env.CREDENTIALS_DIRECTORY
    ? path.join(env.CREDENTIALS_DIRECTORY, 'master.key')
    : options.masterKeyFile;
  if (!existing(file)) throw new Error('SETUP_MASTER_KEY_MISSING');
  let text: string;
  const before = lstatSync(file);
  if (process.platform === 'linux' && env.CREDENTIALS_DIRECTORY && (before.mode & 0o077) !== 0) {
    // systemd 255 can expose LoadCredential as root:root 0440 with a named-user
    // ACL inside a read-only 0550 credential mount. The group bits are its ACL
    // mask, not a grant to the root group. This is not a reason
    // to relax the 0600 policy for ordinary settings, rclone config or key files.
    const directory = path.dirname(file), parent = lstatSync(directory);
    const safe = (info: Stats) => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === 0 && [0,process.getgid!()].includes(info.gid) && (info.mode & 0o777) === 0o440 && info.size <= 1024;
    const readOnlyMount = readFileSync('/proc/self/mountinfo','utf8').split('\n').some(line=>{
      const fields=line.split(' '), separator=fields.indexOf('-');
      return fields[4]===directory && fields[5]?.split(',').includes('ro') && fields[separator+1]==='tmpfs';
    });
    if (!/^\/run\/credentials\/ptvault-public(?:-command-[A-Za-z0-9-]+)?\.service$/.test(directory) || !readOnlyMount || realpathSync.native(directory) !== directory || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.gid !== before.gid || (parent.mode & 0o777) !== 0o550 || !safe(before)) throw Error('SETUP_FILE_NOT_PRIVATE');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (!safe(opened) || opened.ino !== before.ino || opened.dev !== before.dev) throw Error('SETUP_FILE_UNSAFE');
      const bytes = Buffer.alloc(opened.size + 1), length = readSync(fd,bytes,0,bytes.length,0);
      const after = fstatSync(fd);
      if (length !== opened.size || !safe(after) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error('SETUP_FILE_UNSAFE');
      text = bytes.subarray(0,length).toString('utf8');
    } finally { closeSync(fd); }
  } else text = readPrivateText(file);
  const value = text.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('SETUP_MASTER_KEY_INVALID');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw new Error('SETUP_MASTER_KEY_INVALID');
  return key;
}
function createMasterKey(options: PublicOptions): void {
  if (existing(options.masterKeyFile)) return;
  if (
    existing(path.join(options.stateDir, 'installation.json')) ||
    existing(path.join(options.stateDir, 'ptvault.db'))
  )
    throw new Error('SETUP_MASTER_KEY_MISSING');
  const directory = path.dirname(options.masterKeyFile);
  ensurePrivateDirectory(directory);
  const fd = openSync(
    options.masterKeyFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, `${randomBytes(32).toString('base64')}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') {
    const parent = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
}
export async function initializePublic(
  options: PublicOptions,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  ensurePrivateDirectory(options.stateDir);
  const releaseMetadata = await acquirePublicLock(options.stateDir, 'metadata');
  try {
    const releaseRun = await acquirePublicLock(options.stateDir, 'run');
    try {
      if (
        !existing(path.join(options.stateDir, 'installation.json')) &&
        readdirSync(options.stateDir).length > 0
      )
        throw new Error('SETUP_EXISTING_INSTALLATION');
      // The root installer may provide its retained key through LoadCredential,
      // so init itself can run as the service user and own every new state file.
      if (!env.CREDENTIALS_DIRECTORY) createMasterKey(options);
      initializeManagedInstallation({ ...options, masterKey: loadPublicMasterKey(options, env) });
    } finally {
      await releaseRun();
    }
  } finally {
    await releaseMetadata();
  }
}
export async function publicSetupLink(
  options: PublicOptions,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  requireDirectory(options.stateDir);
  const release = await acquirePublicLock(options.stateDir, 'metadata');
  try {
    return rotateSetupLink({ ...options, masterKey: loadPublicMasterKey(options, env) });
  } finally {
    await release();
  }
}
export async function startPublicRuntime(
  options: PublicOptions,
  env: NodeJS.ProcessEnv,
  onFatal: (code: string) => void,
) {
  requireDirectory(options.stateDir);
  const release = await acquirePublicLock(options.stateDir, 'run');
  try {
    process.umask(0o077); // SQLite and all children inherit private defaults; never chmod old data.
    const managed = await startManagedServer({
      ...options,
      releaseRoot: realpathSync.native(options.releaseRoot),
      masterKey: loadPublicMasterKey(options, env),
      installSignalHandlers: false,
      onFatal,
    });
    let control: Awaited<ReturnType<typeof startControlSocket>> | undefined;
    try {
      if (process.platform === 'linux') control = await startControlSocket(options.stateDir, managed.maintenance);
    } catch (error) {
      try { await managed.stop(); }
      catch { throw Error('SERVER_STARTUP_CLEANUP_FAILED'); }
      throw error;
    }
    let stopping: Promise<void> | undefined;
    return {
      managed,
      stop: () =>
        (stopping ??= (async () => {
          await managed.stop();
          await control?.stop();
          await release();
        })()),
    };
  } catch (error) {
    // Failed startup cleanup may still own workers. Keep the process-held lock until exit.
    if ((error as Error).message !== 'SERVER_STARTUP_CLEANUP_FAILED') await release();
    throw error;
  }
}
type Check = { code: string; status: 'PASS' | 'WARN' | 'FAIL'; message: string };
export function inspectPublic(
  options: PublicOptions,
  env: NodeJS.ProcessEnv,
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  function check(code: string, message: string, action: () => 'PASS' | 'WARN' | void) {
    try {
      checks.push({ code, status: action() ?? 'PASS', message });
    } catch {
      checks.push({
        code,
        status: 'FAIL',
        message: `${message}：未通过，请核对文件是否存在、权限和原安装资料是否完整。`,
      });
    }
  }
  check('STATE', '私有数据目录检查', () => requireDirectory(options.stateDir));
  let key: Buffer | undefined;
  check('MASTER_KEY', '原主密钥读取', () => {
    key = loadPublicMasterKey(options, env);
  });
  check('INSTALLATION', '安装标记与主密钥对应', () => {
    requireDirectory(options.stateDir);
    if (!key) throw Error('KEY');
    readManagedInstallation({ ...options, masterKey: key });
  });
  let pending = false;
  check('SETTINGS', '安装设置完整，待应用改动单独列出', () => {
    requireDirectory(path.join(options.stateDir, 'setup'));
    readPrivateText(path.join(options.stateDir, 'setup/configuration.json'));
    if (!key) throw Error('KEY');
    const store = new SetupConfigStore({ ...options, masterKey: key });
    const view = store.view();
    store.active(); // Verify encrypted secrets without exposing them.
    pending = view.pendingChanges || view.lastError !== null;
  });
  if (pending)
    checks.push({
      code: 'PENDING_SETTINGS',
      status: 'WARN',
      message: '仍有未生效设置或上次应用失败，请在首次设置页查看。',
    });
  check('RCLONE_CONFIG', '本实例云盘配置可读', () => {
    requireDirectory(path.join(options.stateDir, 'rclone'));
    readPrivateText(path.join(options.stateDir, 'rclone/rclone.conf'), MAX_RCLONE_CONFIG_BYTES);
  });
  let hasAdmin = false;
  const dbPath = path.join(options.stateDir, 'ptvault.db');
  if (!existing(dbPath))
    checks.push({
      code: 'DATABASE',
      status: 'WARN',
      message: '数据库尚未创建；首次启动服务后再检查。',
    });
  else
    check('DATABASE', '现有数据库只读完整性检查', () => {
      const stat = lstatSync(dbPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw Error('DB');
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        if (db.pragma('quick_check', { simple: true }) !== 'ok') throw Error('DB');
        if (Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()) !== 42)
          throw Error('SCHEMA');
        hasAdmin = db.prepare('SELECT 1 FROM admins LIMIT 1').get() !== undefined;
      } finally {
        db.close();
      }
    });
  check(
    'BOOTSTRAP',
    hasAdmin
      ? '初始管理员已存在，首次初始化已关闭；启动资料仍须完整'
      : '首次初始化链接有效期检查；过期可用 ptvault setup-link 更新（本检查不输出链接）',
    () => {
      requireDirectory(path.join(options.stateDir, 'setup'));
      const credential = readBootstrapCredential(options.stateDir);
      return hasAdmin || credential.expiresAt > Date.now() ? 'PASS' : 'WARN';
    },
  );
  check('RELEASE_FILES', '发行文件可读（不代替二进制执行及沙箱测试）', () => {
    for (const file of [
      'apps/web/dist/index.html',
      'apps/api/dist/cli/public.js',
      'runtime/node/bin/node',
      'runtime/bin/rclone',
      'runtime/bin/age',
      'runtime/bin/age-keygen',
      'runtime/archive/7zzs',
      'runtime/archive/archive-sandbox.py',
      'runtime/archive/probe/loader',
      'runtime/archive/probe/ffprobe',
      'runtime/baidu-client.json',
    ]) {
      const absolute = path.join(options.releaseRoot, file),
        stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('RUNTIME');
      const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      closeSync(fd);
    }
  });
  checks.push({
    code: 'CHECK_SCOPE',
    status: 'WARN',
    message:
      '本检查不改业务数据、不执行迁移；SQLite 可能维护正常 WAL/SHM 侧车。请由服务用户运行；文件写权限、云盘授权、挂载和播放需分别验收。',
  });
  return { ok: checks.every((item) => item.status !== 'FAIL'), checks };
}
