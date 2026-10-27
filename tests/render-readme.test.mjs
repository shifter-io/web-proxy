import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'scripts', 'render-readme.py');
const defaults = {
  'README.md': '# Fixture\n\n## Intro\n\nText.\n',
  'ENGINEERING.md': '# Guide\n\n## Setup\n\nText.\n',
};

function run(cwd, args, options = {}) {
  return spawnSync('python3', [join(cwd, 'scripts', 'render-readme.py'), ...args], {encoding: 'utf8', ...options});
}

// A temporary repository root holding a copy of the renderer and `files`.
// GIT_CEILING_DIRECTORIES keeps git from finding an enclosing work tree.
function fixture(t, files = {}, {git: initGit = false} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'render-readme-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(script, join(dir, 'scripts', 'render-readme.py'));
  for (const [path, content] of Object.entries({...defaults, ...files})) {
    mkdirSync(dirname(join(dir, path)), {recursive: true});
    writeFileSync(join(dir, path), content);
  }
  const env = {...process.env, GIT_CEILING_DIRECTORIES: dirname(dir)};
  const git = args => assert.equal(spawnSync('git', args, {cwd: dir, env}).status, 0, `git ${args.join(' ')}`);
  if (initGit) {
    git(['init', '-q']);
    git(['add', '-A']);
  }
  return {dir, git, render: (...args) => run(dir, args, {env})};
}

const htmlFiles = dir => existsSync(join(dir, 'docs'))
  ? readdirSync(join(dir, 'docs')).filter(name => name.endsWith('.html')) : [];

function assertFails(result, ...messages) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  for (const message of messages) assert.ok(result.stderr.includes(message), result.stderr);
}

test('D1 renders a valid fixture with every supported local and external link form', t => {
  const {dir, render} = fixture(t, {
    'README.md': [
      '<p align="center">',
      '  <a href="https://example.com/?a=1&amp;b=2"><img src="docs/assets/header.svg" alt="Header"></a>',
      '</p>',
      '',
      '<p align="center">',
      '  <a href="#usage">Usage</a> · <a href="#links">Links</a>',
      '</p>',
      '',
      '# Fixture',
      '',
      '## Contents',
      '',
      '- [Usage](#usage)',
      '- [Links](#links)',
      '',
      '## Usage',
      '',
      'See the [setup guide](docs/engineering.html#setup), the [license](LICENSE)',
      'and the [assets](docs/).',
      '',
      '## Links',
      '',
      '| Link | Kind |',
      '| --- | --- |',
      '| [Example](https://example.com/) | external |',
      '| [Mail](mailto:hi@example.com) | mail |',
      '',
      'Write `[x](#missing)` in a code span.',
      '',
      '```md',
      '[x](#missing)',
      '```',
      '',
    ].join('\n'),
    'ENGINEERING.md': '# Guide\n\nBack to the [README](README.md#usage).\n\n## Setup\n\nText.\n',
    'docs/assets/header.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'docs/readme.html': 'placeholder\n',
    'docs/engineering.html': 'placeholder\n',
    LICENSE: 'MIT\n',
  }, {git: true});
  const result = render();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Generated docs/readme.html\nGenerated docs/engineering.html\n');
  const readme = readFileSync(join(dir, 'docs', 'readme.html'), 'utf8');
  assert.ok(readme.includes('src="data:image/svg+xml;base64,'));
  assert.ok(readme.includes('<a href="../docs/engineering.html#setup">setup guide</a>'));
  assert.ok(readme.includes('<code>[x](#missing)</code>'));
  assert.ok(readFileSync(join(dir, 'docs', 'engineering.html'), 'utf8').includes('<h2 id="setup">Setup</h2>'));
});

test('D2 the repository documents are valid and their committed HTML is current', () => {
  const result = run(repo, ['--check'], {cwd: repo});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'docs/readme.html and docs/engineering.html are current\n');
});

test('D3 a missing same-document anchor fails with its line and writes nothing', t => {
  const {dir, render} = fixture(t, {'ENGINEERING.md': '# Guide\n\n## Setup\n\nSee [missing](#missing).\n'});
  assertFails(render(), 'ENGINEERING.md:5: no heading for "#missing" in ENGINEERING.md');
  assert.deepEqual(htmlFiles(dir), []);
});

