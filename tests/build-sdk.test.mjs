// Runs scripts/build-sdk.mjs itself against a temporary copy of the SDK tree.
// No argument: verify the newest release against source and write nothing. A version: publish new files only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const sha256 = text => createHash('sha256').update(text).digest('hex');

async function tree(t) {
  const root = await mkdtemp(join(tmpdir(), 'build-sdk-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'web/sdk/src'), {recursive: true});
  await mkdir(join(root, 'web/sdk/releases'));
  await copyFile(join(repo, 'scripts/build-sdk.mjs'), join(root, 'scripts/build-sdk.mjs'));
  const sdk = path => join(root, 'web/sdk', path);
  const source = (captcha, client) => Promise.all([
    writeFile(sdk('src/captcha.js'), captcha), writeFile(sdk('src/client.js'), client),
  ]);
  function run(...args) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/build-sdk.mjs'), ...args], {encoding: 'utf8', timeout: 30_000});
    return {...result, output: result.stdout + result.stderr};
  }
  async function snapshot(dir = sdk('releases'), files = {}) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { files[relative(root, path)] = 'directory'; await snapshot(path, files); }
      else files[relative(root, path)] = await readFile(path, 'utf8');
    }
    return files;
  }
  return {sdk, source, run, snapshot};
}

// Two published releases whose sources differ, plus a non-release folder the script must ignore.
async function published(t) {
  const sdk = await tree(t);
  await sdk.source('export const captcha = 9;\n', 'export const client = 9;\n');
  assert.equal(sdk.run('1.0.9').status, 0);
  await sdk.source('export const captcha = 10;\n', 'export const client = 10;\n');
  assert.equal(sdk.run('1.0.10').status, 0);
  await mkdir(sdk.sdk('releases/notes'));
  return sdk;
}

test('with no argument the newest release (1.0.10, not 1.0.9) is verified against source and nothing is written', async t => {
  const sdk = await published(t);
  const before = await sdk.snapshot();
  const result = sdk.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.stdout, 'SDK release 1.0.10 verified\n');
  assert.deepEqual(await sdk.snapshot(), before);
});

test('with no argument changed source fails and nothing is written', async t => {
  const sdk = await published(t);
  await writeFile(sdk.sdk('src/client.js'), 'export const client = 11;\n');
  const before = await sdk.snapshot();
  const result = sdk.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Release 1\.0\.10 already exists with different content\. Publish a new version\./);
  assert.deepEqual(await sdk.snapshot(), before);
});

test('with no argument a missing asset or manifest fails and is not recreated', async t => {
  const sdk = await published(t);
  await unlink(sdk.sdk('releases/1.0.10/captcha.js'));
  let before = await sdk.snapshot();
  let result = sdk.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Release 1\.0\.10 is missing captcha\.js\./);
  assert.deepEqual(await sdk.snapshot(), before);

  await writeFile(sdk.sdk('releases/1.0.10/captcha.js'), 'export const captcha = 10;\n');
  await unlink(sdk.sdk('releases/1.0.10/manifest.json'));
  before = await sdk.snapshot();
  result = sdk.run();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Release 1\.0\.10 manifest does not match its assets\./);
  assert.deepEqual(await sdk.snapshot(), before);
});

test('a manifest that does not match its assets fails with or without a version', async t => {
  const sdk = await published(t);
  const path = sdk.sdk('releases/1.0.10/manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.sha256['client.js'] = sha256('something else');
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  const before = await sdk.snapshot();
  for (const args of [[], ['1.0.10']]) {
    const result = sdk.run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Release 1\.0\.10 manifest does not match its assets\./);
  }
  assert.deepEqual(await sdk.snapshot(), before);
});

test('publishing a new version writes the source files and their manifest', async t => {
  const sdk = await published(t);
  await sdk.source('export const captcha = 12;\n', 'export const client = 12;\n');
  await writeFile(sdk.sdk('src/README.md'), 'not shipped\n');
  const result = sdk.run('1.0.12');
  assert.equal(result.status, 0, result.output);
  assert.equal(result.stdout, 'SDK release 1.0.12 verified\n');
  assert.deepEqual((await readdir(sdk.sdk('releases/1.0.12'))).sort(), ['captcha.js', 'client.js', 'manifest.json']);
  assert.equal(await readFile(sdk.sdk('releases/1.0.12/client.js'), 'utf8'), 'export const client = 12;\n');
  assert.equal(await readFile(sdk.sdk('releases/1.0.12/manifest.json'), 'utf8'), JSON.stringify({
    version: '1.0.12', protocolVersion: 1,
    sha256: {'captcha.js': sha256('export const captcha = 12;\n'), 'client.js': sha256('export const client = 12;\n')},
  }, null, 2) + '\n');

  // Publishing the same version again with the same source only verifies it.
  const before = await sdk.snapshot();
  assert.equal(sdk.run('1.0.12').status, 0);
  assert.equal(sdk.run().stdout, 'SDK release 1.0.12 verified\n');
  assert.deepEqual(await sdk.snapshot(), before);
});

test('republishing an existing version with different content fails and overwrites nothing', async t => {
  const sdk = await published(t);
  await writeFile(sdk.sdk('src/captcha.js'), 'export const captcha = 11;\n');
  const before = await sdk.snapshot();
  const result = sdk.run('1.0.10');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Release 1\.0\.10 already exists with different content\. Publish a new version\./);
  assert.deepEqual(await sdk.snapshot(), before);
});

test('a version that is not semantic, or no release at all, is refused', async t => {
  const sdk = await tree(t);
  await sdk.source('export const captcha = 1;\n', 'export const client = 1;\n');
  for (const args of [['v1.0.13'], ['1.0'], []]) {
    const result = sdk.run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Pass a semantic release version\./);
  }
  assert.deepEqual(await sdk.snapshot(), {});
});

test('the repository newest release matches its source when the script verifies it', () => {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/build-sdk.mjs')], {encoding: 'utf8', timeout: 30_000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^SDK release \d+\.\d+\.\d+ verified\n$/);
});
