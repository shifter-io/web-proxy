import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/ci-timing.py', import.meta.url));

// A cargo-nextest report: one <testsuite> per test binary, <testcase classname=binary name=path>.
function nextest(cases) {
  const body = cases.map(([name, time, child = '']) =>
    `    <testcase name="${name}" classname="web-proxy::bin" time="${time}">${child}</testcase>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="nextest-run" tests="${cases.length}">\n` +
    `  <testsuite name="web-proxy::bin" tests="${cases.length}">\n${body}\n  </testsuite>\n</testsuites>\n`;
}

// A `node --test --test-reporter=junit` report: top-level <testcase> elements and nested suites.
function nodeJunit(cases) {
  const body = cases.map(([name, time, child = '']) =>
    `\t<testcase name="${name}" time="${time}" classname="test">${child}</testcase>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n` +
    '\t<testsuite name="group" time="0.002" tests="1"><testcase name="nested" time="0.001" classname="test"/></testsuite>\n' +
    '\t<!-- tests 1 -->\n</testsuites>\n';
}

// Runs ci-timing.py in a temporary folder. `files` maps names to contents; `step` is the step's age in seconds.
function run(t, files, {step = 10, args, summary = true} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-timing-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, 'start'), `${Math.floor(Date.now() / 1000) - step}\n`);
  const env = {...process.env};
  delete env.GITHUB_STEP_SUMMARY;
  if (summary) env.GITHUB_STEP_SUMMARY = join(dir, 'summary.md');
  const result = spawnSync('python3', [script, ...(args ?? ['--start', 'start', '--out', 'out.json', ...Object.keys(files)])],
    {cwd: dir, env, encoding: 'utf8'});
  const readOr = (name, fallback) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return fallback; } };
  return {...result, table: readOr('summary.md', ''), json: JSON.parse(readOr('out.json', 'null'))};
}

const warnings = stdout => stdout.split('\n').filter(line => line.startsWith('::warning::'));
const errors = stdout => stdout.split('\n').filter(line => line.startsWith('::error::'));
const hint = 'over 60 s: mark it slow (Rust: name starts with slow_; JS: move the file to tests/slow/)';

