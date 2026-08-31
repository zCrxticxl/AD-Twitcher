/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export const RELEASE_TARGETS = Object.freeze(['chrome', 'edge', 'firefox', 'opera']);
export const TARGET_MANIFEST = Object.freeze({
  chrome: 'manifest.chrome.json',
  edge: 'manifest.chrome.json',
  firefox: 'manifest.firefox.json',
  opera: 'manifest.opera.json'
});
export const VERSION_RX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export async function walkFiles(root, current = root, files = []) {
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walkFiles(root, path, files);
    else if (info.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`Unsupported file type: ${path}`);
  }
  return files.sort();
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const file = await open(path, 'r');
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

function localHeader(name, data, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(name, data, crc, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(0o100644 * 0x10000, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export async function createDeterministicZip(source, destination) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const path of await walkFiles(source)) {
    const name = Buffer.from(path, 'utf8');
    const data = await readFile(join(source, ...path.split('/')));
    const crc = crc32(data);
    const local = localHeader(name, data, crc);
    chunks.push(local, name, data);
    central.push(centralHeader(name, data, crc, offset), name);
    offset += local.length + name.length + data.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const entryCount = central.length / 2;
  if (entryCount > 0xffff || offset > 0xffffffff || centralSize > 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.concat([...chunks, ...central, end]));
}

function locateEndRecord(zip) {
  const lower = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= lower; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end record not found');
}

export async function readZipEntries(path) {
  const zip = await readFile(path);
  const end = locateEndRecord(zip);
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  const commentLength = zip.readUInt16LE(end + 20);
  if (centralOffset + centralSize !== end || end + 22 + commentLength !== zip.length) {
    throw new Error('Invalid ZIP directory boundaries');
  }
  const entries = [];
  let offset = centralOffset;

  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Invalid central record ${index}`);
    const method = zip.readUInt16LE(offset + 10);
    const flags = zip.readUInt16LE(offset + 8);
    const expectedCrc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (flags !== 0x0800) throw new Error(`${name}: unsupported ZIP flags`);
    if (method !== 0 || compressedSize !== size) throw new Error(`${name}: unsupported ZIP compression`);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${name}: invalid local record`);
    const localFlags = zip.readUInt16LE(localOffset + 6);
    const localMethod = zip.readUInt16LE(localOffset + 8);
    const localCrc = zip.readUInt32LE(localOffset + 14);
    const localCompressedSize = zip.readUInt32LE(localOffset + 18);
    const localSize = zip.readUInt32LE(localOffset + 22);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    if (localName !== name || localFlags !== flags || localMethod !== method ||
        localCrc !== expectedCrc || localCompressedSize !== compressedSize || localSize !== size) {
      throw new Error(`${name}: local and central ZIP records differ`);
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataOffset, dataOffset + size);
    if (data.length !== size || crc32(data) !== expectedCrc) throw new Error(`${name}: corrupt ZIP entry`);
    entries.push({ name, data: Buffer.from(data), crc32: expectedCrc });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (offset !== centralOffset + centralSize) throw new Error('Invalid ZIP central directory size');
  return entries;
}
