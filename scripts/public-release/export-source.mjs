import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Deliberately independent of Git's tracked files and the repository's private documents.
export const PUBLIC_FILES = Object.freeze([
  'README.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.base.json',
  'apps/api/package.json', 'apps/api/tsconfig.json', 'apps/api/tsconfig.build.json',
  'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/index.html',
  'packages/contracts/package.json', 'packages/contracts/tsconfig.json',
  'deploy/archive-sandbox.py',
  'apps/web/public/fonts/LICENSE.md',
  'apps/web/public/fonts/inter-OFL.txt', 'apps/web/public/fonts/jetbrains-OFL.txt', 'apps/web/public/fonts/bricolage-OFL.txt',
]);
export const PUBLIC_TREES = Object.freeze([
  { directory: 'apps/api/src', extensions: ['.ts'] },
  { directory: 'apps/web/src', extensions: ['.ts', '.tsx', '.css', '.svg'] },
  { directory: 'packages/contracts/src', extensions: ['.ts'] },
  { directory: 'apps/web/public/fonts', extensions: ['.woff2'] },
  { directory: 'scripts/public-release', extensions: ['.mjs', '.md', '.json', '.sh', '.ts', '.py', '.service', '.timer', '.yml'] },
]);
const failure = (code, relative = '') => new Error(`${code}${relative ? `: ${relative}` : ''}`);
const within = (child, parent) => child === parent || (path.relative(parent, child) !== '..' && !path.relative(parent, child).startsWith(`..${path.sep}`) && !path.isAbsolute(path.relative(parent, child)));
const digest = data => createHash('sha256').update(data).digest('hex');
const privateComponent = component => component.startsWith('.') || /^(?:node_modules|dist|coverage|fixtures|__fixtures__|__tests__|test|tests)$/i.test(component);
const excluded = relative => relative.split('/').some(privateComponent) || /(?:\.test|\.spec)\.[^.]+$/.test(relative);

function stableRead(root, relative) {
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw failure('PUBLIC_PATH_INVALID');
  let filename = root;
  for (const part of parts) {
    filename = path.join(filename, part);
    if (!existsSync(filename)) throw failure('PUBLIC_REQUIRED', relative);
    if (lstatSync(filename).isSymbolicLink()) throw failure('PUBLIC_SOURCE_LINK', relative);
  }
  const before = lstatSync(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 * 1024) throw failure('PUBLIC_SOURCE_FILE', relative);
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size || !stat.isFile()) throw failure('PUBLIC_SOURCE_CHANGED', relative);
    const buffer = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw failure('PUBLIC_SOURCE_CHANGED', relative);
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

function inventory(root) {
  const names = new Set(PUBLIC_FILES);
  for (const tree of PUBLIC_TREES) {
    const walk = relative => {
      const absolute = path.join(root, relative);
      if (!existsSync(absolute)) throw failure('PUBLIC_REQUIRED', relative);
      if (lstatSync(absolute).isSymbolicLink()) throw failure('PUBLIC_SOURCE_LINK', relative);
      for (const item of readdirSync(absolute, { withFileTypes: true })) {
        const name = `${relative}/${item.name}`;
        // Even an otherwise excluded alias is rejected, so a changed source tree is visible.
        if (item.isSymbolicLink()) throw failure('PUBLIC_SOURCE_LINK', name);
        if (excluded(name.slice(tree.directory.length + 1)) && tree.directory !== 'scripts/public-release') continue;
        if (privateComponent(item.name)) continue;
        if (item.isDirectory()) walk(name);
        else if (item.isFile() && tree.extensions.includes(path.extname(item.name))) names.add(name);
      }
    };
    walk(tree.directory);
  }
  return [...names].sort();
}

function inspectContent(relative, bytes) {
  if (relative.endsWith('.woff2')) {
    if (bytes.length < 48 || bytes.toString('ascii', 0, 4) !== 'wOF2') throw failure('PUBLIC_FONT_INVALID', relative);
    return;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure('PUBLIC_TEXT_INVALID', relative); }
  // These are rejection signals, not a claim to detect every credential or private identifier.
  const signals = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAGE-SECRET-KEY-1[0-9A-Z]{40,}\b/,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
    /[A-Za-z]:[\\/](?:Users|荷兰pt备份方案)[\\/]/i,
  ];
  if (signals.some(signal => signal.test(text))) throw failure('PUBLIC_CONTENT_REVIEW', relative);
}

