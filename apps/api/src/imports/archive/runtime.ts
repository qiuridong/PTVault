import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { archiveAssert } from './inspection.js';
export async function validateArchiveRuntime(config: {
  binary: string;
  sandboxHelper: string;
  probeRuntimeRoot: string;
}): Promise<void> {
  archiveAssert(process.platform === 'linux', 'ARCHIVE_SANDBOX_UNAVAILABLE');
  const files = [
    config.binary,
    config.sandboxHelper,
    path.join(config.probeRuntimeRoot, 'loader'),
    path.join(config.probeRuntimeRoot, 'ffprobe'),
  ];
  const libraryRoot = path.join(config.probeRuntimeRoot, 'lib');
  files.push(...(await readdir(libraryRoot)).map((name) => path.join(libraryRoot, name)));
  for (const filename of files) {
    const info = await lstat(filename);
    archiveAssert(
      info.isFile() &&
        !info.isSymbolicLink() &&
        info.uid === 0 &&
        (info.mode & 0o022) === 0 &&
        (await realpath(filename)) === filename,
      'ARCHIVE_RUNTIME_UNSAFE',
    );
    let parent = path.dirname(filename);
    for (;;) {
      const dir = await lstat(parent);
      archiveAssert(
        dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === 0 && (dir.mode & 0o022) === 0,
        'ARCHIVE_RUNTIME_UNSAFE',
      );
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
}
