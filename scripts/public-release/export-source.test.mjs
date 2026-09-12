import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportPublicSource, PUBLIC_FILES, PUBLIC_TREES } from './export-source.mjs';

function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ptvault-export-'));
  const root = path.join(base, 'source');
  const output = path.join(base, 'output');
  mkdirSync(root);
  const put = (name, text = '// public source\n') => {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, text);
  };
  for (const name of PUBLIC_FILES) put(name);
  for (const tree of PUBLIC_TREES) put(`${tree.directory}/fixture${tree.extensions[0]}`);
  const font = Buffer.alloc(48); font.write('wOF2'); put('apps/web/public/fonts/fixture.woff2',font);
  put('scripts/public-release/templates/vite.config.ts');
  put('package.json', JSON.stringify({name:'pt-cloud-vault',private:true,workspaces:['apps/*','packages/*','deploy']}));
  put('package-lock.json', JSON.stringify({name:'pt-cloud-vault',lockfileVersion:3,packages:{'':{name:'pt-cloud-vault',workspaces:['apps/*','packages/*','deploy']},'node_modules/demo':{version:'1.2.3',resolved:'https://registry.npmmirror.com/demo/-/demo-1.2.3.tgz',integrity:'sha512-fixture'},'apps/api':{name:'@ptvault/api'},'deploy':{name:'@ptvault/deploy'}}}));
  return {base, root, output, put};
}

test('exports only reviewed product paths, preserving source and lock versions/integrity', async () => {
  const f = fixture();
  f.put('AGENTS.md', 'private instructions');
  f.put('.git/config', 'private history');
  f.put('进度/README.md', 'private deployment');
  f.put('apps/api/src/private.env', 'sensitive');
  f.put('apps/web/src/production.test.tsx', 'private test');
  f.put('apps/api/test/production.test.ts', 'private test');
  const before = readFileSync(path.join(f.root,'package-lock.json'));
  const result = await exportPublicSource({sourceRoot:f.root,destination:f.output,version:'0.1.0-dev.1'});
  assert.equal(result.version,'0.1.0-dev.1');
  for (const name of ['AGENTS.md','.git/config','进度/README.md','apps/api/src/private.env','apps/web/src/production.test.tsx','apps/api/test/production.test.ts']) assert.equal(existsSync(path.join(f.output,name)),false,name);
  const lock = JSON.parse(readFileSync(path.join(f.output,'package-lock.json'),'utf8'));
  assert.deepEqual(lock.packages['node_modules/demo'],{version:'1.2.3',resolved:'https://registry.npmjs.org/demo/-/demo-1.2.3.tgz',integrity:'sha512-fixture'});
  assert.deepEqual(readFileSync(path.join(f.root,'package-lock.json')),before);
  const manifest = JSON.parse(readFileSync(path.join(f.output,'PUBLIC_SOURCE_MANIFEST.json'),'utf8'));
  assert.equal(JSON.stringify(manifest).includes(f.root),false);
  for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(path.join(f.output,file.path))).digest('hex'),file.sha256);
  const second = path.join(f.base,'second');
  await exportPublicSource({sourceRoot:f.root,destination:second,version:'0.1.0-dev.1'});
  assert.deepEqual(readFileSync(path.join(second,'PUBLIC_SOURCE_MANIFEST.json')),readFileSync(path.join(f.output,'PUBLIC_SOURCE_MANIFEST.json')));
});

test('missing required source or unreviewed dependency host never produces a ready output', async () => {
  const f = fixture();
  const lock = JSON.parse(readFileSync(path.join(f.root,'package-lock.json'),'utf8'));
  lock.packages['node_modules/demo'].resolved='https://unreviewed.invalid/demo.tgz';
  f.put('package-lock.json',JSON.stringify(lock));
  await assert.rejects(exportPublicSource({sourceRoot:f.root,destination:f.output,version:'0.1.0'}),/PUBLIC_LOCK_URL/);
  assert.equal(existsSync(f.output),false);
  const empty = path.join(f.base,'empty'); mkdirSync(empty);
  await assert.rejects(exportPublicSource({sourceRoot:empty,destination:f.output,version:'0.1.0'}),/PUBLIC_REQUIRED/);
});

test('existing output and source are never overwritten', async () => {
  const f=fixture(); mkdirSync(f.output); writeFileSync(path.join(f.output,'keep'),'original');
  await assert.rejects(exportPublicSource({sourceRoot:f.root,destination:f.output,version:'0.1.0'}),/PUBLIC_DESTINATION_EXISTS/);
  assert.equal(readFileSync(path.join(f.output,'keep'),'utf8'),'original');
  await assert.rejects(exportPublicSource({sourceRoot:f.root,destination:path.join(f.root,'apps','api','src','out'),version:'0.1.0'}),/PUBLIC_DESTINATION_OVERLAP/);
});

test('secret-shaped source content is rejected without printing its value', async () => {
  const f=fixture(); const secret='ghp_'+'A'.repeat(36);
  f.put('apps/api/src/fixture.ts',`const token = '${secret}';`);
  await assert.rejects(exportPublicSource({sourceRoot:f.root,destination:f.output,version:'0.1.0'}),error => error.message.includes('PUBLIC_CONTENT_REVIEW') && !error.message.includes(secret));
  assert.equal(existsSync(f.output),false);
});

test('selected directory aliases cannot smuggle external files', async () => {
  const f=fixture(); const external=path.join(f.base,'external'); mkdirSync(external); writeFileSync(path.join(external,'leak.ts'),'external');
  symlinkSync(external,path.join(f.root,'apps','api','src','alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(exportPublicSource({sourceRoot:f.root,destination:f.output,version:'0.1.0'}),/PUBLIC_SOURCE_LINK/);
  assert.equal(existsSync(f.output),false);
});
