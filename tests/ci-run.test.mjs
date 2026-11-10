import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const scripts = ['.github/scripts/ci-run.sh', '.github/scripts/ci-parts.sh'];

// Every tool ci-run.sh calls is this stub: it logs its command line and fails (exit 7) when the line
// starts with $STUB_FAIL.
const stub = `#!/bin/sh
line="$(basename "$0") $*"
echo "$line" >> "$STUB_LOG"
if [ -n "$STUB_FAIL" ]; then
  case "$line" in "$STUB_FAIL"*) echo "stub failed: $line"; exit 7 ;; esac
fi
`;

// A renderer that leaves the docs alone, or makes them stale when $STALE is set.
const renderer = `import os, pathlib
if os.environ.get("STALE"):
    pathlib.Path("docs/readme.html").write_text("stale\\n")
`;

const docsRule = 'skipped: only documentation changed (.github/scripts/changed-scope.sh)';
const rustRule = 'skipped: no Rust input changed (.github/scripts/changed-scope.sh)';
const packageRule = 'skipped: package files did not change (.github/scripts/changed-scope.sh)';

// Runs ci-run.sh in a temporary committed repository whose tools are stubs.
function run(t, vars) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-run-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const work = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const files = {
    '.github/scripts/repo-policy.sh': 'echo "$0" >> "$STUB_LOG"\n',
    'scripts/render-readme.py': renderer,
    'docs/readme.html': 'readme\n',
    'docs/engineering.html': 'engineering\n',
    'tests/a.test.mjs': '',
    'tests/slow/b.test.mjs': '',
  };
  for (const path of scripts) {
    mkdirSync(dirname(join(work, path)), {recursive: true});
    copyFileSync(join(repo, path), join(work, path));
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, path)), {recursive: true});
    writeFileSync(join(work, path), content);
  }
  mkdirSync(bin);
  for (const tool of ['cargo', 'npm', 'node', 'actionlint']) {
    writeFileSync(join(bin, tool), stub);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = {
    ...process.env, GIT_CEILING_DIRECTORIES: dir, PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: join(dir, 'calls.log'), STUB_FAIL: '', ACTIONLINT: join(bin, 'actionlint'),
    CI_EVIDENCE: join(dir, 'ev'), RUNNER_TEMP: join(dir, 'tmp'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    SCOPE_RUST: 'true', SCOPE_NODE: 'true', SCOPE_AUDIT: 'true', MODE: 'full', NEXTEST_PROFILE: 'full',
    EVENT: 'merge_group', ...vars,
  };
  delete env.STALE;
  if (vars.STALE) env.STALE = vars.STALE;
  const git = args => assert.equal(spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args],
    {cwd: work, env}).status, 0, `git ${args.join(' ')}`);
  git(['init', '-q']);
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  mkdirSync(env.RUNNER_TEMP);
  const result = spawnSync('bash', [join(work, scripts[0])], {cwd: work, env, encoding: 'utf8', timeout: 60_000});
  const calls = existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, 'utf8').trim().split('\n').sort() : [];
  const summary = existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '';
  const parts = Object.fromEntries(summary.split('\n').filter(line => /^\| [a-z]/.test(line) && !line.startsWith('| Part'))
    .map(line => line.split(' | ').slice(0, 2).map(cell => cell.replace(/^\| /, ''))));
  return {...result, calls, parts};
}

test('the merge queue runs every part in full mode except npm-audit', t => {
  const r = run(t, {});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(Object.keys(r.parts), ['policy', 'docs', 'actionlint', 'fmt', 'clippy', 'rust-test', 'npm-ci',
    'node-test', 'vendor', 'npm-audit']);
  for (const name of Object.keys(r.parts).slice(0, -1)) assert.equal(r.parts[name], 'passed', name);
  assert.match(r.parts['npm-audit'], /^skipped: dependency audits run on PRs that change package files, on dispatch/);
  assert.ok(r.calls.includes('cargo nextest run --locked --profile full --target-dir target/test'), r.calls.join('\n'));
  assert.ok(r.calls.includes('cargo clippy --all-targets --locked --target-dir target/clippy -- -D warnings'));
  assert.ok(r.calls.includes('npm ci --ignore-scripts --no-audit --no-fund --prefer-offline'));
  assert.ok(r.calls.includes('node scripts/vendor.mjs'));
  const nodeTest = r.calls.find(call => call.startsWith('node --test'));
  assert.match(nodeTest, /--test-timeout=90000 /);
  assert.match(nodeTest, / tests\/a\.test\.mjs tests\/slow\/b\.test\.mjs$/);
  assert.ok(!r.calls.some(call => call.startsWith('npm audit')));
});

test('a pull request in fast mode leaves out the slow test files', t => {
  const r = run(t, {EVENT: 'pull_request', MODE: 'fast', NEXTEST_PROFILE: 'ci'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.calls.find(call => call.startsWith('node --test')), / tests\/a\.test\.mjs$/);
  assert.ok(r.calls.includes('cargo nextest run --locked --profile ci --target-dir target/test'));
  assert.ok(r.calls.includes('npm audit --audit-level=high --package-lock-only'));
  assert.equal(r.parts['npm-audit'], 'passed');
});

test('a documentation-only pull request runs policy, docs and actionlint and names the skip rule', t => {
  const r = run(t, {EVENT: 'pull_request', MODE: 'fast', NEXTEST_PROFILE: 'ci', SCOPE_RUST: 'false',
    SCOPE_NODE: 'false', SCOPE_AUDIT: 'false'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([r.parts.policy, r.parts.docs, r.parts.actionlint], ['passed', 'passed', 'passed']);
  for (const name of ['fmt', 'clippy', 'rust-test', 'npm-ci', 'node-test', 'vendor', 'npm-audit']) {
    assert.equal(r.parts[name], docsRule, name);
  }
  assert.ok(!r.calls.some(call => /^(cargo|npm|node) /.test(call)), r.calls.join('\n'));
});

test('a pull request without Rust or package changes names those rules', t => {
  const r = run(t, {EVENT: 'pull_request', MODE: 'fast', NEXTEST_PROFILE: 'ci', SCOPE_RUST: 'false', SCOPE_AUDIT: 'false'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ['fmt', 'clippy', 'rust-test']) assert.equal(r.parts[name], rustRule, name);
  assert.equal(r.parts['npm-audit'], packageRule);
  assert.equal(r.parts['node-test'], 'passed');
});

test('a manual run audits the dependencies', t => {
  const r = run(t, {EVENT: 'workflow_dispatch'});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.parts['npm-audit'], 'passed');
});

test('a failed npm ci fails the run and the parts after it do not run', t => {
  const r = run(t, {STUB_FAIL: 'npm ci'});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.parts['npm-ci'], 'failed (exit 7)');
  assert.equal(r.parts['node-test'], 'not run: npm-ci failed');
  assert.equal(r.parts.vendor, 'not run: node-test failed');
  assert.equal(r.parts['rust-test'], 'passed');
  assert.match(r.stdout, /::group::npm-ci failed\nstub failed: npm ci/);
});

test('stale documentation fails the docs part', t => {
  const r = run(t, {STALE: '1'});
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.parts.docs, 'failed (exit 1)');
  assert.match(r.stdout, /docs\/readme\.html or docs\/engineering\.html is stale/);
});

test('a missing variable is a usage error', t => {
  const r = run(t, {MODE: ''});
  assert.equal(r.status, 2);
  assert.match(r.stderr, /MODE must be set/);
});
