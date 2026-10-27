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

const SCHEMA_PATH = fileURLToPath(new URL('../../schema/fastedge.schema.json', import.meta.url));
const COMPILER_IMAGE = 'viridiscomms/fastedge-apps-compiler:0.0.2'; // B6b (POC)
const ENVIRONMENTS = ['preprod', 'prod']; // S-5

// --- JSONC ---------------------------------------------------------------

// Removes // and /* */ comments and trailing commas, leaving strings intact.
export function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) throw new Error('unterminated /* comment');
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

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

// T20: override → package.json "test" script → cargo test. Empty = no tests.
function defaultTest(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg?.scripts?.test) return 'pnpm install --frozen-lockfile && pnpm test';
  if (existsSync(join(dir, 'Cargo.toml'))) return inCompiler('cargo test');
  return '';
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
  resolved.test = { command: cfg.test?.command ?? defaultTest(dir) };
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
