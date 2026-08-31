#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  RELEASE_TARGETS,
  TARGET_MANIFEST,
  VERSION_RX,
  readZipEntries,
  sha256File,
  walkFiles
} from './release-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');
const SOURCE_MANIFESTS = [...new Set(Object.values(TARGET_MANIFEST))];
const EXPECTED_PERMISSIONS = ['storage', 'tabs', 'alarms', 'scripting', 'notifications'];
const FORBIDDEN_ARCHIVE = /(^|\/)(?:\.DS_Store|Thumbs\.db|\.env(?:\..*)?|package(?:-lock)?\.json|node_modules|store|docs)(?:\/|$)|\.(?:map|pem|key|p12|pfx)$/i;
const execFileP = promisify(execFile);
let errors = 0;
const ok = (message) => console.log(`  ok   ${message}`);
const fail = (message) => { console.error(`  FAIL ${message}`); errors++; };

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

function validArchiveName(name) {
  return name && !name.includes('\\') && !name.startsWith('/') &&
    !name.split('/').includes('..') && !FORBIDDEN_ARCHIVE.test(name);
}

function validateManifest(manifest, target, version) {
  if (manifest.version !== version) fail(`${target}: manifest version is ${manifest.version}`);
  if (target === 'firefox') {
    if (manifest.manifest_version !== 2) fail('firefox: expected Manifest V2');
    if (manifest.browser_specific_settings?.gecko?.id !== 'ad-twitcher@zcrxticxl') {
      fail('firefox: stable add-on ID changed');
    }
    if (manifest.background?.persistent !== true) fail('firefox: persistent background changed');
    const expected = ['storage', 'tabs', 'alarms', 'notifications', '*://*.twitch.tv/*'];
    if (JSON.stringify(manifest.permissions) !== JSON.stringify(expected)) {
      fail('firefox: unexpected permission set');
    }
    if (JSON.stringify(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required) !==
        JSON.stringify(['none'])) {
      fail('firefox: data collection declaration changed');
    }
  } else {
    if (manifest.manifest_version !== 3) fail(`${target}: expected Manifest V3`);
    if (JSON.stringify(manifest.permissions) !== JSON.stringify(EXPECTED_PERMISSIONS)) {
      fail(`${target}: unexpected permission set`);
    }
    if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['*://*.twitch.tv/*'])) {
      fail(`${target}: Twitch host permission changed`);
    }
  }
}

async function scanRepositoryFiles() {
  const { stdout } = await execFileP('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024
  });
  const tracked = stdout.toString('utf8').split('\0').filter(Boolean);
  for (const rel of tracked) {
    const path = join(ROOT, ...rel.split('/'));
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      fail(`tracked symbolic link present: ${rel}`);
      continue;
    }
    const name = rel.split('/').pop();
    if (/^\.env(?:\..*)?$|\.(?:pem|key|p12|pfx)$/i.test(name)) {
      fail(`credential-like file present: ${rel}`);
      continue;
    }
    if (info.size > 1024 * 1024 || /\.(?:png|jpg|jpeg|gif|webp|ico|zip|xpi)$/i.test(name)) continue;
    const text = await readFile(path, 'utf8');
    const signatures = [
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bAIza[0-9A-Za-z_-]{35}\b/
    ];
    if (signatures.some((pattern) => pattern.test(text))) fail(`possible credential in ${rel}`);
  }
}

