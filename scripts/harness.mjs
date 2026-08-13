#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/** @fileoverview Dependency-free lifecycle harness for delayed DOM actions. */
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
let failures = 0;
function assert(name, value) {
  console.log(`  ${value ? 'ok  ' : 'FAIL'} ${name}`);
  if (!value) failures++;
}

function lifecycleSandbox(path, page, options = {}) {
  let nextTimer = 1;
  const timeouts = new Map();
  let clicks = 0;
  const body = {};
  const buttonText = options.buttonText || 'Claim';
  const button = {
    tagName: 'BUTTON', isConnected: true, disabled: false,
    className: 'claimable-bonus',
    closest: () => button, querySelector: () => null,
    getAttribute: (name) => name === 'aria-disabled' ? 'false' : 'Bonus'
  };
  const D = {
    q: () => button,
    qAny: () => page === 'drops'
      ? (options.legacyRoot === false ? null : {})
      : button,
    qaAny: () => options.attributeMatch === false ? [] : [button],
    buttonsByText: (patterns, root) => root === body && patterns.some((pattern) =>
      String(pattern).toLowerCase() === buttonText.toLowerCase()) ? [button] : [],
    isVisible: () => true, isDangerous: () => false, inModal: () => false,
    safeClick: () => { clicks++; return true; }, textOf: () => buttonText,
    currentChannel: () => 'test', toast() {}, observe: () => ({disconnect() {}}),
    waitFor: () => Promise.resolve(null)
  };
  const sandbox = {
    globalThis: null, window: null, document: {body},
    location: {pathname: page === 'drops' ? '/drops/inventory' : '/test'},
    console, WeakSet, Set, Promise,
    setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval() { return nextTimer++; }, clearInterval() {},
    ADT: {
      dom: D, log: {debug() {}, info() {}}, modules: {}, state: {},
      jitter: () => 1, countStat() {}, msg: (key) => key, send() {}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(path), sandbox);
  return {sandbox, timeouts, clicks: () => clicks};
}

console.log('\n[lifecycle harness]');
{
  const h = lifecycleSandbox('src/content/modules/channel-points.js', 'points');
  h.sandbox.ADT.modules.channelPoints.start({scanIntervalMs: 4000, minDelayMs: 1, jitterMs: 0, cooldownMs: 100});
  h.sandbox.ADT.modules.channelPoints.stop();
  [...h.timeouts.values()].forEach((fn) => fn());
  assert('channel-points cannot click after stop()', h.clicks() === 0);
}
{
  const h = lifecycleSandbox('src/content/modules/drops.js', 'drops');
  h.sandbox.ADT.modules.drops.start({autoClaim: true, watchNotifications: true});
  h.sandbox.ADT.modules.drops.claimNow();
  h.sandbox.ADT.modules.drops.stop();
  [...h.timeouts.values()].forEach((fn) => fn());
  assert('drops cannot click after stop()', h.clicks() === 0);
}
{
  const h = lifecycleSandbox('src/content/modules/drops.js', 'drops', {
    legacyRoot: false,
    attributeMatch: false,
    buttonText: 'Jetzt abholen'
  });
  h.sandbox.ADT.modules.drops.start({autoClaim: true, watchNotifications: true});
  h.sandbox.ADT.modules.drops.claimNow();
  [...h.timeouts.values()].forEach((fn) => fn());
  assert('drops claim "Jetzt abholen" without a legacy inventory root', h.clicks() === 1);
  h.sandbox.ADT.modules.drops.stop();
}

console.log(failures ? `\n${failures} harness failure(s).\n` : '\nLifecycle harness clean.\n');
process.exit(failures ? 1 : 0);
