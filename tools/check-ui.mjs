#!/usr/bin/env node
/**
 * Static checks for the unbundled UI.
 *
 * The pages ship to the WebView as plain ES modules — there is no bundler, so a typo in
 * an import name is not found until an operator opens that page and gets a blank screen.
 * This walks every module, parses it, and resolves each named import against the real
 * exports of the file it points at.
 *
 *   node tools/check-ui.mjs            # from the repo root
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'js');

function modules(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'vendor') out.push(...modules(p));
    } else if (e.name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+\*/.test(src)) names.add('*'); // re-export: can't resolve statically, accept
  return names;
}

const rel = (p) => path.relative(process.cwd(), p);
const problems = [];
const files = modules(root);

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  // 1. does it parse as a module at all? node's own parser is the authority here.
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = (e.stderr ? e.stderr.toString() : e.message).trim().split('\n').slice(0, 3).join(' ');
    problems.push(`${rel(file)}: ${detail}`);
    continue;
  }

  // 2. does every named import exist in the module it names?
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), m[2]);
    if (!fs.existsSync(target)) {
      problems.push(`${rel(file)}: imports '${m[2]}', which does not exist`);
      continue;
    }
    const available = exportsOf(target);
    if (available.has('*')) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) {
        problems.push(`${rel(file)}: '${name}' is not exported by ${m[2]}`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  console.error(`\n${problems.length} problem(s) in ${files.length} modules`);
  process.exit(1);
}
console.log(`ok: ${files.length} modules parse and every named import resolves`);
