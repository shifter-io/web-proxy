import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// .github/ciod/prefetch.sh against fake registries: local HTTP servers that serve the token, the
// image index, the manifest, the config and a layer, all content-addressed like the real ones.
const repo = fileURLToPath(new URL('..', import.meta.url));
const sha = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const blob = (mediaType, body) => ({mediaType, digest: sha(body), size: body.length});

const layer = Buffer.from('a layer of the fake Redis image');
const config = Buffer.from(JSON.stringify({architecture: 'amd64', os: 'linux', rootfs: {type: 'layers'}}));
const manifest = Buffer.from(JSON.stringify({
  schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: blob('application/vnd.oci.image.config.v1+json', config),
  layers: [blob('application/vnd.oci.image.layer.v1.tar+gzip', layer)],
}));
const other = Buffer.from('the arm64 manifest, never fetched');
const index = Buffer.from(JSON.stringify({
  schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    {...blob('application/vnd.oci.image.manifest.v1+json', other), platform: {os: 'linux', architecture: 'arm64'}},
    {...blob('application/vnd.oci.image.manifest.v1+json', manifest), platform: {os: 'linux', architecture: 'amd64'}},
    {...blob('application/vnd.oci.image.manifest.v1+json', other), platform: {os: 'unknown', architecture: 'unknown'}},
  ],
}));
const bodies = new Map([index, manifest, config, layer].map(body => [sha(body), body]));

// A registry serving REPO. mode: ok, down (503 for everything) or corrupt (the layer's bytes differ).
async function registry(t, repoName, mode) {
  const token = `token-for-${repoName}`;
  const server = createServer((req, res) => {
    server.requests += 1;
    const url = new URL(req.url, 'http://registry');
    if (mode === 'down') return res.writeHead(503).end();
    if (url.pathname === '/token' || url.pathname === '/token/') {
      if (url.searchParams.get('scope') !== `repository:${repoName}:pull`) return res.writeHead(400).end();
      return res.end(JSON.stringify({token}));
    }
    const match = url.pathname.match(/^\/v2\/(.+)\/(manifests|blobs)\/(sha256:[0-9a-f]{64})$/);
    if (!match || match[1] !== repoName || req.headers.authorization !== `Bearer ${token}`) {
      return res.writeHead(match ? 401 : 404).end();
    }
    let body = bodies.get(match[3]);
    if (!body) return res.writeHead(404).end();
    if (mode === 'corrupt' && body === layer) body = Buffer.from('tampered layer bytes');
    res.end(body);
  });
  server.requests = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {server, url: `http://127.0.0.1:${server.address().port}`};
}

// The hook in a temporary tree whose tests/redis-image.sh pins the fake index.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ciod-prefetch-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, 'repo/.github/ciod'), {recursive: true});
  mkdirSync(join(dir, 'repo/tests'));
  copyFileSync(join(repo, '.github/ciod/prefetch.sh'), join(dir, 'repo/.github/ciod/prefetch.sh'));
  const pin = readFileSync(join(repo, 'tests/redis-image.sh'), 'utf8')
    .replace(/^REDIS_INDEX_DIGEST=\S+$/m, `REDIS_INDEX_DIGEST=${sha(index)}`);
  assert.match(pin, new RegExp(sha(index)));
  writeFileSync(join(dir, 'repo/tests/redis-image.sh'), pin);
  const cache = join(dir, 'cache');
  const tools = join(cache, 'web-proxy/tools');
  return {dir, cache, tools, archive: join(tools, `redis-${sha(index).slice(7)}.tar`)};
}

function hook(f, hub, mirror) {
  const env = {...process.env, CI_CACHE_DIR: f.cache, HOME: join(f.cache, 'web-proxy'),
    REGISTRY_URL: hub.url, MIRROR_URL: mirror.url, AUTH_URL: `${hub.url}/token`};
  return new Promise(resolve => {
    const child = spawn('bash', [join(f.dir, 'repo/.github/ciod/prefetch.sh')], {env});
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => resolve({status, stdout, stderr}));
  });
}

