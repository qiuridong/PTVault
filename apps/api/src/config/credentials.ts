import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * systemd 用 `LoadCredential=master.key:/etc/ptvault/master.key` 把主密钥以只读方式暴露在
 * `$CREDENTIALS_DIRECTORY/master.key`（unit 里写作 `%d/master.key`）。凭据文件本身是
 * root 拥有、`-r--------`，服务用户读不到源文件，只能读 systemd 挂进来的这份副本。
 *
 * 这样主密钥既不进 `Environment=`（不会出现在 `systemctl show` / `/proc/<pid>/environ`），
 * 也不需要额外的 ExecStartPre wrapper——进程启动时自己读一次即可。
 */
export const MASTER_KEY_CREDENTIAL_NAME = 'master.key';

export type CredentialEffects = {
  readFile: (filePath: string) => string;
};

function readCredentialFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/**
 * 返回补齐了 `PTVAULT_MASTER_KEY` 的环境副本。**不改动传入对象**，因此既能给 `process.env`
 * 用，也能给测试注入的假环境用。
 *
 * 优先级：显式 `PTVAULT_MASTER_KEY` > systemd credential。凭据缺席时原样返回，让
 * `parseConfig` 抛出它一贯的「缺 key」错误，而不是在这里换一种说法。
 */
export function resolveMasterKeyCredential(
  env: NodeJS.ProcessEnv,
  effects: Partial<CredentialEffects> = {},
): NodeJS.ProcessEnv {
  if (env.PTVAULT_MASTER_KEY) return env;

  const directory = env.CREDENTIALS_DIRECTORY;
  if (!directory) return env;

  const readFile = effects.readFile ?? readCredentialFile;
  let contents: string;
  try {
    contents = readFile(path.join(directory, MASTER_KEY_CREDENTIAL_NAME));
  } catch (error) {
    // 凭据不存在 → 交回 parseConfig 报缺 key。权限/IO 错误必须炸，否则会静默无钥启动。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return env;
    throw error;
  }

  const masterKey = contents.trim();
  if (masterKey === '') throw new Error('PTVAULT_MASTER_KEY credential is empty');

  return { ...env, PTVAULT_MASTER_KEY: masterKey };
}
