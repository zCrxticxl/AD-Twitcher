#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Build script. Copies src/ to dist/<target>/ and drops the
 * matching manifest in place. No bundler and no transpiler: the extension ships
 * as plain ES5-compatible JavaScript.
 *
 *   node build.mjs                 both targets
 *   node build.mjs chrome          Chrome only
 *   node build.mjs firefox --zip   Firefox plus a zip in dist/
 */
import { cp, rm, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const TARGETS = ['chrome', 'firefox'];
const args = process.argv.slice(2);
const wantZip = args.includes('--zip');
const picked = args.filter((a) => TARGETS.includes(a));
const targets = picked.length ? picked : TARGETS;

/** Build inputs that must not end up in the output. */
const SKIP = new Set(['manifest.chrome.json', 'manifest.firefox.json', 'icon512.png']);

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from)) {
    if (SKIP.has(entry)) continue;
    const source = join(from, entry);
    const target = join(to, entry);
    if ((await stat(source)).isDirectory()) await copyTree(source, target);
    else await cp(source, target);
  }
}

async function countFiles(dir) {
  let files = 0;
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    if ((await stat(p)).isDirectory()) files += await countFiles(p);
    else files++;
  }
  return files;
}

async function buildTarget(target) {
  const out = join(DIST, target);
  await rm(out, { recursive: true, force: true });
  await copyTree(SRC, out);

  const manifest = JSON.parse(await readFile(join(SRC, `manifest.${target}.json`), 'utf8'));

  // Mirror the version from package.json so there is a single source of truth.
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  manifest.version = pkg.version;

  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const locales = existsSync(join(out, '_locales'))
    ? (await readdir(join(out, '_locales'))).length
    : 0;
  const files = await countFiles(out);

  console.log(`  ${target.padEnd(8)} -> dist/${target}  ` +
    `(${files} files, ${locales} locales, v${manifest.version})`);

  if (!wantZip) return;

  const zipPath = join(DIST, `ad-twitcher-${target}-v${manifest.version}.zip`);
  await rm(zipPath, { force: true });
  try {
    await execFileP('zip', ['-qr', zipPath, '.'], { cwd: out });
    console.log(`  ${''.padEnd(8)}    ${zipPath.replace(ROOT + '/', '')}`);
  } catch {
    console.warn('  (zip not found, archive skipped)');
  }
}

if (!existsSync(SRC)) {
  console.error('src/ not found.');
  process.exit(1);
}

console.log('AD-Twitcher build');
for (const t of targets) await buildTarget(t);
console.log('done.');