const tarFile = (archive, name) => spawnSync('tar', ['-xOf', archive, name], {encoding: 'utf8'}).stdout;

test('the first run installs a verified OCI archive; the second finds it and makes no request', async t => {
  const f = fixture(t);
  const hub = await registry(t, 'library/redis', 'ok');
  const mirror = await registry(t, 'docker/library/redis', 'ok');
  const first = await hook(f, hub, mirror);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `redis image: installed now ${f.archive}\n`);
  assert.ok(existsSync(`${f.archive}.complete`));
  assert.equal(mirror.server.requests, 0);
  const names = spawnSync('tar', ['-tf', f.archive], {encoding: 'utf8'}).stdout.trim().split('\n').sort();
  const blobs = [manifest, config, layer].map(body => `blobs/sha256/${sha(body).slice(7)}`);
  assert.deepEqual(names.filter(name => !name.endsWith('/')), [...blobs, 'index.json', 'oci-layout'].sort());
  for (const body of [manifest, config, layer]) {
    assert.equal(tarFile(f.archive, `blobs/sha256/${sha(body).slice(7)}`), body.toString());
  }
  const layout = JSON.parse(tarFile(f.archive, 'index.json'));
  assert.equal(layout.manifests.length, 1);
  assert.equal(layout.manifests[0].digest, sha(manifest));
  assert.equal(layout.manifests[0].size, manifest.length);
  assert.equal(layout.manifests[0].annotations['io.containerd.image.name'], 'docker.io/web-proxy-ci/redis:7.4-alpine');
  assert.deepEqual(JSON.parse(tarFile(f.archive, 'oci-layout')), {imageLayoutVersion: '1.0.0'});

  const before = hub.server.requests;
  const second = await hook(f, hub, mirror);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `redis image: prefetched ${f.archive}\n`);
  assert.equal(hub.server.requests, before);
  assert.equal(mirror.server.requests, 0);
});

test('with Docker Hub down the mirror is used', async t => {
  const f = fixture(t);
  const hub = await registry(t, 'library/redis', 'down');
  const mirror = await registry(t, 'docker/library/redis', 'ok');
  const r = await hook(f, hub, mirror);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `redis image: installed now ${f.archive}\n`);
  assert.match(r.stderr, /redis image: http:\S+ failed; trying http:/);
  assert.equal(hub.server.requests, 1);
  assert.ok(mirror.server.requests > 0);
});

test('a digest mismatch fails, and with the mirror down nothing is left behind', async t => {
  const f = fixture(t);
  const hub = await registry(t, 'library/redis', 'corrupt');
  const mirror = await registry(t, 'docker/library/redis', 'down');
  const r = await hook(f, hub, mirror);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`redis image: digest mismatch for ${sha(layer)} from http:`));
  assert.match(r.stderr, /redis image: download failed from http:\S+ and http:/);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(f.tools), []);
});

test('a digest mismatch on Docker Hub falls back to the mirror', async t => {
  const f = fixture(t);
  const hub = await registry(t, 'library/redis', 'corrupt');
  const mirror = await registry(t, 'docker/library/redis', 'ok');
  const r = await hook(f, hub, mirror);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /digest mismatch/);
  assert.equal(tarFile(f.archive, `blobs/sha256/${sha(layer).slice(7)}`), layer.toString());
});

test('with both registries down it exits non-zero and leaves no partial file', async t => {
  const f = fixture(t);
  const hub = await registry(t, 'library/redis', 'down');
  const mirror = await registry(t, 'docker/library/redis', 'down');
  const r = await hook(f, hub, mirror);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /redis image: download failed from/);
  assert.equal(r.stdout, '');
  assert.deepEqual(readdirSync(f.tools), []);
  assert.equal(hub.server.requests, 1);
  assert.equal(mirror.server.requests, 1);
});
