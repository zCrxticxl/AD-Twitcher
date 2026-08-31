#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { apiRequest, base64url, publishingContext, required, wait } from './publish-lib.mjs';

const { version, archive } = await publishingContext('chrome');
const publisher = required('CHROME_PUBLISHER_ID');
const item = required('CHROME_EXTENSION_ID');
const email = required('CHROME_SERVICE_ACCOUNT_EMAIL');
const privateKey = required('CHROME_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');

const now = Math.floor(Date.now() / 1000);
const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.` +
  base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
const signer = createSign('RSA-SHA256');
signer.update(unsigned);
const assertion = `${unsigned}.${signer.sign(privateKey).toString('base64url')}`;
const tokenBody = new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  assertion
});
const tokenResult = await apiRequest('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: tokenBody
});
const accessToken = tokenResult.data?.access_token;
if (!accessToken) throw new Error('Google OAuth response did not contain an access token');

const name = `publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}`;
const base = `https://chromewebstore.googleapis.com/v2/${name}`;
const headers = { Authorization: `Bearer ${accessToken}` };
let upload = (await apiRequest(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/zip' },
  body: await readFile(archive)
})).data;

for (let attempt = 0; ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(upload?.uploadState) && attempt < 30; attempt++) {
  await wait(10_000);
  const status = (await apiRequest(`${base}:fetchStatus`, { headers })).data;
  upload = { ...upload, uploadState: status?.lastAsyncUploadState };
}
if (!['SUCCEEDED', 'UPLOAD_SUCCEEDED'].includes(upload?.uploadState)) {
  throw new Error(`Chrome package processing ended in ${upload?.uploadState || 'an unknown state'}`);
}
if (upload.crxVersion && upload.crxVersion !== version) {
  throw new Error(`Chrome processed v${upload.crxVersion}, expected v${version}`);
}

const published = (await apiRequest(`${base}:publish`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true })
})).data;
console.log(`Chrome Web Store accepted v${version}; submission state: ${published?.state || 'unknown'}.`);
