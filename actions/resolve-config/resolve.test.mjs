import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, stripJsonc, deepMerge } from './resolve.mjs';

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fastedge-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test('stripJsonc keeps // inside strings, drops comments and trailing commas', () => {
  const json = stripJsonc('{ "u": "https://x", // c\n /* b */ "a": [1,], }');
  assert.deepEqual(JSON.parse(json), { u: 'https://x', a: [1] });
});

test('deepMerge: name-keyed arrays merge, null deletes', () => {
  const base = { env: { A: '1', B: '2' }, params: [{ name: 'X', mandatory: true }, { name: 'Y' }] };
  const over = { env: { B: null }, params: [{ name: 'X', mandatory: false }, { name: 'Z' }] };
  assert.deepEqual(deepMerge(base, over), {
    env: { A: '1' },
    params: [{ name: 'X', mandatory: false }, { name: 'Y' }, { name: 'Z' }],
  });
});

test('rust template: detected language, cargo defaults, merged env, stringified metadata', () => {
  const dir = repo({
    'Cargo.toml': '[package]\nname = "html-2-md"\nversion = "0.1.0"\n',
    'fastedge.jsonc': `{
      "kind": "template", "runtime": "cdn-filter", "category": ["traffic"],
      "template": { "name": "HTML to MD", "params": [{ "name": "P", "metadata": { "default_value": "x" } }] },
      "environments": {
        "preprod": { "template": { "id": 558, "name": "HTML to MD (preprod)" } },
        "prod": { "template": { "id": 110 } },
      },
    }`,
  });
  const pre = resolve(dir, 'preprod');
  assert.equal(pre.language, 'rust');
  assert.equal(pre.build.output, 'target/wasm32-wasip1/release/html_2_md.wasm');
  assert.deepEqual(pre.tests.map((t) => t.kind), ['cargo']);
  assert.deepEqual(pre.topics, ['template', 'cdn-filter', 'rust', 'traffic']);
  assert.equal(pre.template.id, 558);
  assert.equal(pre.template.name, 'HTML to MD (preprod)');
  assert.equal(pre.template.params[0].metadata, '{"default_value":"x"}');
  assert.equal(pre.template.instructions, './instructions.md');
  const prod = resolve(dir, 'prod');
  assert.equal(prod.template.id, 110);
  assert.equal(prod.template.name, 'HTML to MD');
});

test('js app: build.output fallback ./wasm, no tests → empty test command, customer topic', () => {
  const dir = repo({
    'package.json': '{ "name": "a", "scripts": { "build": "x" } }',
    'fastedge.jsonc': `{ "kind": "app", "runtime": "http-app", "customer": "orange",
      "app": { "name": "orange-a", "env": { "K": "v" }, "secrets": { "S": "orange-s" } },
      "environments": { "preprod": { "app": { "name": "orange-a-preprod" } } } }`,
  });
  const r = resolve(dir, 'preprod');
  assert.equal(r.language, 'js');
  assert.equal(r.build.output, 'wasm');
  assert.deepEqual(r.tests, []);
  assert.ok(r.topics.includes('customer-orange'));
  assert.deepEqual(r.app, { name: 'orange-a-preprod', env: { K: 'v' }, secrets: { S: 'orange-s' } });
});

test('assemblyscript detected from dependency; package test script used', () => {
  const dir = repo({
    'package.json': '{ "scripts": { "test": "t" }, "devDependencies": { "assemblyscript": "0.27" } }',
    'fastedge.jsonc': '{ "kind": "template", "runtime": "cdn-filter", "template": { "name": "t" } }',
  });
  const r = resolve(dir);
  assert.equal(r.language, 'assemblyscript');
  assert.deepEqual(r.tests.map((t) => t.kind), ['npm']);
});

test('monorepo returns its package index', () => {
  const dir = repo({ 'fastedge.jsonc': '{ "kind": "monorepo", "category": ["security"], "packages": ["a", "b"] }' });
  assert.deepEqual(resolve(dir), { kind: 'monorepo', packages: ['a', 'b'], topics: ['monorepo', 'security'] });
});

test('rejects invalid configs', () => {
  const bad = (cfg) => assert.throws(() => resolve(repo({ 'Cargo.toml': '[package]\nname="x"', 'fastedge.jsonc': cfg }), 'prod'));
  bad('{ "kind": "app", "runtime": "http-app" }'); // app block missing
  bad('{ "kind": "app", "runtime": "http-app", "app": { "name": "a" }, "template": { "name": "t" } }'); // both
  bad('{ "kind": "library", "environments": {} }'); // library can't deploy
  bad('{ "kind": "app", "runtime": "http-app", "app": { "name": "a", "bogus": 1 } }'); // unknown field
  bad('{ "kind": "app", "runtime": "http-app", "app": { "name": "a" }, "environments": { "prod": { "app": { "id": "x" } } } }'); // id type after merge
  bad('{ "kind": "app", "runtime": "http-app", "app": { "name": "a" }, "environments": { "staging": {} } }'); // S-5
  bad('{ "kind": "template", "runtime": "cdn-filter", "template": { "name": "t", "params": [{ "name": "X", "data_type": "boolean" }] } }'); // API wants "bool"
});

test('rust test suites: cargo always detected (may run zero), fastedge-test added when present, override replaces both', () => {
  const cfg = '{ "kind": "template", "runtime": "cdn-filter", "template": { "name": "t" } }';
  const ft = '{ "scripts": { "test": "node app.test.mjs" } }';
  const kinds = (files) => {
    const dir = repo({ 'Cargo.toml': '[package]\nname = "x"', 'fastedge.jsonc': cfg, ...files });
    return resolve(dir).tests.map((t) => t.kind);
  };
  assert.deepEqual(kinds({}), ['cargo']);
  const both = repo({ 'Cargo.toml': '[package]\nname = "x"', 'fastedge.jsonc': cfg });
  mkdirSync(join(both, 'fastedge-test'));
  writeFileSync(join(both, 'fastedge-test/package.json'), ft);
  assert.deepEqual(resolve(both).tests.map((t) => t.kind), ['cargo', 'fastedge-test']);
  const over = repo({ 'Cargo.toml': '[package]\nname = "x"',
    'fastedge.jsonc': '{ "kind": "template", "runtime": "cdn-filter", "template": { "name": "t" }, "test": { "command": "make test" } }' });
  assert.deepEqual(resolve(over).tests, [{ kind: 'custom', command: 'make test' }]);
});

test('js root test script pointing at fastedge-test/ is counted as fastedge-test', () => {
  const dir = repo({
    'package.json': '{ "scripts": { "test": "node fastedge-test/app.test.mjs" } }',
    'fastedge.jsonc': '{ "kind": "app", "runtime": "http-app", "app": { "name": "a" } }',
  });
  assert.deepEqual(resolve(dir).tests.map((t) => t.kind), ['fastedge-test']);
});
