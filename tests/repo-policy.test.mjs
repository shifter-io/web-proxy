import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join('.github', 'scripts', 'repo-policy.sh');
const ci = '.github/workflows/ci.yml';
const checkout = 'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955';

// A workflow whose one job runs on `runsOn` and uses `uses`.
const workflow = (runsOn, uses = checkout) =>
  `on: push\njobs:\n  check:\n    runs-on: ${runsOn}\n    steps:\n      - uses: ${uses}\n`;

// A temporary repository holding a copy of the policy script and `files`, all tracked.
// GIT_CEILING_DIRECTORIES keeps git from finding an enclosing work tree.
function policy(t, files, {force = []} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-policy-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, dirname(scriptPath)), {recursive: true});
  copyFileSync(join(repo, scriptPath), join(dir, scriptPath));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), {recursive: true});
    writeFileSync(join(dir, path), content);
  }
  const env = {...process.env, GIT_CEILING_DIRECTORIES: dirname(dir)};
  const git = args => assert.equal(spawnSync('git', args, {cwd: dir, env}).status, 0, `git ${args.join(' ')}`);
  git(['init', '-q']);
  git(['add', '-A']);
  if (force.length) git(['add', '-f', ...force]);
  return spawnSync('bash', [scriptPath], {cwd: dir, env, encoding: 'utf8'});
}

function assertPasses(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /repository policy: all checks passed/);
}

function assertFails(result, file) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::/);
  assert.ok(result.stdout.includes(file), result.stdout);
}

for (const size of [2, 4, 8, 16, 32]) {
  test(`accepts [self-hosted, ci-${size}cpu]`, t => {
    assertPasses(policy(t, {[ci]: workflow(`[self-hosted, ci-${size}cpu]`)}));
  });
}

for (const size of [8, 16, 32]) {
  test(`accepts the size input with the ci-${size}cpu default`, t => {
    const runsOn = `[self-hosted, "\${{ inputs.size || 'ci-${size}cpu' }}"]`;
    assertPasses(policy(t, {[ci]: workflow(runsOn)}));
  });
}

test('accepts ubuntu-latest in the two Maestro workflows', t => {
  assertPasses(policy(t, {
    [ci]: workflow('[self-hosted, ci-2cpu]'),
    '.github/workflows/maestro-policy.yml': workflow('ubuntu-latest'),
    '.github/workflows/maestro-queue.yml': workflow('ubuntu-latest'),
  }));
});

const rejectedRunners = {
  'ci-64cpu': '[self-hosted, ci-64cpu]',
  'ubuntu-latest outside the Maestro workflows': 'ubuntu-latest',
  '[self-hosted] alone': '[self-hosted]',
  'another expression': '[self-hosted, "${{ matrix.runner }}"]',
  'the size input with a ci-4cpu default': `[self-hosted, "\${{ inputs.size || 'ci-4cpu' }}"]`,
};

for (const [name, runsOn] of Object.entries(rejectedRunners)) {
  test(`rejects ${name} and names the file and line`, t => {
    const result = policy(t, {[ci]: workflow(runsOn)});
    assertFails(result, `${ci}:4: runs-on must be`);
  });
}

test('rejects ubuntu-latest in a workflow named like a Maestro one', t => {
  const file = '.github/workflows/maestro-policy-copy.yml';
  assertFails(policy(t, {[file]: workflow('ubuntu-latest')}), `${file}:4:`);
});

test('prints every runs-on finding before exiting', t => {
  const result = policy(t, {
    [ci]: workflow('[self-hosted, ci-64cpu]'),
    '.github/workflows/other.yml': workflow('ubuntu-latest'),
  });
  assertFails(result, `${ci}:4:`);
  assert.ok(result.stdout.includes('.github/workflows/other.yml:4:'), result.stdout);
});

test('rejects an action pinned to a tag, Maestro workflows included', t => {
  const file = '.github/workflows/maestro-queue.yml';
  assertFails(policy(t, {[file]: workflow('ubuntu-latest', 'actions/checkout@v7')}), file);
});

test('a key that ends in uses: is not an action', t => {
  const content = `permissions:\n  statuses: read\n${workflow('[self-hosted, ci-2cpu]')}`;
  assertPasses(policy(t, {[ci]: content}));
});

test('rejects a tracked file that matches .gitignore', t => {
  const result = policy(t, {[ci]: workflow('[self-hosted, ci-2cpu]'), '.gitignore': '*.env\n', 'local.env': 'A=1\n'},
    {force: ['local.env']});
  assertFails(result, 'local.env');
});

test('rejects a private key block', t => {
  const key = ['-----BEGIN RSA PRIV', 'ATE KEY-----\n'].join('');
  assertFails(policy(t, {[ci]: workflow('[self-hosted, ci-2cpu]'), 'key.txt': key}), 'key.txt');
});

test('rejects a home-directory path', t => {
  const path = ['', 'home', 'someone', 'project\n'].join('/');
  assertFails(policy(t, {[ci]: workflow('[self-hosted, ci-2cpu]'), 'notes.txt': path}), 'notes.txt');
});

test('rejects pull_request_target', t => {
  const content = workflow('[self-hosted, ci-2cpu]').replace('on: push', 'on: pull_request_target');
  assertFails(policy(t, {[ci]: content}), ci);
});

test("passes on the repository's own tree", () => {
  const result = spawnSync('bash', [scriptPath], {cwd: repo, encoding: 'utf8'});
  assertPasses(result);
});
