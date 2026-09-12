import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { installShutdownSignals } from '../server.js';
import {
  initializePublic,
  inspectPublic,
  parsePublicArguments,
  publicSetupLink,
  startPublicRuntime,
} from '../onboarding/public-control.js';

export async function publicMain(args = process.argv.slice(2)): Promise<void> {
  try {
    const options = parsePublicArguments(args);
    switch (options.command) {
      case 'help':
        process.stdout.write(
          'PTVault 公开安装管理（内部运行入口）\n用法：node apps/api/dist/cli/public.js init | run | setup-link | doctor\n选项：--state-dir ABS --master-key-file ABS --release-root ABS --media-export-root ABS\n仅 init：--port 3210\n普通安装请使用发行包 install.sh；安装后的 ptvault 提供 status、doctor、setup-link、upgrade、uninstall。\ninit 保留已有数据；setup-link 仅用于尚未创建管理员的安装。\n',
        );
        return;
      case 'init':
        await initializePublic(options, process.env);
        process.stdout.write(
          '安装资料已初始化或核验，已有密钥与配置保持。请启动服务，再运行 ptvault setup-link 获取首次设置链接。\n',
        );
        return;
      case 'setup-link':
        // Only this explicit interactive command prints the fragment credential.
        process.stdout.write(`${await publicSetupLink(options, process.env)}\n`);
        return;
      case 'doctor': {
        const result = inspectPublic(options, process.env);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      case 'run': {
        const control: {
          instance?: Awaited<ReturnType<typeof startPublicRuntime>>;
          dispose?: () => void;
        } = {};
        let fatal = false;
        const stop = async () => {
          control.dispose?.();
          await control.instance?.stop();
        };
        control.instance = await startPublicRuntime(options, process.env, () => {
          fatal = true;
          process.exitCode = 1;
          process.stderr.write(
            'SETUP_RUNTIME_UNAVAILABLE：服务应用失败，正在安全停止；请先查看设置与服务状态。\n',
          );
          void stop().catch(() => {
            process.exitCode = 1;
          });
        });
        control.dispose = installShutdownSignals(stop);
        if (fatal) await stop();
        return;
      }
    }
  } catch (error) {
    const allowed = new Set([
      'SETUP_ARGUMENT_INVALID',
      'SETUP_BUSY',
      'SETUP_EXISTING_INSTALLATION',
      'SETUP_MASTER_KEY_MISSING',
      'SETUP_MASTER_KEY_INVALID',
      'SETUP_MASTER_KEY_MISMATCH',
      'SETUP_PORT_MISMATCH',
      'SETUP_CONFIG_MISSING',
      'SETUP_CLOSED',
      'SETUP_FILE_NOT_PRIVATE',
      'SETUP_FILE_UNSAFE',
      'SETUP_PLATFORM_UNSUPPORTED',
    ]);
    const code =
      error instanceof Error && allowed.has(error.message) ? error.message : 'SETUP_COMMAND_FAILED';
    if (code === 'SETUP_CLOSED') {
      process.stderr.write('SETUP_CLOSED：管理员已经创建，请使用正常登录；不会生成绕过现有账户的初始化链接。\n');
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `${code}：操作未完成；未重置已有密钥、账户或任务。请核对参数与原安装资料。\n`,
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync.native(process.argv[1])).href)
  void publicMain();
