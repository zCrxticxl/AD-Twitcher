#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */
import { readFile } from 'node:fs/promises';
import { apiRequest, publishingContext, required, wait } from './publish-lib.mjs';

const { version, archive } = await publishingContext('edge');
const productId = required('EDGE_PRODUCT_ID');
const clientId = required('EDGE_CLIENT_ID');
const apiKey = required('EDGE_API_KEY');
const base = `https://api.addons.microsoftedge.microsoft.com/v1/products/${encodeURIComponent(productId)}`;
const headers = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

const upload = await apiRequest(`${base}/submissions/draft/package`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/zip' },
  body: await readFile(archive)
});
const location = upload.response.headers.get('location');
if (!location) throw new Error('Edge upload response did not provide an operation location');
const operationId = location.split('/').filter(Boolean).pop();
if (!operationId || !/^[A-Za-z0-9-]+$/.test(operationId)) throw new Error('Edge returned an invalid operation ID');

let operation;
for (let attempt = 0; attempt < 30; attempt++) {
  operation = (await apiRequest(`${base}/submissions/draft/package/operations/${operationId}`, { headers })).data;
  if (operation?.status === 'Succeeded' || operation?.status === 'Failed') break;
  await wait(10_000);
}
if (operation?.status !== 'Succeeded') {
  throw new Error(`Edge package processing ended in ${operation?.status || 'an unknown state'}`);
}

const submission = await apiRequest(`${base}/submissions`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'text/plain' },
  body: `Automated AD-Twitcher v${version} release`
});
const submissionLocation = submission.response.headers.get('location');
if (!submissionLocation) throw new Error('Edge submission response did not provide an operation location');
const submissionOperationId = submissionLocation.split('/').filter(Boolean).pop();
if (!submissionOperationId || !/^[A-Za-z0-9-]+$/.test(submissionOperationId)) {
  throw new Error('Edge returned an invalid submission operation ID');
}

let submissionStatus;
for (let attempt = 0; attempt < 30; attempt++) {
  submissionStatus = (await apiRequest(`${base}/submissions/operations/${submissionOperationId}`, { headers })).data;
  if (submissionStatus?.status === 'Succeeded' || submissionStatus?.status === 'Failed') break;
  await wait(10_000);
}
if (submissionStatus?.status !== 'Succeeded') {
  throw new Error(`Edge submission ended in ${submissionStatus?.status || 'an unknown state'}`);
}
console.log(`Microsoft Edge Add-ons accepted v${version}; submission status: ${submissionStatus.status}.`);
