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
  let now = 1000000;
  const timeouts = new Map();
  let clicks = 0;
  class FakeDate extends Date { static now() { return now; } }
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
    globalThis: null, window: null,
    document: {body, visibilityState: options.visibilityState || 'visible'},
    location: {pathname: page === 'drops' ? '/drops/inventory' : '/test'},
    console, WeakSet, Set, Promise, Date: FakeDate,
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
  return {sandbox, timeouts, clicks: () => clicks, advance(ms) { now += ms; }};
}

function watchContentSandbox() {
  let nextTimer = 1;
  let now = 1000000;
  const timeouts = new Map();
  const intervals = new Map();
  const sent = [];
  const handlers = new Map();
  class FakeDate extends Date { static now() { return now; } }
  const video = {
    tagName: 'VIDEO',
    currentTime: 10, paused: false, ended: false, readyState: 4,
    isConnected: true, clientWidth: 1280, clientHeight: 720,
    plays: 0,
    closest: () => null,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
  };
  const listen = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  };
  const unlisten = (type, fn) => {
    handlers.set(type, (handlers.get(type) || []).filter((x) => x !== fn));
  };
  const document = {
    querySelectorAll: (selector) => selector === 'video' ? [video] : [],
    addEventListener: listen, removeEventListener: unlisten
  };
  const sandbox = {
    globalThis: null, window: null, document, console, Promise, Number, String,
    Date: FakeDate,
    setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn) { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener: listen, removeEventListener: unlisten,
    ADT: {
      dom: {currentChannel: () => 'testchannel'}, modules: {},
      log: {debug() {}, info() {}, warn() {}},
      send(msg) { sent.push(msg); return Promise.resolve({ok: true}); }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/content/modules/watch-health.js'), sandbox);
  return {
    sandbox, video, sent, timeouts, intervals,
    advance(ms) { now += ms; },
    fire(type, event) {
      (handlers.get(type) || []).forEach((fn) => fn(Object.assign({type}, event)));
    },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      pending.forEach((fn) => fn());
    }
  };
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

/**
 * Boots background/sw.js against stub APIs and drives it through its own
 * message router. `storage` is passed in so a second boot on the same data can
 * stand in for what Chrome does routinely: terminate the worker mid-ad break.
 *
 * @param {!Object=} storage Shared storage.local backing object.
 * @param {!Object=} tabs Tab id to tab record.
 */
function swSandbox(storage = {}, tabs = {}) {
  const messageHandlers = [];
  const timeouts = new Map();
  let nextTimer = 1;
  const updates = [];
  const reloads = [];
  const claims = [];
  let claimReport = null;

  const api = {
    storage: {
      local: {
        get: (key) => Promise.resolve({[key]: storage[key]}),
        set: (patch) => { Object.assign(storage, patch); return Promise.resolve(); }
      },
      onChanged: {addListener() {}}
    },
    tabs: {
      get: (id) => tabs[id]
        ? Promise.resolve(tabs[id])
        : Promise.reject(new Error('no tab ' + id)),
      update(id, patch) {
        updates.push({id, patch});
        if (tabs[id] && patch.muted !== undefined) {
          tabs[id].mutedInfo = patch.muted
            ? {muted: true, reason: 'extension', extensionId: 'adt'}
            : {muted: false};
        }
        return Promise.resolve(tabs[id]);
      },
      query: (q) => Promise.resolve(
        Array.isArray(q.url) ? Object.values(tabs).filter((t) => t.inventory) : []),
      create: () => Promise.resolve({id: 99}),
      remove: () => Promise.resolve(),
      reload(id) { reloads.push(id); return Promise.resolve(); },
      onRemoved: {addListener() {}},
      onUpdated: {addListener() {}, removeListener() {}}
    },
    alarms: {create() {}, clear() {}, onAlarm: {addListener() {}}},
    runtime: {
      id: 'adt',
      getManifest: () => ({manifest_version: 3, content_scripts: [{js: [], css: []}]}),
      onMessage: {addListener(fn) { messageHandlers.push(fn); }},
      onInstalled: {addListener() {}},
      onStartup: {addListener() {}}
    }
  };

  const sandbox = {
    globalThis: null, self: null, console, Promise, Number, Date, Object, Array,
    setTimeout(fn) { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    ADT: {
      api,
      log: {debug() {}, info() {}, warn() {}, error() {}, setLevel() {}},
      settings: {
        get: () => Promise.resolve({
          enabled: true,
          logLevel: 'info',
          drops: {
            enabled: true, autoClaim: true, openInventoryTab: true,
            refreshInventory: true, checkIntervalMin: 120, closeAfterMs: 25000
          }
        }),
        configSig: () => 'sig',
        onChange() {}
      },
      liveWatch: {forgetTab() {}, status: () => Promise.resolve({})},
      watchHealth: {forgetTab() {}, check: () => Promise.resolve()},
      pingTab: () => Promise.resolve({ok: true}),
      sendToTab(tabId, msg) {
        if (msg.type === 'adt:claim-drops-now') {
          claims.push(tabId);
          return Promise.resolve(claimReport);
        }
        return Promise.resolve(null);
      },
      sleep: () => Promise.resolve()
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src/background/sw.js'), sandbox);

  return {
    storage, tabs, updates, reloads, claims,
    setClaimReport(report) { claimReport = report; },
    send(msg, tabId) {
      messageHandlers.forEach((fn) => fn(msg, {tab: {id: tabId}}, () => {}));
    },
    /** Lets the promise chains inside the worker run to completion. */
    async settle(rounds = 12) {
      for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        const pending = [...timeouts.values()];
        timeouts.clear();
        pending.forEach((fn) => fn());
        await Promise.resolve();
      }
    }
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
  /*
   * A drop that finishes after the inventory page was rendered has no claim
   * button in that DOM. The report is what tells the background that a reload,
   * not another scan, is the missing step.
   */
  const h = lifecycleSandbox('src/content/modules/drops.js', 'drops', {
    legacyRoot: false, attributeMatch: false, buttonText: 'Jetzt abholen'
  });
  h.sandbox.ADT.modules.drops.start({
    autoClaim: true, watchNotifications: true, refreshInventory: true
  });
  const fresh = h.sandbox.ADT.modules.drops.claimNow();
  assert('claim report counts the buttons it is about to click', fresh.pending === 1);
  assert('a freshly loaded inventory view is not stale', fresh.stale === false);

  h.advance(120000);
  const aged = h.sandbox.ADT.modules.drops.claimNow();
  assert('an aged inventory view reports itself stale', aged.stale === true);
  assert('and has nothing left to click', aged.pending === 0);
  h.sandbox.ADT.modules.drops.stop();
}
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  assert('watchdog resumes a player that paused on its own', h.video.plays === 1);
  assert('the resumed player is playing again', h.video.paused === false);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  h.fire('keydown', {key: ' '});              // The user hits space.
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  assert('a pause the user asked for is left alone', h.video.plays === 0);

  h.video.paused = false;
  h.fire('playing', {target: h.video});       // They start it again themselves.
  h.advance(60000);                           // A minute of watching later.
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  assert('the next unrequested pause is repaired again', h.video.plays === 1);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  for (let i = 0; i < 12; i++) {
    h.video.paused = true;
    h.fire('pause', {target: h.video});
    h.runTimeouts();
  }
  assert('a player that keeps pausing cannot become a resume loop',
    h.video.plays === 6);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: false});
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  assert('the pause guard stays off when it is disabled', h.video.plays === 0);
  h.sandbox.ADT.modules.watchHealth.stop();
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

{
  const storage = {};
  const tabs = {
    7: {id: 7, mutedInfo: {muted: false}},
    8: {id: 8, mutedInfo: {muted: true, reason: 'user'}}
  };
  const h = swSandbox(storage, tabs);

  h.send({type: 'adt:tab-mute', muted: true}, 7);
  await h.settle();
  assert('an ad mutes the tab, not the player',
    h.updates.some((u) => u.id === 7 && u.patch.muted === true));
  assert('and the mute is recorded where a worker restart cannot lose it',
    !!(storage.adMuteRuntime && storage.adMuteRuntime.tabs['7']));

  h.send({type: 'adt:tab-mute', muted: true}, 8);
  await h.settle();
  assert('a tab the user muted by hand is not touched',
    !h.updates.some((u) => u.id === 8));

  /*
   * Chrome kills the MV3 worker while the ad is still running. The unmute
   * therefore arrives at a worker that never saw the mute happen.
   */
  const restarted = swSandbox(storage, tabs);
  restarted.send({type: 'adt:tab-mute', muted: false}, 7);
  await restarted.settle();
  assert('a restarted worker still knows the mute was ours',
    restarted.updates.some((u) => u.id === 7 && u.patch.muted === false));
  assert('and forgets it afterwards',
    !storage.adMuteRuntime.tabs['7']);

  restarted.send({type: 'adt:tab-mute', muted: false}, 8);
  await restarted.settle();
  assert('the user mute survives the unmute request',
    !restarted.updates.some((u) => u.id === 8 && u.patch.muted === false));
}
{
  /*
   * The bug this whole path exists for: the inventory tab is open, the drop is
   * finished, and the page still shows the state it was rendered with.
   */
  const tabs = {5: {id: 5, inventory: true, mutedInfo: {muted: false}}};
  const h = swSandbox({}, tabs);
  h.setClaimReport({ok: true, report: {mode: 'claim', pending: 0, stale: true}});

  h.send({type: 'adt:drop-unlocked', text: 'Drop unlocked'}, 3);
  await h.settle();
  assert('a stale inventory tab is reloaded', h.reloads.length === 1 && h.reloads[0] === 5);
  assert('and claimed again once it is back', h.claims.length === 2);

  h.send({type: 'adt:drop-unlocked', text: 'Drop unlocked'}, 3);
  await h.settle();
  assert('a second unlock right after does not reload again', h.reloads.length === 1);
}
{
  const tabs = {5: {id: 5, inventory: true, mutedInfo: {muted: false}}};
  const h = swSandbox({}, tabs);
  h.setClaimReport({ok: true, report: {mode: 'claim', pending: 0, stale: false}});

  h.send({type: 'adt:drop-unlocked', text: 'Drop unlocked'}, 3);
  await h.settle();
  assert('a current inventory with nothing to claim is left alone',
    h.reloads.length === 0);
}
{
  const tabs = {5: {id: 5, inventory: true, mutedInfo: {muted: false}}};
  const h = swSandbox({}, tabs);
  h.setClaimReport({ok: true, report: {mode: 'claim', pending: 2, stale: true}});

  h.send({type: 'adt:drop-unlocked', text: 'Drop unlocked'}, 3);
  await h.settle();
  assert('a tab that is already claiming is not reloaded underneath itself',
    h.reloads.length === 0);
}

console.log(failures ? `\n${failures} harness failure(s).\n` : '\nLifecycle harness clean.\n');
process.exit(failures ? 1 : 0);