export function normalizePublicLock(original, workspaces) {
  const lock = JSON.parse(original);
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw failure('PUBLIC_LOCK_FORMAT');
  lock.packages[''].workspaces = workspaces;
  delete lock.packages.deploy;
  delete lock.packages['node_modules/@ptvault/deploy'];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key.startsWith('deploy/node_modules/')) { delete lock.packages[key]; continue; }
    if (entry.link) {
      if (!workspaces.includes(entry.resolved)) throw failure('PUBLIC_LOCK_LINK');
      continue;
    }
    if (!entry.resolved) continue;
    let url;
    try { url = new URL(entry.resolved); } catch { throw failure('PUBLIC_LOCK_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['registry.npmmirror.com','registry.npmjs.org'].includes(url.hostname)) throw failure('PUBLIC_LOCK_URL');
    if (typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-/.test(entry.integrity)) throw failure('PUBLIC_LOCK_INTEGRITY');
    url.hostname = 'registry.npmjs.org'; entry.resolved = url.href;
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export async function exportPublicSource({ sourceRoot, destination, version }) {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(destination) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9][a-z0-9.-]*)?$/.test(version)) throw failure('PUBLIC_ARGUMENT_INVALID');
  const root = realpathSync(sourceRoot);
  destination = path.resolve(destination);
  if (destination === root || PUBLIC_TREES.some(tree => within(destination, path.join(root, tree.directory)))) throw failure('PUBLIC_DESTINATION_OVERLAP');
  if (existsSync(destination)) throw failure('PUBLIC_DESTINATION_EXISTS');
  const parent = path.dirname(destination);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw failure('PUBLIC_DESTINATION_PARENT');
  const files = new Map();
  for (const name of inventory(root)) { const bytes = stableRead(root, name); inspectContent(name, bytes); files.set(name, bytes); }
  const packageJson = JSON.parse(files.get('package.json').toString('utf8'));
  const workspaces = ['apps/api', 'apps/web', 'packages/contracts'];
  packageJson.workspaces = workspaces;
  packageJson.scripts = {
    build: 'npm run build --workspace=@ptvault/contracts && npm run build --workspace=@ptvault/api && npm run build --workspace=@ptvault/web',
    typecheck: 'npm run typecheck --workspace=@ptvault/contracts && npm run typecheck --workspace=@ptvault/api && npm run typecheck --workspace=@ptvault/web',
    'test:release': 'node --test scripts/public-release/*.test.mjs',
  };
  files.set('package.json', Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`));
  files.set('package-lock.json', Buffer.from(normalizePublicLock(files.get('package-lock.json').toString('utf8'), workspaces)));
  const template = files.get('scripts/public-release/templates/vite.config.ts');
  if (!template) throw failure('PUBLIC_REQUIRED', 'scripts/public-release/templates/vite.config.ts');
  files.set('apps/web/vite.config.ts', template);
  const workflow = files.get('scripts/public-release/templates/release-ci.yml');
  if (workflow) files.set('.github/workflows/release.yml', workflow);
  files.set('tsconfig.json', Buffer.from(`${JSON.stringify({extends:'./tsconfig.base.json',compilerOptions:{noEmit:true,declaration:false},include:['packages/contracts/src/**/*.ts']}, null, 2)}\n`));
  files.set('.gitignore', Buffer.from('node_modules/\n**/dist/\n.rt/\n.env\n*.db\n*.sqlite\n*.log\ncoverage/\n'));
  const rows = [...files].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,bytes]) => ({path:name,bytes:bytes.length,sha256:digest(bytes)}));
  const sourceDigest = digest(JSON.stringify(rows));
  const manifest = {schemaVersion:1,version,sourceDigest,scope:'REVIEWED_BUILD_SOURCE_NOT_PRIVATE_HISTORY',transformations:['public workspace commands','npm registry URL normalization; versions and integrity preserved','public Vite and root TypeScript configuration'],files:rows};
  // mkdir is exclusive: unlike rename, it cannot replace a concurrently created empty directory.
  // The manifest is the completion marker and is written last. An interrupted directory is kept
  // for diagnosis, never recursively deleted or reused by this tool.
  try { mkdirSync(destination, { mode:0o755 }); }
  catch (error) { if (error?.code === 'EEXIST') throw failure('PUBLIC_DESTINATION_EXISTS'); throw error; }
  for (const [name, bytes] of files) { const filename=path.join(destination,name); mkdirSync(path.dirname(filename),{recursive:true,mode:0o755}); writeFileSync(filename,bytes,{flag:'wx',mode:0o644}); }
  writeFileSync(path.join(destination,'PUBLIC_SOURCE_MANIFEST.json'),`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx',mode:0o644});
  return {version,sourceDigest,fileCount:rows.length};
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [destination, version, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || !destination || !version) throw failure('PUBLIC_ARGUMENT_INVALID');
    const result = await exportPublicSource({sourceRoot:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),destination,version});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch(error) {
    const message=error instanceof Error && error.message.startsWith('PUBLIC_') ? error.message : 'PUBLIC_EXPORT_FAILED';
    process.stderr.write(`${message}\n`); process.exitCode=1;
  }
}
