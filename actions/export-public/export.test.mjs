import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportTree, globToRegExp, publicWorkflows, readMirrorConfig, stripOrgLinks } from './export.mjs';

const INCLUDE = ['src/**', 'Cargo.toml', 'CHANGELOG.md'];

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'export-src-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}
const out = () => join(mkdtempSync(join(tmpdir(), 'export-out-')), 'tree');

test('globs: * stays in a segment, ** crosses', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.rs'));
  assert.ok(globToRegExp('fastedge-test/*.mjs').test('fastedge-test/app.test.mjs'));
  assert.ok(!globToRegExp('fastedge-test/*.mjs').test('fastedge-test/x/app.mjs'));
  assert.ok(!globToRegExp('Cargo.toml').test('Cargo.lock'));
});

test('mirror config: name from the naming rule, override, validation', () => {
  const cfg = (body) => repo({ '.github/mirror.jsonc': body });
  assert.deepEqual(readMirrorConfig(cfg('{ "include": ["src/**"], }'), 'acme/private-x'), { repo: 'x', include: ['src/**'] });
  assert.equal(readMirrorConfig(cfg('{ "include": ["a"], "repo": "y" }'), 'acme/private-x').repo, 'y');
  assert.throws(() => readMirrorConfig(cfg('{ "include": ["a"] }'), 'acme/x'), /not named private-/);
  assert.throws(() => readMirrorConfig(cfg('{ "include": ["a"], "repo": "private-y" }'), 'acme/private-x'), /invalid mirror name/);
  assert.throws(() => readMirrorConfig(cfg('{ "include": [] }'), 'acme/private-x'), /non-empty/);
  assert.throws(() => readMirrorConfig(cfg('{ "include": ["a"], "export": 1 }'), 'acme/private-x'), /unknown key/);
  assert.throws(() => readMirrorConfig(repo({ 'a': '' }), 'acme/private-x'), /not found/);
});

test('allow-list plus .github/mirror overlay; .github and untracked files stay out', () => {
  const dir = repo({
    'src/lib.rs': 'fn x() {}', 'Cargo.toml': '[package]',
    '.github/workflows/ci.yaml': 'private', '.github/mirror/.github/workflows/ci.yaml': 'public',
    '.github/mirror/Cargo.toml': '[package] # public', '.github/mirror.jsonc': '{}',
  });
  writeFileSync(join(dir, 'src/untracked.rs'), '');
  const o = out();
  const files = exportTree(dir, o, 'acme', [...INCLUDE, '.github/**']);
  assert.deepEqual(files, ['.github/workflows/ci.yaml', 'Cargo.toml', 'src/lib.rs']);
  assert.equal(readFileSync(join(o, '.github/workflows/ci.yaml'), 'utf8'), 'public');
  assert.equal(readFileSync(join(o, 'Cargo.toml'), 'utf8'), '[package] # public');
});

test('leak guard: internal files and internal references fail closed', () => {
  const bad = (files) => assert.throws(() => exportTree(repo(files), out(), 'acme', [...INCLUDE, '**']), /leak guard/);
  bad({ 'fastedge.jsonc': '{}' });
  bad({ 'release-please-config.json': '{}' });
  bad({ '.github/mirror/.github/workflows/ci.yaml': 'uses: acme/toolkit/.github/workflows/x.yaml@v1' });
  bad({ 'src/lib.rs': '// see https://github.com/acme/private-x' });
});

test('CHANGELOG: org links stripped, text kept', () => {
  const md = [
    '## [0.1.3](https://github.com/acme/private-x/compare/v0.1.2...v0.1.3) (2026-10-28)',
    '* fix convert ([#9](https://github.com/acme/x/issues/9)) ([4fbe2c1](https://github.com/acme/x/commit/4fbe2c1aa))',
    '* see [docs](https://example.com/d)',
  ].join('\n');
  assert.equal(stripOrgLinks(md, 'acme'), [
    '## 0.1.3 (2026-10-28)',
    '* fix convert',
    '* see [docs](https://example.com/d)',
  ].join('\n'));
  const o = out();
  exportTree(repo({ 'src/a.rs': '', 'CHANGELOG.md': md }), o, 'acme', INCLUDE);
  assert.ok(!readFileSync(join(o, 'CHANGELOG.md'), 'utf8').includes('github.com/acme'));
});

test('empty match fails', () => {
  assert.throws(() => exportTree(repo({ 'a.txt': '' }), out(), 'acme', INCLUDE), /matched no files/);
});

test('public workflows: generated per language, env from param defaults, overlay wins', () => {
  const cfg = {
    kind: 'template', language: 'rust', build: { output: 'target/wasm32-wasip1/release/x.wasm' },
    template: { description: 'Does "x"', params: [
      { name: 'MODE', data_type: 'string', metadata: { default_value: '*' } },
      { name: 'FLAG', data_type: 'bool' },
      { name: 'KEY', data_type: 'secret' },
    ] },
  };
  const gen = publicWorkflows(cfg, 'x');
  assert.deepEqual([...gen.keys()].sort(), ['.github/workflows/ci.yaml', '.github/workflows/deploy.yaml']);
  const deploy = gen.get('.github/workflows/deploy.yaml').toString();
  assert.ok(deploy.includes('wasm_file: "target/wasm32-wasip1/release/x.wasm"'));
  assert.ok(deploy.includes('app_name: "x"'));
  assert.ok(deploy.includes('comment: "Does \\"x\\""'));
  assert.ok(deploy.includes('env: "{\\"MODE\\":\\"*\\",\\"FLAG\\":\\"\\"}"'));
  assert.ok(deploy.includes('secret(s) KEY'));
  assert.ok(!/\{\{[A-Z]+\}\}/.test(deploy)); // no placeholder left
  const app = publicWorkflows({ kind: 'app', language: 'rust', build: { output: 'o.wasm' },
    app: { env: { INTERNAL: 'secret-ish' } } }, 'y').get('.github/workflows/deploy.yaml').toString();
  assert.ok(app.includes('env: "{\\"INTERNAL\\":\\"\\"}"') && !app.includes('secret-ish'));
  assert.deepEqual([...publicWorkflows({ kind: 'library', language: 'rust' }, 'z').keys()], ['.github/workflows/ci.yaml']);
  assert.equal(publicWorkflows({ kind: 'app', language: 'go', app: {} }, 'z').size, 0);

  const dir = repo({ 'src/a.rs': '', '.github/mirror/.github/workflows/ci.yaml': 'custom' });
  const o = out();
  const files = exportTree(dir, o, 'acme', INCLUDE, gen);
  assert.deepEqual(files, ['.github/workflows/ci.yaml', '.github/workflows/deploy.yaml', 'src/a.rs']);
  assert.equal(readFileSync(join(o, '.github/workflows/ci.yaml'), 'utf8'), 'custom');
});