async function validateSource(version) {
  const before = errors;
  for (const manifestName of SOURCE_MANIFESTS) {
    const manifest = JSON.parse(await readFile(join(SRC, manifestName), 'utf8'));
    if (manifest.version !== version) fail(`${manifestName}: version does not match package.json`);
  }
  const chrome = await readFile(join(SRC, 'manifest.chrome.json'), 'utf8');
  const opera = await readFile(join(SRC, 'manifest.opera.json'), 'utf8');
  chrome === opera ? ok('Chrome and Opera manifests are byte-identical') : fail('Opera manifest drifted from Chrome');

  for (const path of await walkFiles(SRC)) {
    if (!path.endsWith('.js')) continue;
    const source = await readFile(join(SRC, ...path.split('/')), 'utf8');
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b/.test(source)) {
      fail(`${path}: unexpected network API`);
    }
    if (/\beval\s*\(|\bnew\s+Function\s*\(|importScripts\s*\(\s*['"]https?:/i.test(source)) {
      fail(`${path}: possible remote or evaluated code`);
    }
  }
  if (errors === before) ok('extension source contains no direct network or remote-code path');
}

async function expectedBuildFiles() {
  return (await walkFiles(SRC))
    .filter((path) => !SOURCE_MANIFESTS.includes(path) && !path.endsWith('/icon512.png'))
    .concat('manifest.json')
    .sort();
}

async function validateAutomationPolicy() {
  const ci = await readFile(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const release = await readFile(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  if (/pull_request_target/.test(ci + release)) fail('workflows must not use pull_request_target');
  if (/\$\{\{\s*secrets\./.test(ci)) fail('ordinary CI references production secrets');
  else ok('ordinary CI has no secret references');
  if (!/permissions:\s*\n\s*contents: read/.test(ci) || !/permissions:\s*\n\s*contents: read/.test(release)) {
    fail('workflow default permissions are not read-only');
  } else {
    ok('workflow default permissions are read-only');
  }
  const mutableActions = [...(ci + release).matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)]
    .map((match) => match[1])
    .filter((reference) => !/^[0-9a-f]{40}$/.test(reference));
  if (mutableActions.length) fail(`workflow action references are mutable: ${mutableActions.join(', ')}`);
  else ok('workflow actions are pinned to immutable commits');
  const releaseLines = release.split('\n');
  for (const job of ['github-release', 'publish-chrome', 'publish-firefox', 'publish-edge']) {
    const start = releaseLines.indexOf(`  ${job}:`);
    const next = releaseLines.findIndex((line, index) => index > start && /^  [a-z0-9-]+:$/.test(line));
    const block = start < 0 ? '' : releaseLines.slice(start, next < 0 ? undefined : next).join('\n');
    if (!/environment: production/.test(block)) fail(`${job} is not protected by production`);
  }
}

async function validateOutputs(version) {
  const expected = await expectedBuildFiles();
  const checksumText = await readFile(join(RELEASE, 'SHA256SUMS'), 'utf8');
  const checksumLines = checksumText.trim().split('\n');
  const expectedArchives = RELEASE_TARGETS.map((target) => `ad-twitcher-${target}-v${version}.zip`).sort();
  const listedArchives = checksumLines.map((line) => line.match(/^[0-9a-f]{64}  (.+)$/)?.[1]).sort();
  if (JSON.stringify(listedArchives) !== JSON.stringify(expectedArchives)) fail('SHA256SUMS artifact list is incomplete');

  for (const target of RELEASE_TARGETS) {
    const dist = join(DIST, target);
    const builtFiles = await walkFiles(dist);
    if (JSON.stringify(builtFiles) !== JSON.stringify(expected)) fail(`${target}: unexpected dist contents`);
    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    validateManifest(manifest, target, version);

    const archiveName = `ad-twitcher-${target}-v${version}.zip`;
    const archive = join(RELEASE, archiveName);
    const entries = await readZipEntries(archive);
    const names = entries.map((entry) => entry.name);
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`${archiveName}: contents differ from dist`);
    if (names.filter((name) => name === 'manifest.json').length !== 1) fail(`${archiveName}: manifest.json must be at archive root`);
    for (const entry of entries) {
      if (!validArchiveName(entry.name)) fail(`${archiveName}: forbidden path ${entry.name}`);
      const disk = await readFile(join(dist, ...entry.name.split('/')));
      if (hash(disk) !== hash(entry.data)) fail(`${archiveName}: ${entry.name} differs from dist`);
    }
    const listed = checksumLines.find((line) => line.endsWith(`  ${archiveName}`));
    if (!listed || listed.slice(0, 64) !== await sha256File(archive)) fail(`${archiveName}: checksum mismatch`);
  }

  const chrome = await readFile(join(DIST, 'chrome', 'manifest.json'));
  const edge = await readFile(join(DIST, 'edge', 'manifest.json'));
  chrome.equals(edge) ? ok('Edge reuses the exact Chrome MV3 manifest') : fail('Edge manifest differs from Chrome');
  return Object.fromEntries(await Promise.all(
    [...expectedArchives, 'SHA256SUMS'].map(async (name) => [name, await sha256File(join(RELEASE, name))])
  ));
}

console.log('\n[release] Repository and source policy');
if (Number(process.versions.node.split('.')[0]) < 22) fail(`Node ${process.versions.node} is below the required Node 22`);
else ok(`Node ${process.versions.node}`);
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
if (!VERSION_RX.test(pkg.version)) fail(`package.json version ${pkg.version} is not X.Y.Z`);
else ok(`version ${pkg.version}`);
try {
  const lock = JSON.parse(await readFile(join(ROOT, 'package-lock.json'), 'utf8'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) fail('package-lock.json version drift');
  else ok('package-lock.json version matches');
} catch (error) {
  fail(`package-lock.json: ${error.message}`);
}
await scanRepositoryFiles();
await validateSource(pkg.version);
await validateAutomationPolicy();

console.log('\n[release] Build and archive validation');
await run(process.execPath, ['build.mjs', '--zip']);
const first = await validateOutputs(pkg.version);
await run(process.execPath, ['build.mjs', '--zip']);
const second = await validateOutputs(pkg.version);
JSON.stringify(first) === JSON.stringify(second)
  ? ok('two clean package runs produced identical SHA256 hashes')
  : fail('release archives are not deterministic');

console.log(errors ? `\n${errors} release problem(s).\n` : '\nRelease artifacts verified.\n');
process.exit(errors ? 1 : 0);
