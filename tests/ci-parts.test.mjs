import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const lib = fileURLToPath(new URL('../.github/scripts/ci-parts.sh', import.meta.url));

// Runs `script` in bash under set -euo pipefail after sourcing the library, in a temporary folder.
function run(t, script, {summary = true, evidence = true} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-parts-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const env = {...process.env, LIB: lib};
  delete env.GITHUB_STEP_SUMMARY;
  delete env.CI_EVIDENCE;
  if (evidence) env.CI_EVIDENCE = join(dir, 'evidence');
  if (summary) env.GITHUB_STEP_SUMMARY = join(dir, 'summary.md');
  const started = Date.now();
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsource "$LIB"\n${script}`],
    {cwd: dir, env, encoding: 'utf8', timeout: 30_000});
  const parts = join(dir, 'evidence', 'parts');
  const read = name => readFileSync(join(parts, name), 'utf8');
  const table = summary && existsSync(env.GITHUB_STEP_SUMMARY) ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '';
  return {...result, dir, parts, read, table, ms: Date.now() - started};
}

// The table's data rows as [part, result] pairs, in table order.
const rows = table => table.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Part') && !line.startsWith('| ---'))
  .map(line => line.split(' | ').map(cell => cell.replace(/^\| /, '').replace(/ \|$/, '')).slice(0, 2));

test('two parts run in parallel and each writes its log, time and status', t => {
  const r = run(t, 'part one sh -c "sleep 2; echo first"\npart two sh -c "sleep 2; echo second >&2"\nparts_wait');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.ms < 3500, `took ${r.ms} ms; the parts did not run in parallel`);
  assert.deepEqual(rows(r.table), [['one', 'passed'], ['two', 'passed']]);
  assert.equal(r.read('one.log'), 'first\n');
  assert.equal(r.read('two.log'), 'second\n');
  assert.equal(r.read('one.rc'), '0\n');
  const [start, end] = r.read('one.time').trim().split('\n').map(Number);
  assert.ok(end - start >= 1 && end - start <= 3, r.read('one.time'));
  assert.match(r.table, /^\| Part \| Result \| Seconds \|\n\| --- \| --- \| --- \|\n/);
});

test('a failing part fails parts_wait and its log is printed in a group', t => {
  const r = run(t, 'part ok true\npart bad sh -c "echo boom; exit 3"\nif parts_wait; then echo WAIT=0; else echo WAIT=$?; fi');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WAIT=1/);
  assert.deepEqual(rows(r.table), [['ok', 'passed'], ['bad', 'failed (exit 3)']]);
  assert.match(r.stdout, /::group::bad failed\nboom\n::endgroup::/);
  assert.doesNotMatch(r.stdout, /::group::ok/);
});

test('a failure inside a pipeline or early in a function fails its part', t => {
  const r = run(t, [
    'piped() { false | cat; }',
    'early() { false; echo after; }',
    'part piped piped',
    'part early early',
    'if parts_wait; then echo WAIT=0; else echo WAIT=$?; fi',
  ].join('\n'));
  assert.match(r.stdout, /WAIT=1/, r.stderr);
  assert.deepEqual(rows(r.table), [['piped', 'failed (exit 1)'], ['early', 'failed (exit 1)']]);
  assert.equal(r.read('early.log'), '');
});

test('a part killed with kill -9 reports no result', t => {
  const r = run(t, 'part killed bash -c \'kill -9 "$PPID"\'\nif parts_wait; then echo WAIT=0; else echo WAIT=$?; fi');
  assert.match(r.stdout, /WAIT=1/, r.stderr);
  assert.deepEqual(rows(r.table), [['killed', 'no result (crashed or killed)']]);
  assert.equal(existsSync(join(r.parts, 'killed.rc')), false);
});

test('part_after runs its command only after its dependency passed', t => {
  const r = run(t, 'part build sh -c "sleep 1; echo built > artifact"\npart_after build use cat artifact\nparts_wait');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(rows(r.table), [['build', 'passed'], ['use', 'passed']]);
  assert.equal(r.read('use.log'), 'built\n');
});

test('part_after after a failed dependency is not run and counts as failed', t => {
  const r = run(t, 'part build false\npart_after build use touch ran\nif parts_wait; then echo WAIT=0; else echo WAIT=$?; fi');
  assert.match(r.stdout, /WAIT=1/, r.stderr);
  assert.deepEqual(rows(r.table), [['build', 'failed (exit 1)'], ['use', 'not run: build failed']]);
  assert.equal(existsSync(join(r.dir, 'ran')), false);
});

test('part_after after a killed dependency is not run and does not wait forever', t => {
  const r = run(t, 'part build bash -c \'kill -9 "$PPID"\'\npart_after build use touch ran\nif parts_wait; then echo WAIT=0; else echo WAIT=$?; fi');
  assert.equal(r.error, undefined);
  assert.match(r.stdout, /WAIT=1/, r.stderr);
  assert.deepEqual(rows(r.table), [['build', 'no result (crashed or killed)'], ['use', 'not run: build failed']]);
  assert.equal(existsSync(join(r.dir, 'ran')), false);
});

test('part_after a chain of not-run parts and after a skipped part', t => {
  const r = run(t, [
    'part a false',
    'part_after a b true',
    'part_after b c true',
    'part_skip d "no Rust change (.github/scripts/changed-scope.sh)"',
    'part_after d e true',
    'if parts_wait; then echo WAIT=0; else echo WAIT=$?; fi',
  ].join('\n'));
  assert.match(r.stdout, /WAIT=1/, r.stderr);
  assert.deepEqual(rows(r.table), [
    ['a', 'failed (exit 1)'],
    ['b', 'not run: a failed'],
    ['c', 'not run: b failed'],
    ['d', 'skipped: no Rust change (.github/scripts/changed-scope.sh)'],
    ['e', 'skipped: d is skipped: no Rust change (.github/scripts/changed-scope.sh)'],
  ]);
});

test('skip rows pass and the table follows declaration order, never the files present', t => {
  const r = run(t, [
    'mkdir -p "$CI_EVIDENCE/parts" && echo 1 > "$CI_EVIDENCE/parts/stray.rc"',
    'part zeta sh -c "sleep 1"',
    'part_skip alpha "docs only; see .github/scripts/changed-scope.sh | rules"',
    'part mid true',
    'parts_wait',
  ].join('\n'));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(rows(r.table), [
    ['zeta', 'passed'],
    ['alpha', 'skipped: docs only; see .github/scripts/changed-scope.sh \\| rules'],
    ['mid', 'passed'],
  ]);
  assert.doesNotMatch(r.table, /stray/);
  assert.match(r.table, /\| alpha \| skipped: .* \| - \|/);
});

test('a shell function is a valid command and old results are cleared', t => {
  const r = run(t, [
    'mkdir -p "$CI_EVIDENCE/parts" && echo 0 > "$CI_EVIDENCE/parts/fn.rc"',
    'greet() { echo "hello $1"; }',
    'part fn greet world',
    'parts_wait',
  ].join('\n'));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.read('fn.log'), 'hello world\n');
});

test('the table goes to stdout when GITHUB_STEP_SUMMARY is unset', t => {
  const r = run(t, 'part one true\nparts_wait', {summary: false});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\| Part \| Result \| Seconds \|\n\| --- \| --- \| --- \|\n\| one \| passed \| \d+ \|/);
});

test('CI_EVIDENCE must be set', t => {
  const r = run(t, 'part one true\necho UNREACHED', {evidence: false});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CI_EVIDENCE must be set/);
  assert.doesNotMatch(r.stdout, /UNREACHED/);
});

test('bad declarations fail: a duplicate name, an invalid name, an unknown dependency', t => {
  for (const [script, message] of [
    ['part one true\npart one true', /declared twice/],
    ['part "bad name" true', /invalid part name/],
    ['part ../x true', /invalid part name/],
    ['part_after missing one true', /'missing' is not declared/],
    ['part one', /usage: part NAME CMD/],
    ['part_skip one', /usage: part_skip NAME RULE/],
  ]) {
    const r = run(t, `${script}\necho UNREACHED`);
    assert.notEqual(r.status, 0, script);
    assert.match(r.stderr, message, script);
    assert.doesNotMatch(r.stdout, /UNREACHED/, script);
  }
});

test('the scripts contain no ignored exit status', () => {
  const dir = fileURLToPath(new URL('../.github/scripts/', import.meta.url));
  for (const name of ['ci-parts.sh', 'ci-timing.py', 'report-red.sh']) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const banned of ['continue-on-error', '|| true', '|| :', 'set +e']) {
      assert.equal(text.includes(banned), false, `${name} contains ${banned}`);
    }
  }
});
