#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await new Promise((resolve, reject) => {
  const child = spawn(npm, ['run', 'verify'], { cwd: ROOT, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`verify exited with ${signal || code}`)));
});

const checksums = await readFile(join(ROOT, 'release', 'SHA256SUMS'), 'utf8');
console.log('\nDry run complete. No network requests or publishing operations were performed.');
console.log('Validated destinations: GitHub Release, Chrome Web Store, Firefox AMO, and Microsoft Edge Add-ons.');
console.log('Opera GX remains a separately packaged manual submission target.');
console.log('\nArtifacts:\n' + checksums.trim());
