#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { apiRequest, base64url, publishingContext, required, wait } from './publish-lib.mjs';

const { version, archive } = await publishingContext('firefox');
const addonId = required('AMO_EXTENSION_ID');
const apiKey = required('WEB_EXT_API_KEY');
const apiSecret = required('WEB_EXT_API_SECRET');
if (addonId !== 'ad-twitcher@zcrxticxl') throw new Error('AMO_EXTENSION_ID does not match the Firefox manifest ID');

function authorization() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.` +
    base64url(JSON.stringify({ iss: apiKey, jti: randomUUID(), iat: now, exp: now + 60 }));
  const signature = createHmac('sha256', apiSecret).update(unsigned).digest('base64url');
  return `JWT ${unsigned}.${signature}`;
}

const form = new FormData();
form.append('upload', new Blob([await readFile(archive)], { type: 'application/zip' }), archive.split(/[\\/]/).pop());
form.append('channel', 'listed');
let upload = (await apiRequest('https://addons.mozilla.org/api/v5/addons/upload/', {
  method: 'POST',
  headers: { Authorization: authorization() },
  body: form
})).data;
if (!upload?.uuid) throw new Error('AMO upload response did not contain a UUID');

for (let attempt = 0; upload.processed !== true && attempt < 30; attempt++) {
  await wait(10_000);
  upload = (await apiRequest(`https://addons.mozilla.org/api/v5/addons/upload/${encodeURIComponent(upload.uuid)}/`, {
    headers: { Authorization: authorization() }
  })).data;
}
if (upload.processed !== true) throw new Error('AMO validation timed out');
if (upload.valid !== true) throw new Error('AMO rejected the uploaded package during validation');
if (upload.version !== version) throw new Error(`AMO validated v${upload.version}, expected v${version}`);

const submitted = (await apiRequest(
  `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/`,
  {
    method: 'POST',
    headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload: upload.uuid })
  }
)).data;
if (submitted?.version !== version) throw new Error('AMO version submission response did not confirm the expected version');
console.log(`Firefox AMO accepted listed version ${submitted.version}; file status: ${submitted.file?.status || 'unknown'}.`);
