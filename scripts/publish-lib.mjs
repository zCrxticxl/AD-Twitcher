/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './release-lib.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment value ${name} is not configured`);
  return value;
}

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export async function publishingContext(target) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF_TYPE !== 'tag') {
    throw new Error('Store publishing is restricted to GitHub Actions tag jobs');
  }
  if (process.env.GITHUB_REF_NAME !== `v${pkg.version}`) {
    throw new Error(`Tag ${process.env.GITHUB_REF_NAME || '(missing)'} does not match v${pkg.version}`);
  }
  const archiveName = `ad-twitcher-${target}-v${pkg.version}.zip`;
  const archive = join(ROOT, 'release', archiveName);
  const checksums = await readFile(join(ROOT, 'release', 'SHA256SUMS'), 'utf8');
  const expected = checksums.split(/\r?\n/)
    .map((line) => line.match(/^([0-9a-f]{64})  (.+)$/))
    .find((match) => match?.[2] === archiveName)?.[1];
  if (!expected || await sha256File(archive) !== expected) {
    throw new Error(`${archiveName} does not match release/SHA256SUMS`);
  }
  return { version: pkg.version, archive };
}

/** Files whose first line must name the version being released. */
export const AMO_NOTES = Object.freeze({
  release: 'docs/amo-version-notes.txt',
  approval: 'docs/amo-reviewer-notes.txt'
});

/**
 * Reads the AMO release and reviewer notes, refusing ones written for another
 * version: stale notes would reach users and reviewers under the new version.
 */
export async function amoNotes(version) {
  const out = {};
  const exact = new RegExp(`(^|\\s)${version.replace(/\./g, '\\.')}(\\s|$)`);
  for (const [kind, path] of Object.entries(AMO_NOTES)) {
    const text = (await readFile(join(ROOT, path), 'utf8')).replace(/\r\n/g, '\n').trim();
    if (!exact.test(text.split('\n')[0])) {
      throw new Error(`${path} does not start with a line naming v${version}`);
    }
    out[kind] = text;
  }
  return out;
}

export async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = typeof data === 'object' && data
      ? data.error?.message || data.detail || data.message
      : null;
    throw new Error(`HTTP ${response.status} from ${new URL(url).host}${message ? `: ${message}` : ''}`);
  }
  return { response, data };
}

export async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
