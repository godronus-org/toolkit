#!/usr/bin/env node
// Builds the public mirror tree for a release (T34). Org machinery, kept out of
// fastedge.jsonc (app config that may become public — FUTURE F-7):
//   .github/mirror.jsonc  { "include": [globs], "repo"?: name }  — opts the repo in
//   .github/mirror/**     exceptions only: overlay copied to the mirror root (wins)
// The public CI and Deploy workflows are generated from templates/public/<language>/
// using the resolved fastedge.jsonc, so no repo carries its own copy.
// The mirror is the repo's own name without "private-" unless "repo" says otherwise.
// Fails closed on anything internal (leak guard).
//
// Usage:
//   CONFIG='<resolve-config json>' export.mjs tree <src-dir> <out-dir> <owner/private-repo>
//   (prints the mirror name)
//   export.mjs notes <owner> < release-notes.md > public-notes.md
// CHANGELOG.md and release notes are published with links into the org
// stripped — they point at private repos and would 404 publicly.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from '../lib/jsonc.mjs';

const CONFIG = '.github/mirror.jsonc';
const OVERLAY = '.github/mirror/';
const REPO_NAME = /^(?!private-)[A-Za-z0-9._-]+$/;
// Never published, whatever the allow-list or overlay says.
const INTERNAL_FILES = ['fastedge.jsonc', 'mirror.jsonc', 'release-please-config.json', '.release-please-manifest.json'];

// * stays within a path segment, ** crosses segments.
export function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  return new RegExp(`^${re}$`);
}

// [text](https://github.com/<owner>/…) → text; a "(#12)" or "(abc1234)" group
// linking into the org is dropped entirely.
export function stripOrgLinks(markdown, owner) {
  const url = `https://github\\.com/${owner}/[^)\\s]*`;
  return markdown
    .replace(new RegExp(` ?\\(\\[(?:#\\d+|[0-9a-f]{7,40})\\]\\(${url}\\)\\)`, 'g'), '')
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(${url}\\)`, 'g'), '$1');
}

export function readMirrorConfig(srcDir, privateRepo) {
  const path = join(srcDir, CONFIG);
  if (!existsSync(path)) throw new Error(`${CONFIG} not found — this repo has no public mirror`);
  const cfg = JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
  const unknown = Object.keys(cfg).filter((k) => !['$schema', 'include', 'repo'].includes(k));
  if (unknown.length) throw new Error(`${CONFIG}: unknown key(s) ${unknown.join(', ')}`);
  if (!Array.isArray(cfg.include) || !cfg.include.length || !cfg.include.every((g) => typeof g === 'string' && g)) {
    throw new Error(`${CONFIG}: "include" must be a non-empty list of globs`);
  }
  const name = privateRepo.split('/').pop();
  const repo = cfg.repo ?? (name.startsWith('private-') ? name.slice('private-'.length) : null);
  if (!repo) throw new Error(`${CONFIG}: repo "${name}" is not named private-<name>; set "repo"`);
  if (!REPO_NAME.test(repo)) throw new Error(`${CONFIG}: invalid mirror name "${repo}"`);
  return { repo, include: cfg.include };
}

const TEMPLATES = fileURLToPath(new URL('../../templates/public/', import.meta.url));

// Customer-facing CI + Deploy for a template or app (T25c: standard actions and
// deploy-app only); a library gets CI only. Env is seeded from template param defaults, or the app's env
// keys with empty values (ours are internal). Returns Map dest → content.
export function publicWorkflows(cfg, repo) {
  const dir = join(TEMPLATES, cfg.language ?? '');
  const target = cfg[cfg.kind];
  if (!['template', 'app', 'library'].includes(cfg.kind) || !cfg.language || !existsSync(dir)) return new Map();
  const files = readdirSync(dir).filter((f) => cfg.kind !== 'library' || f === 'ci.yaml');
  if (cfg.kind === 'library') return new Map(files.map((f) => [`.github/workflows/${f}`, readFileSync(join(dir, f))]));
  const params = cfg.kind === 'template' ? (target.params ?? []) : [];
  const env = cfg.kind === 'template'
    ? Object.fromEntries(params.filter((p) => p.data_type !== 'secret')
        .map((p) => [p.name, String(p.metadata?.default_value ?? '')]))
    : Object.fromEntries(Object.keys(target.env ?? {}).map((k) => [k, '']));
  const secrets = cfg.kind === 'template'
    ? params.filter((p) => p.data_type === 'secret').map((p) => p.name)
    : Object.keys(target.secrets ?? {});
  const vars = {
    WASM: cfg.build.output,
    NAME: repo,
    COMMENT: target.description ?? target.comment ?? repo,
    ENV: JSON.stringify(env),
  };
  const out = new Map();
  for (const file of files) {
    let text = readFileSync(join(dir, file), 'utf8')
      .replace(/\{\{(\w+)\}\}/g, (_, k) => JSON.stringify(vars[k])); // JSON string = valid YAML scalar
    if (file === 'deploy.yaml' && secrets.length) {
      text += `# Also needs secret(s) ${secrets.join(', ')}: create them in the portal and attach them to the app.\n`;
    }
    out.set(`.github/workflows/${file}`, Buffer.from(text));
  }
  return out;
}

