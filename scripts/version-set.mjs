#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_RX } from './release-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
if (!version || process.argv.length !== 3 || !VERSION_RX.test(version)) {
  console.error('Usage: npm run version:set -- X.Y.Z');
  process.exit(1);
}
if (version.split('.').some((part) => Number(part) > 65535)) {
  console.error('Each version component must be between 0 and 65535 for Chromium stores.');
  process.exit(1);
}

const jsonFiles = [
  'package.json',
  'src/manifest.chrome.json',
  'src/manifest.firefox.json',
  'src/manifest.opera.json'
];

for (const relativePath of jsonFiles) {
  const path = join(ROOT, relativePath);
  const text = await readFile(path, 'utf8');
  const parsed = JSON.parse(text);
  if (typeof parsed.version !== 'string') throw new Error(`${relativePath} has no string version field`);
  await writeFile(path, text.replace(
    /("version"\s*:\s*")[^"]+("\s*[},])/, `$1${version}$2`
  ));
}

const lockPath = join(ROOT, 'package-lock.json');
try {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(`Set AD-Twitcher version to ${version}.`);
