#!/usr/bin/env node
// Reads a repo's fastedge.jsonc, validates it, applies derived defaults
// (language, build, test — SCHEMA.md §6) and, for an environment, merges the
// per-environment override onto the shared block (SCHEMA.md S-1).
//
// Usage: resolve.mjs <dir> [preprod|prod]
// Prints the resolved config as JSON; inside GitHub Actions also writes each
// top-level field to $GITHUB_OUTPUT.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import { stripJsonc } from '../lib/jsonc.mjs';

export { stripJsonc };

const SCHEMA_PATH = fileURLToPath(new URL('../../schema/fastedge.schema.json', import.meta.url));
const COMPILER_IMAGE = 'viridiscomms/fastedge-apps-compiler:0.0.2'; // B6b (POC)
const ENVIRONMENTS = ['preprod', 'prod']; // S-5

// --- Merge (same rules as FastEdge-templates merge-registry.mjs) ----------

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNameKeyedArray = (a) => a.every((x) => isPlainObject(x) && typeof x.name === 'string');

export function deepMerge(base, override) {
  if (Array.isArray(base) && Array.isArray(override)) {
    if (!(isNameKeyedArray(base) && isNameKeyedArray(override))) return override;
    const merged = base.map((x) => ({ ...x }));
    for (const item of override) {
      const i = merged.findIndex((x) => x.name === item.name);
      if (i === -1) merged.push(item);
      else merged[i] = deepMerge(merged[i], item);
    }
    return merged;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value === null) delete result[key];
      else result[key] = key in result ? deepMerge(result[key], value) : value;
    }
    return result;
  }
  return override;
}

// --- Defaults (SCHEMA.md §6, T19b, T20, S-2, S-3) --------------------------

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function detectLanguage(dir) {
  if (existsSync(join(dir, 'Cargo.toml'))) return 'rust';
  const pkg = readJson(join(dir, 'package.json'));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return 'assemblyscript' in deps ? 'assemblyscript' : 'js';
}

function crateName(dir) {
  const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
  const pkgSection = toml.split(/^\[/m).find((s) => s.startsWith('package]'));
  const name = pkgSection?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name) throw new Error('Cargo.toml has no [package] name');
  return name.replace(/-/g, '_');
}

const inCompiler = (cmd) =>
  `docker run --rm -v "$PWD":/work -w /work ${COMPILER_IMAGE} ${cmd}`;

function defaultBuild(dir, language) {
  if (language === 'rust') {
    return {
      command: inCompiler('cargo build --release --target wasm32-wasip1'),
      output: `target/wasm32-wasip1/release/${crateName(dir)}.wasm`,
    };
  }
  return { command: 'pnpm install --frozen-lockfile && pnpm build', output: 'wasm' };
}

// Test suites (T20, revised 2026-10-27): every suite present runs. An explicit
// test.command replaces detection. Each suite: { kind, command }, where kind
// tells run-tests how to count tests (cargo | fastedge-test | npm | custom).
function defaultTests(dir) {
  const suites = [];
  // Host target: crates pin wasm32-wasip1 in .cargo/config.toml, which can't run tests.
  if (existsSync(join(dir, 'Cargo.toml'))) {
    suites.push({ kind: 'cargo', command: inCompiler('cargo test --target x86_64-unknown-linux-gnu') });
  }
  // Rust black-box suite: self-contained Node project (plugin test skill layout).
  if (readJson(join(dir, 'fastedge-test/package.json'))?.scripts?.test) {
    suites.push({ kind: 'fastedge-test', command: 'cd fastedge-test && npm ci --no-audit --no-fund && npm test' });
  }
  // JS/AS: root test script (runs fastedge-test/app.test.mjs in the skill layout).
  const rootTest = readJson(join(dir, 'package.json'))?.scripts?.test;
  if (rootTest) {
    suites.push({
      kind: /fastedge-test\//.test(rootTest) ? 'fastedge-test' : 'npm',
      command: 'pnpm install --frozen-lockfile && pnpm test',
    });
  }
  return suites;
}

function topics(cfg) {
  return [cfg.kind, cfg.runtime, cfg.language, ...(cfg.category ?? []),
    cfg.customer && `customer-${cfg.customer}`].filter(Boolean);
}

// --- Resolve ---------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFile = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

function assertValid(validate, data, what) {
  if (!validate(data)) {
    const errors = validate.errors.map((e) => `  ${e.instancePath || '/'} ${e.message}`).join('\n');
    throw new Error(`${what} is invalid:\n${errors}`);
  }
}

export function resolve(dir, environment) {
  const raw = readFileSync(join(dir, 'fastedge.jsonc'), 'utf8');
  const cfg = JSON.parse(stripJsonc(raw));
  assertValid(validateFile, cfg, `${dir}/fastedge.jsonc`);

  if (cfg.kind === 'monorepo') {
    return { kind: 'monorepo', packages: cfg.packages, topics: topics(cfg) };
  }

  const language = cfg.language ?? detectLanguage(dir);
  if (!language) throw new Error(`${dir}: set "language" — no Cargo.toml or package.json to detect it from`);
  const resolved = { ...cfg, language };
  const defaults = defaultBuild(dir, language);
  resolved.build = { ...defaults, ...cfg.build };
  resolved.tests = cfg.test?.command
    ? [{ kind: 'custom', command: cfg.test.command }]
    : defaultTests(dir);
  delete resolved.test;
  resolved.topics = topics(resolved);
  delete resolved.environments;
  delete resolved.$schema;

  if (cfg.kind === 'library' || !environment) return resolved;

  if (!ENVIRONMENTS.includes(environment)) throw new Error(`unknown environment "${environment}"`);
  const target = cfg.kind; // 'app' | 'template'
  const merged = deepMerge(cfg[target], cfg.environments?.[environment]?.[target] ?? {});
  const validateTarget = ajv.getSchema(`${validateFile.schema.$id}#/$defs/${target}`);
  assertValid(validateTarget, merged, `${target} for ${environment}`);
  if (!merged.name) throw new Error(`${target} for ${environment} has no name`);

  if (target === 'template') {
    merged.params = (merged.params ?? []).map((p) => ({
      ...p,
      metadata: JSON.stringify(p.metadata ?? {}), // S-7
    }));
    merged.instructions = cfg.instructions ?? './instructions.md'; // T19a
  }
  resolved[target] = merged;
  resolved.environment = environment;
  return resolved;
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir = '.', environment] = process.argv.slice(2);
  try {
    const out = resolve(dir, environment);
    console.log(JSON.stringify(out, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      const lines = Object.entries(out).map(([k, v]) =>
        `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      lines.push(`json=${JSON.stringify(out)}`);
      appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
    }
  } catch (err) {
    console.error(`::error::${err.message.replace(/\n/g, '%0A')}`);
    process.exit(1);
  }
}