const tracked = (dir) =>
  execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' }).split('\0').filter(Boolean);

export function exportTree(srcDir, outDir, owner, include, generated = new Map()) {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);

  const patterns = include.map(globToRegExp);
  const files = tracked(srcDir);
  const copies = new Map(); // dest → src; the overlay wins
  for (const f of files) {
    // .github/ is org machinery: only the overlay publishes anything there.
    if (!f.startsWith('.github/') && patterns.some((p) => p.test(f))) copies.set(f, f);
  }
  for (const f of files) {
    if (f.startsWith(OVERLAY)) copies.set(f.slice(OVERLAY.length), f);
  }
  if (!copies.size) throw new Error('export matched no files');

  const contents = new Map([...generated].filter(([dest]) => !copies.has(dest))); // overlay wins
  for (const [dest, src] of copies) {
    const body = readFileSync(join(srcDir, src));
    contents.set(dest, dest === 'CHANGELOG.md' ? Buffer.from(stripOrgLinks(body.toString('utf8'), owner)) : body);
  }

  // Leak guard — on the final content, before anything is written.
  const leaks = [];
  const internalRefs = [`${owner}/toolkit`, `${owner}/private-`];
  for (const [dest, body] of contents) {
    if (INTERNAL_FILES.includes(dest.split('/').pop())) leaks.push(`${dest}: internal file`);
    const ref = internalRefs.find((r) => body.includes(r));
    if (ref) leaks.push(`${dest}: mentions ${ref}`);
  }
  if (leaks.length) throw new Error(`leak guard:\n  ${leaks.join('\n  ')}`);

  for (const [dest, body] of contents) {
    mkdirSync(dirname(join(outDir, dest)), { recursive: true });
    writeFileSync(join(outDir, dest), body);
  }
  return [...contents.keys()].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === 'notes') {
      process.stdout.write(stripOrgLinks(readFileSync(0, 'utf8'), args[0]));
    } else if (mode === 'tree') {
      const [srcDir, outDir, privateRepo] = args;
      const owner = privateRepo.split('/')[0];
      const { repo, include } = readMirrorConfig(srcDir, privateRepo);
      const cfg = JSON.parse(process.env.CONFIG || 'null');
      if (!cfg) throw new Error('CONFIG (resolve-config json) is required');
      const generated = publicWorkflows(cfg, repo);
      if (!generated.size) console.error(`::warning::no public workflow template for ${cfg.kind}/${cfg.language} — mirror gets none unless .github/mirror/ provides them`);
      const files = exportTree(srcDir, outDir, owner, include, generated);
      console.error(`Exporting ${files.length} files to ${owner}/${repo}:\n  ${files.join('\n  ')}`);
      console.log(repo);
    } else {
      throw new Error(`unknown mode "${mode}" (tree | notes)`);
    }
  } catch (err) {
    console.error(`::error::${err.message.replace(/\n/g, '%0A')}`);
    process.exit(1);
  }
}
