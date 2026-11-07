import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/report-red.sh', import.meta.url));
const title = 'Nightly CI is red';
const token = 'ghs_fake-token-value';
const baseEnv = {
  GH_TOKEN: token,
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_SERVER_URL: 'https://github.example',
  GITHUB_RUN_ID: '4242',
  GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  GITHUB_REF_NAME: 'main',
  GITHUB_EVENT_NAME: 'schedule',
};

// A fake gh, first on PATH, that appends its arguments as one JSON line to calls.jsonl. `issue list`
// prints FAKE_GH_LIST; FAKE_GH_FAIL=list or create makes that command fail.
const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\\n');
const command = args[1];
if (process.env.FAKE_GH_FAIL === command) { process.stderr.write('gh: HTTP 502\\n'); process.exit(1); }
if (command === 'list') process.stdout.write(process.env.FAKE_GH_LIST ?? '[]');
if (command === 'create') process.stdout.write('https://github.example/owner/repo/issues/99\\n');
`;

function run(t, {args = [title], list = '[]', fail, env: overrides = {}} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'report-red-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), fakeGh);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = join(dir, 'calls.jsonl');
  const env = {...process.env, ...baseEnv, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_CALLS: calls, FAKE_GH_LIST: list, ...overrides};
  if (fail) env.FAKE_GH_FAIL = fail;
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  const result = spawnSync('bash', [script, ...args], {cwd: dir, env, encoding: 'utf8'});
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  assert.equal(`${result.stdout}${result.stderr}`.includes(token), false, 'the token was printed');
  return {...result, calls: recorded};
}

const flag = (args, name) => args[args.indexOf(name) + 1];

test('an open issue with exactly the title means no new issue, comment or label', t => {
  const list = JSON.stringify([{number: 3, title: `${title} (old)`}, {number: 7, title}]);
  const r = run(t, {list});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'already open: #7\n');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0], ['issue', 'list', '-R', 'owner/repo', '--state', 'open', '--search', `in:title ${title}`,
    '--json', 'number,title', '--limit', '100']);
});

test('without an exact title match it creates one issue that names the run', t => {
  const list = JSON.stringify([{number: 3, title: `${title} (old)`}, {number: 4, title: title.toLowerCase()}]);
  const r = run(t, {list});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2);
  const create = r.calls[1];
  assert.deepEqual(create.slice(0, 4), ['issue', 'create', '-R', 'owner/repo']);
  assert.equal(flag(create, '--title'), title);
  assert.deepEqual(create.filter(arg => arg.startsWith('--')).sort(), ['--body', '--title']);
  const body = flag(create, '--body');
  assert.match(body, /https:\/\/github\.example\/owner\/repo\/actions\/runs\/4242/);
  assert.match(body, /Event: schedule/);
  assert.match(body, /Ref: main/);
  assert.match(body, /Commit: 0123456\n/);
  assert.match(body, /The run's job summary lists the failed parts\. This never blocks pull requests\./);
});

test('a gh failure exits non-zero', async t => {
  for (const fail of ['list', 'create']) {
    await t.test(`gh issue ${fail} fails`, t => {
      const r = run(t, {fail});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /HTTP 502/);
    });
  }
  await t.test('gh prints no JSON', t => {
    const r = run(t, {list: 'not json'});
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.length, 1);
  });
});

test('a missing variable exits non-zero before calling gh', async t => {
  for (const name of Object.keys(baseEnv)) {
    await t.test(name, t => {
      const r = run(t, {env: {[name]: undefined}});
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`${name} must be set`));
      assert.deepEqual(r.calls, []);
    });
  }
});

test('a missing or empty title is a usage error', async t => {
  for (const args of [[], [''], ['a', 'b']]) {
    await t.test(JSON.stringify(args), t => {
      const r = run(t, {args});
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage: report-red\.sh TITLE/);
      assert.deepEqual(r.calls, []);
    });
  }
});