test('D4 a missing cross-document anchor fails and leaves the existing page unchanged', t => {
  const {dir, render} = fixture(t, {
    'README.md': '# Fixture\n\nSee [nope](docs/engineering.html#nope).\n',
    'docs/engineering.html': 'placeholder\n',
  });
  assertFails(render(), 'README.md:3: no heading for "docs/engineering.html#nope"');
  assert.equal(readFileSync(join(dir, 'docs', 'engineering.html'), 'utf8'), 'placeholder\n');
  assert.deepEqual(htmlFiles(dir), ['engineering.html']);
});

test('D5 a link to a missing file fails', t => {
  const {render} = fixture(t, {'README.md': '# Fixture\n\nSee [gone](missing.md).\n'});
  assertFails(render(), 'README.md:3: "missing.md" is not a tracked file');
});

test('D6 an existing but untracked file fails until it is added to git', t => {
  const {dir, git, render} = fixture(t, {'README.md': '# Fixture\n\nSee [notes](notes.md).\n'}, {git: true});
  writeFileSync(join(dir, 'notes.md'), 'Notes.\n');
  assertFails(render(), 'README.md:3: "notes.md" is not a tracked file');
  git(['add', 'notes.md']);
  assert.equal(render().status, 0);
});

test('D7 a duplicate heading id fails with both lines', t => {
  const {dir, render} = fixture(t, {'README.md': '# Fixture\n\n## Setup\n\nText.\n\n## Setup\n'});
  assertFails(render(), 'README.md:7: duplicate heading id "setup" (first at line 3)');
  assert.deepEqual(htmlFiles(dir), []);
});

test('D8 a broken anchor in the HTML header block fails', t => {
  const {render} = fixture(t, {'README.md': '<p align="center">\n  <a href="#nope">Jump</a>\n</p>\n\n# Fixture\n'});
  assertFails(render(), 'README.md:1: no heading for "#nope" in README.md');
});

test('D9 a path outside the repository fails', t => {
  const {render} = fixture(t, {'README.md': '# Fixture\n\nSee [up](../outside.md).\n'});
  assertFails(render(), 'README.md:3: "../outside.md" leaves the repository');
});

test('D10 a fragment on a non-document file fails', t => {
  const {render} = fixture(t, {'README.md': '# Fixture\n\nSee [license](LICENSE#x).\n', LICENSE: 'MIT\n'});
  assertFails(render(),
    'README.md:3: fragment links are checked only for README.md, ENGINEERING.md and docs/*.html');
});

test('D11 --check reports current pages, then a stale page, and never writes', t => {
  const {dir, render} = fixture(t);
  assert.equal(render().status, 0);
  const page = name => readFileSync(join(dir, 'docs', name));
  const before = {readme: page('readme.html'), engineering: page('engineering.html')};
  const current = render('--check');
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.stdout, 'docs/readme.html and docs/engineering.html are current\n');
  assert.deepEqual(page('readme.html'), before.readme);
  assert.deepEqual(page('engineering.html'), before.engineering);
  writeFileSync(join(dir, 'README.md'), '# Fixture\n\n## Intro\n\nChanged text.\n');
  const stale = render('--check');
  assert.equal(stale.status, 1);
  assert.equal(stale.stderr, 'docs/readme.html is out of date; run python3 scripts/render-readme.py\n');
  assert.deepEqual(page('readme.html'), before.readme);
});

test('D12 an unknown argument prints usage and exits 2', t => {
  const {dir, render} = fixture(t);
  const result = render('--bogus');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage: /);
  assert.deepEqual(htmlFiles(dir), []);
});

test('D13 a header image that is not an existing local SVG file fails and writes nothing', t => {
  for (const src of ['https://example.com/x.svg', 'scripts', 'docs/assets/header.svg']) {
    const {dir, render} = fixture(t, {
      'README.md': `<p align="center">\n  <img src="${src}" alt="Header">\n</p>\n\n# Fixture\n`,
      'docs/assets/header.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    }, {git: true});
    if (src === 'docs/assets/header.svg') rmSync(join(dir, src)); // tracked, then deleted
    assertFails(render(), `README.md:1: header image "${src}" must be an existing local SVG file`);
    assert.deepEqual(htmlFiles(dir), [], src);
  }
});
