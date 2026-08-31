#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Copies the shared source tree to each browser-specific output.
 * Edge deliberately reuses the audited Chrome MV3 manifest and source files.
 */
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_TARGETS,
  TARGET_MANIFEST,
  createDeterministicZip,
  sha256File
} from './scripts/release-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');
const args = process.argv.slice(2);
const wantZip = args.includes('--zip');
const unknown = args.filter((arg) => arg !== '--zip' && !RELEASE_TARGETS.includes(arg));
const picked = args.filter((arg) => RELEASE_TARGETS.includes(arg));
const targets = picked.length ? [...new Set(picked)] : RELEASE_TARGETS;
const SKIP = new Set(Object.values(TARGET_MANIFEST));
SKIP.add('icon512.png');

if (unknown.length) {
  console.error(`Unknown build argument(s): ${unknown.join(', ')}`);
  process.exit(1);
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of (await readdir(from)).sort()) {
    if (SKIP.has(entry)) continue;
    const source = join(from, entry);
    const target = join(to, entry);
    const info = await lstat(source);
    if (info.isDirectory()) await copyTree(source, target);
    else if (info.isFile()) await cp(source, target);
    else throw new Error(`Unsupported build input: ${relative(ROOT, source)}`);
  }
}

async function countFiles(dir) {
  let files = 0;
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    if ((await stat(path)).isDirectory()) files += await countFiles(path);
    else files++;
  }
  return files;
}

async function buildTarget(target, version) {
  const out = join(DIST, target);
  await rm(out, { recursive: true, force: true });
  await copyTree(SRC, out);

  const manifestPath = join(SRC, TARGET_MANIFEST[target]);
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  if (manifest.version !== version) {
    throw new Error(`${TARGET_MANIFEST[target]} is v${manifest.version}; package.json is v${version}`);
  }
  await writeFile(join(out, 'manifest.json'), manifestText);

  const locales = existsSync(join(out, '_locales'))
    ? (await readdir(join(out, '_locales'))).length
    : 0;
  console.log(`  ${target.padEnd(8)} -> dist/${target}  ` +
    `(${await countFiles(out)} files, ${locales} locales, v${version})`);

  if (!wantZip) return null;
  const archive = join(RELEASE, `ad-twitcher-${target}-v${version}.zip`);
  await createDeterministicZip(out, archive);
  console.log(`  ${''.padEnd(8)}    ${relative(ROOT, archive)}`);
  return archive;
}

async function writeChecksums(archives) {
  const lines = [];
  for (const archive of archives.sort((a, b) => a.localeCompare(b))) {
    lines.push(`${await sha256File(archive)}  ${archive.split(/[\\/]/).pop()}`);
  }
  await writeFile(join(RELEASE, 'SHA256SUMS'), lines.join('\n') + '\n');
}

if (!existsSync(SRC)) {
  console.error('src/ not found.');
  process.exit(1);
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
if (!picked.length) await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
if (wantZip) {
  await rm(RELEASE, { recursive: true, force: true });
  await mkdir(RELEASE, { recursive: true });
}

console.log('AD-Twitcher build');
const archives = [];
for (const target of targets) {
  const archive = await buildTarget(target, pkg.version);
  if (archive) archives.push(archive);
}
if (wantZip) await writeChecksums(archives);
console.log('done.');
