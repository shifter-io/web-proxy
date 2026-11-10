import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/changed-scope.sh', import.meta.url));

// Runs changed-scope.sh with bash, the changed files one per line on stdin.
function scope(files, args = ['pull_request']) {
  const input = files.length ? `${files.join('\n')}\n` : '';
  return spawnSync('bash', [script, ...args], {input, encoding: 'utf8'});
}

function expect(files, {rust, node, audit}, args) {
  const r = scope(files, args);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `rust=${rust}\nnode=${node}\naudit=${audit}\n`);
}

const all = {rust: true, node: true, audit: true};

test('documentation alone runs nothing', () => {
  expect(['README.md', 'docs/x.html', 'ENGINEERING.md'], {rust: false, node: false, audit: false});
});

test('a Rust source file runs rust and node', () => {
  expect(['src/main.rs'], {rust: true, node: true, audit: false});
});

test('the npm lockfile runs audit and node, not rust', () => {
  expect(['package-lock.json'], {rust: false, node: true, audit: true});
});

test('any .github file runs everything', () => {
  expect(['.github/workflows/ci.yml'], all);
  expect(['.github/scripts/changed-scope.sh'], all);
});

test('examples are not documentation: they run node', () => {
  expect(['examples/shifter-credentials.example.toml'], {rust: false, node: true, audit: false});
});

test('an empty list runs everything', () => {
  expect([], all);
  expect(['', ''], all);
});

test('any event other than pull_request runs everything', () => {
  for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch']) {
    expect(['README.md'], all, [event]);
    expect([], all, [event]);
  }
});

test('no argument exits 2 with the usage line', () => {
  const r = scope(['README.md'], []);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^usage: changed-scope\.sh <event-name>/);
});
