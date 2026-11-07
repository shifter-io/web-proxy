import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/install-tool.sh', import.meta.url));
const url = 'https://github.example/tool/releases/download/v1.2.3/tool.tgz';
const member = 'tool-v1.2.3/bin/tool';

// A fake curl, first on PATH, that appends the URL to calls.txt and copies FAKE_CURL_SRC to its -o file.
const fakeCurl = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CURL_CALLS, args[args.length - 1] + '\\n');
fs.copyFileSync(process.env.FAKE_CURL_SRC, args[args.indexOf('-o') + 1]);
`;
// A fake uname that prints FAKE_UNAME, so the tests do not depend on the machine running them.
const fakeUname = '#!/usr/bin/env sh\necho "$FAKE_UNAME"\n';

// A workspace with the fakes, a cache folder and a release tarball holding MEMBER (and README).
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'install-tool-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), fakeCurl);
  writeFileSync(join(bin, 'uname'), fakeUname);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'uname'), 0o755);
  const src = join(dir, 'src');
  mkdirSync(join(src, 'tool-v1.2.3', 'bin'), {recursive: true});
  writeFileSync(join(src, member), '#!/bin/sh\necho tool 1.2.3\n');
  chmodSync(join(src, member), 0o755);
  writeFileSync(join(src, 'tool-v1.2.3', 'README'), 'readme\n');
  const tarball = join(dir, 'tool.tgz');
  const tar = spawnSync('tar', ['-czf', tarball, '-C', src, 'tool-v1.2.3'], {encoding: 'utf8'});
  assert.equal(tar.status, 0, tar.stderr);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  return {dir, bin, cache: join(dir, 'cache'), tarball, sha256, calls: join(dir, 'calls.txt')};
}

function run(ws, {args, env: overrides = {}} = {}) {
  const env = {...process.env, PATH: `${ws.bin}:${process.env.PATH}`, CI_CACHE_DIR: ws.cache,
    FAKE_CURL_CALLS: ws.calls, FAKE_CURL_SRC: ws.tarball, FAKE_UNAME: 'Linux x86_64', ...overrides};
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const result = spawnSync('bash', [script, ...(args ?? ['tool', '1.2.3', ws.sha256, url, member])],
    {cwd: ws.dir, env, encoding: 'utf8'});
  const downloads = existsSync(ws.calls) ? readFileSync(ws.calls, 'utf8').trim().split('\n') : [];
  return {...result, downloads};
}

const tools = ws => join(ws.cache, 'web-proxy', 'tools');
const dest = ws => join(tools(ws), 'tool-1.2.3');

test('it downloads, verifies and unpacks the release once, then reuses the cache', t => {
  const ws = workspace(t);
  const first = run(ws);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `${join(dest(ws), member)}\n`);
  assert.deepEqual(first.downloads, [url]);
  assert.ok(existsSync(join(dest(ws), '.complete')));
  assert.equal(existsSync(join(dest(ws), 'tool-v1.2.3', 'README')), false, 'only MEMBER is unpacked');
  assert.equal(spawnSync(first.stdout.trim(), {encoding: 'utf8'}).stdout, 'tool 1.2.3\n');
  assert.deepEqual(readdirSync(tools(ws)), ['tool-1.2.3'], 'no temporary folder is left');

  const second = run(ws);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(second.downloads, [url], 'the cached copy is not downloaded again');
});

test('a wrong checksum fails and leaves nothing in the cache', t => {
  const ws = workspace(t);
  const r = run(ws, {args: ['tool', '1.2.3', '0'.repeat(64), url, member]});
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(tools(ws)), []);
});

test('a leftover folder without .complete or without MEMBER is replaced', async t => {
  for (const [name, files] of [['no .complete', [member]], ['no MEMBER', ['.complete']]]) {
    await t.test(name, t => {
      const ws = workspace(t);
      for (const file of files) {
        mkdirSync(join(dest(ws), file, '..'), {recursive: true});
        writeFileSync(join(dest(ws), file), 'stale\n');
      }
      const r = run(ws);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.downloads, [url]);
      assert.equal(readFileSync(join(dest(ws), member), 'utf8'), '#!/bin/sh\necho tool 1.2.3\n');
      assert.ok(existsSync(join(dest(ws), '.complete')));
    });
  }
});

test('a MEMBER missing from the release fails', t => {
  const ws = workspace(t);
  const r = run(ws, {args: ['tool', '1.2.3', ws.sha256, url, 'tool-v1.2.3/bin/other']});
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(dest(ws)), false);
});

test('it refuses a machine other than x86_64 Linux before downloading', t => {
  const ws = workspace(t);
  const r = run(ws, {env: {FAKE_UNAME: 'Linux aarch64'}});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pinned for x86_64 Linux, not Linux aarch64/);
  assert.deepEqual(r.downloads, []);
});

test('a missing CI_CACHE_DIR fails before downloading', t => {
  const ws = workspace(t);
  const r = run(ws, {env: {CI_CACHE_DIR: undefined}});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the runner must set CI_CACHE_DIR/);
  assert.deepEqual(r.downloads, []);
});

test('a wrong number of arguments is a usage error', t => {
  const ws = workspace(t);
  const r = run(ws, {args: ['tool', '1.2.3']});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: install-tool\.sh NAME VERSION SHA256 URL MEMBER/);
  assert.deepEqual(r.downloads, []);
});