test('reads nextest and node JUnit and writes counts per file, slowest tests and the step time', t => {
  const failure = '<failure type="testCodeFailure" message="boom">boom</failure>';
  const r = run(t, {
    'rust.xml': nextest([['tests::fast', '0.010'], ['tests::slowish', '2.500'], ['tests::broken', '0.200', failure],
      ['tests::ignored', '0.000', '<skipped/>']]),
    'node.xml': nodeJunit([['renders', '1.250'], ['errors', '0.300', '<error message="x"/>'], ['todo', '0', '<skipped type="skipped"/>']]),
  }, {step: 30});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(warnings(r.stdout), []);
  assert.match(r.table, /^### Test times\n\nTest step: 3\d(\.\d)? s\n/);
  assert.match(r.table, /\| rust\.xml \| 4 \| 2 \| 1 \| 1 \|/);
  assert.match(r.table, /\| node\.xml \| 4 \| 2 \| 1 \| 1 \|/);
  assert.match(r.table, /Slowest 8 tests:\n\n\| Seconds \| Test \| Suite \| File \|\n\| --- \| --- \| --- \| --- \|\n\| 2\.5 \| tests::slowish \| web-proxy::bin \| rust\.xml \|\n\| 1\.25 \| renders \|  \| node\.xml \|/);
  assert.equal(r.json.title, 'Test times');
  assert.ok(r.json.step_seconds >= 30 && r.json.step_seconds < 40, String(r.json.step_seconds));
  assert.deepEqual(r.json.files, [
    {file: 'rust.xml', tests: 4, passed: 2, failed: 1, skipped: 1},
    {file: 'node.xml', tests: 4, passed: 2, failed: 1, skipped: 1},
  ]);
  assert.deepEqual(r.json.slowest[0], {file: 'rust.xml', suite: 'web-proxy::bin', name: 'tests::slowish', seconds: 2.5});
  assert.deepEqual(r.json.errors, []);
});

test('lists only the 20 slowest tests and sums the time of a repeated name', t => {
  const cases = Array.from({length: 25}, (_, i) => [`t${String(i).padStart(2, '0')}`, `${i}.0`]);
  cases.push(['t00', '30.0'], ['t00', '20.0']);
  const r = run(t, {'many.xml': nextest(cases)}, {args: ['--start', 'start', '--out', 'out.json', '--title', 'Rust tests', 'many.xml']});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.table, /^### Rust tests\n/);
  assert.match(r.table, /\| many\.xml \| 25 \| 25 \| 0 \| 0 \|/);
  assert.equal(r.json.slowest.length, 20);
  assert.deepEqual(r.json.slowest.slice(0, 2).map(test => [test.name, test.seconds]), [['t00', 50], ['t24', 24]]);
  assert.equal(r.json.slowest.at(-1).name, 't06');
});

test('a test over 60 s warns, 89.9 s still passes and 90.0 s fails', async t => {
  await t.test('60.5 s and 89.9 s warn and pass', t => {
    const r = run(t, {'r.xml': nextest([['tests::a', '60.5'], ['tests::b', '89.9'], ['tests::c', '60.0']])});
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(errors(r.stdout), []);
    const lines = warnings(r.stdout);
    assert.equal(lines.length, 2, r.stdout);
    assert.ok(lines.every(line => line.includes(hint)), r.stdout);
    assert.match(lines.join('\n'), /tests::b \(r\.xml\) took 89\.9 s/);
    assert.match(lines.join('\n'), /tests::a \(r\.xml\) took 60\.5 s/);
    assert.deepEqual(r.json.over_warn.map(test => test.name), ['tests::b', 'tests::a']);
  });
  await t.test('90.0 s fails', t => {
    const r = run(t, {'n.xml': nodeJunit([['slow one', '90.0']])});
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(errors(r.stdout).join('\n'), /slow one \(n\.xml\) took 90\.0 s: 90 s or more fails; over 60 s: mark it slow/);
  });
});

test('the step warns over 90 s and fails over 240 s', async t => {
  await t.test('91 s warns', t => {
    const r = run(t, {'r.xml': nextest([['tests::a', '1']])}, {step: 91});
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(warnings(r.stdout).join('\n'), /the test step took 9\d(\.\d)? s, over the 90 s goal/);
  });
  await t.test('241 s fails', t => {
    const r = run(t, {'r.xml': nextest([['tests::a', '1']])}, {step: 241});
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(errors(r.stdout).join('\n'), /the test step took 24\d(\.\d)? s, over the 240 s limit/);
    assert.ok(r.json.step_seconds > 240);
  });
});

test('a test is its name under its parent suites, so equal names in different parents stay apart', t => {
  const r = run(t, {
    'node.xml': '<testsuites>\n<testsuite name="outer one"><testcase name="fails" time="1.5" classname="test"><failure/></testcase></testsuite>\n' +
      '<testsuite name="outer two"><testsuite name="inner"><testcase name="fails" time="2.5" classname="test"/></testsuite></testsuite>\n' +
      '<testcase name="fails" time="0.5" classname="test"/>\n</testsuites>\n',
    'suite.xml': '<testsuite name="bin"><testcase name="a" time="3" classname="bin"/></testsuite>\n',
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.json.files, [
    {file: 'node.xml', tests: 3, passed: 2, failed: 1, skipped: 0},
    {file: 'suite.xml', tests: 1, passed: 1, failed: 0, skipped: 0},
  ]);
  assert.deepEqual(r.json.slowest.map(test => [test.suite, test.name, test.seconds]),
    [['bin', 'a', 3], ['outer two > inner', 'fails', 2.5], ['outer one', 'fails', 1.5], ['', 'fails', 0.5]]);
});

test('a missing, invalid, non-JUnit or empty file fails and is reported', t => {
  const r = run(t, {
    'good.xml': nextest([['tests::a', '1']]),
    'invalid.xml': '<testsuites><testcase',
    'empty.xml': '',
    'html.xml': '<html><body/></html>',
    'none.xml': '<testsuites name="nextest-run"><testsuite name="x" tests="0"/></testsuites>',
    'badtime.xml': '<testsuites><testcase name="a" time="soon"/></testsuites>',
  }, {args: ['--start', 'start', '--out', 'out.json', 'good.xml', 'missing.xml', 'invalid.xml', 'empty.xml', 'html.xml', 'none.xml', 'badtime.xml']});
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const lines = errors(r.stdout).join('\n');
  assert.match(lines, /missing\.xml: missing, unreadable or not XML/);
  assert.match(lines, /invalid\.xml: missing, unreadable or not XML/);
  assert.match(lines, /empty\.xml: missing, unreadable or not XML/);
  assert.match(lines, /html\.xml: not JUnit \(root element <html>\)/);
  assert.match(lines, /none\.xml: holds no test/);
  assert.match(lines, /badtime\.xml: test a has an invalid time/);
  assert.equal(r.json.errors.length, 6);
  assert.deepEqual(r.json.files.map(file => file.file), ['good.xml']);
  assert.match(r.table, /\| none\.xml: holds no test \| - \| - \| - \| - \|/);
});

test('a test name cannot inject a workflow command or break the table', t => {
  const r = run(t, {'r.xml': nextest([['a|b&#10;::error::injected', '61']])});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(errors(r.stdout), []);
  assert.match(warnings(r.stdout)[0], /a\|b%0A::error::injected/);
  assert.match(r.table, /\| 61\.0 \| a\\\|b ::error::injected \|/);
});

test('the summary goes to stdout when GITHUB_STEP_SUMMARY is unset', t => {
  const r = run(t, {'r.xml': nextest([['tests::a', '1']])}, {summary: false});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^### Test times\n/);
});

test('usage errors exit 2 and a bad start file exits 1', async t => {
  for (const args of [[], ['--start', 'start', '--out', 'out.json'], ['--out', 'out.json', 'r.xml'], ['--start', 'start', 'r.xml']]) {
    await t.test(args.join(' ') || 'no arguments', t => {
      const r = run(t, {'r.xml': nextest([['tests::a', '1']])}, {args});
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /usage: ci-timing\.py/);
    });
  }
  await t.test('start file without a number', t => {
    const r = run(t, {'r.xml': nextest([['tests::a', '1']]), 'bad-start': 'soon\n'},
      {args: ['--start', 'bad-start', '--out', 'out.json', 'r.xml']});
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--start bad-start: no epoch seconds/);
  });
});
