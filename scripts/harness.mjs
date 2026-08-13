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

function watchContentSandbox() {
  let nextTimer = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const sent = [];
  const video = {
    currentTime: 10, paused: false, ended: false, readyState: 4,
    isConnected: true, clientWidth: 1280, clientHeight: 720
  };
  const document = {
    querySelectorAll: (selector) => selector === 'video' ? [video] : [],
    addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    globalThis: null, window: null, document, console, Promise, Number,
    setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener() {}, removeEventListener() {},
    ADT: {
      dom: {currentChannel: () => 'testchannel'}, modules: {},
      send(msg) { sent.push(msg); return Promise.resolve({ok: true}); }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/content/modules/watch-health.js'), sandbox);
  return {sandbox, video, sent, timeouts, intervals};
}

function watchBackgroundSandbox() {
  let now = 1000000;
  const data = {};
  const notifications = [];
  const cleared = [];
  const updates = [];
  const reloads = [];
  class FakeDate extends Date { static now() { return now; } }
  const api = {
    storage: {local: {
      get(key) { return Promise.resolve({[key]: data[key]}); },
      set(patch) { Object.assign(data, patch); return Promise.resolve(); }
    }},
    tabs: {
      get: (tabId) => Promise.resolve({id: tabId, discarded: false, frozen: false}),
      update(tabId, patch) { updates.push({tabId, patch}); return Promise.resolve(); },
      reload(tabId) { reloads.push(tabId); return Promise.resolve(); }
    },
    notifications: {
      create(id, options) { notifications.push({id, options}); return Promise.resolve(id); },
      clear(id) { cleared.push(id); return Promise.resolve(true); },
      onClicked: {addListener() {}}
    },
    runtime: {getURL: (path) => 'extension://' + path}
  };
  const sandbox = {
    globalThis: null, self: null, console, Promise, Number, Date: FakeDate,
    ADT: {
      api, log: {warn() {}},
      msg: (key, value) => key + ':' + value,
      settings: {get: () => Promise.resolve({
        enabled: true,
        watchHealth: {
          enabled: true, keepAwake: true, notifications: true,
          recoverTab: true, staleAfterMin: 5
        }
      })}
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/background/watch-health.js'), sandbox);
  return {
    sandbox, notifications, cleared, updates, reloads,
    advance(ms) { now += ms; }
  };
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
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30});
  [...h.timeouts.values()][0]();
  h.video.currentTime = 11;
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('watchdog reports a playing channel', h.sent[0].playing === true);
  assert('watchdog detects advancing video time', h.sent[1].advancing === true);
  h.sandbox.ADT.modules.watchHealth.stop();
  const before = h.sent.length;
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('watchdog sends no heartbeat after stop()', h.sent.length === before);
}
{
  const h = watchBackgroundSandbox();
  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'testchannel', playing: true, advancing: false
  }, 42);
  assert('watchdog protects the stream tab from discarding',
    h.updates.length === 1 && h.updates[0].patch.autoDiscardable === false);
  h.advance(6 * 60000);
  await h.sandbox.ADT.watchHealth.check();
  await h.sandbox.ADT.watchHealth.check();
  assert('stalled playback creates one notification', h.notifications.length === 1);
  assert('stalled playback triggers one recovery reload', h.reloads.length === 1);
  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'testchannel', playing: true, advancing: true
  }, 42);
  assert('advancing playback clears the stale notification', h.cleared.length === 1);
}

console.log(failures ? `\n${failures} harness failure(s).\n` : '\nLifecycle harness clean.\n');
process.exit(failures ? 1 : 0);
