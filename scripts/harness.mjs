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
  const body = {querySelectorAll: () => []};
  const buttonText = options.buttonText || 'Claim';
  const button = {
    tagName: 'BUTTON', isConnected: true, disabled: false,
    className: 'claimable-bonus',
    closest: () => button, querySelector: () => null,
    getAttribute: (name) => name === 'aria-disabled' ? 'false' : 'Bonus'
  };
  // A drops root has to answer querySelectorAll: claimNow() reads the progress
  // bars on the same pass.
  const emptyRoot = {querySelectorAll: () => []};
  const D = {
    q: () => button,
    qAny: () => page === 'drops'
      ? (options.legacyRoot === false ? null : emptyRoot)
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
  // Mutable, so a scenario can take the player away: an offline channel mounts
  // none at all, and a stream that ends has its torn down.
  const videos = [video];
  const document = {
    querySelectorAll: (selector) => selector === 'video' ? videos.slice() : [],
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
    sandbox, video, videos, sent, timeouts, intervals,
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
  const localQueues = {};
  const sandbox = {
    globalThis: null, self: null, console, Promise, Number, Date: FakeDate,
    ADT: {
      api, log: {warn() {}},
      msg: (key, value) => key + ':' + value,
      // Mirrors lib/storage.js, which the background pulls in alongside this
      // file. Serialization is the point, so it is reproduced, not stubbed.
      updateLocal(key, mutate) {
        const run = (localQueues[key] || Promise.resolve())
          .then(() => api.storage.local.get(key))
          .then((res) => mutate((res && res[key]) || {}))
          .then((next) => next === undefined
            ? undefined
            : api.storage.local.set({[key]: next}).then(() => next));
        localQueues[key] = run.catch(() => {});
        return run;
      },
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
 * @param {!Object=} alarmStore Shared alarm registry. A second boot on the same
 *     one reproduces the other thing MV3 does routinely: run this file again
 *     with the previous worker's alarms still scheduled.
 */
function swSandbox(storage = {}, tabs = {}, alarmStore = {}) {
  const alarmCreates = [];
  const messageHandlers = [];
  const timeouts = new Map();
  let nextTimer = 1;
  const localQueues = {};
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
    alarms: {
      create(name, opts) {
        alarmCreates.push({name, opts});
        alarmStore[name] = Object.assign(
          {name, scheduledTime: 1700000000000}, opts);
      },
      clear(name) { delete alarmStore[name]; return Promise.resolve(true); },
      get: (name) => Promise.resolve(alarmStore[name]),
      onAlarm: {addListener() {}}
    },
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
      /*
       * The real one lives in lib/storage.js, which the worker pulls in with
       * importScripts. Reproduced over the fake storage rather than stubbed
       * out, because it is the serialization itself that the mute bookkeeping
       * depends on: two overlapping updates must not lose one another.
       */
      updateLocal(key, mutate) {
        const run = (localQueues[key] || Promise.resolve())
          .then(() => api.storage.local.get(key))
          .then((res) => mutate((res && res[key]) || {}))
          .then((next) => next === undefined
            ? undefined
            : api.storage.local.set({[key]: next}).then(() => next));
        localQueues[key] = run.catch(() => {});
        return run;
      },
      liveWatch: {forgetTab() {}, status: () => Promise.resolve({})},
      watchHealth: {
        forgetTab() {},
        check: () => Promise.resolve(),
        status: () => Promise.resolve([
          {tabId: 5, channel: 'shroud', playing: true, reason: '', since: 1000,
            lastProgressAt: 2000, lastHeartbeatAt: 2000}
        ])
      },
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
    storage, tabs, updates, reloads, claims, alarmCreates, alarmStore,
    setClaimReport(report) { claimReport = report; },
    /**
     * The worker answers asynchronously, so the reply is read off the returned
     * handle after settle() rather than from a return value.
     */
    send(msg, tabId) {
      const reply = {response: undefined};
      messageHandlers.forEach((fn) => fn(msg, {tab: {id: tabId}}, (res) => {
        reply.response = res;
      }));
      return reply;
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
  h.fire('keydown', {key: ' ', target: {tagName: 'TEXTAREA'}}); // User types space in chat.
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  assert('typing in chat is not interpreted as a pause command', h.video.plays === 1);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  h.fire('keydown', {key: ' '});              // User pauses
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('userPaused becomes true', h.sent[h.sent.length - 1].userPaused === true);
  
  h.fire('play', {target: h.video});          // User clicks play, but buffering (no 'playing' yet)
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('userPaused is cleared by the play event itself', h.sent[h.sent.length - 1].userPaused === false);
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
  /*
   * An offline channel mounts no player at all. A heartbeat from such a tab has
   * the watchdog wait for progress that is never coming, and five minutes later
   * it notifies and reloads a tab that was never broken. The tab is handed back
   * instead, and picked up again the moment a player appears.
   */
  const h = watchContentSandbox();
  h.videos.length = 0;                        // Offline: no <video> on the page.
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('a page with no player sends no heartbeat',
    h.sent.filter((m) => m.type === 'adt:watch-heartbeat').length === 0);
  assert('and does not register the tab at all',
    h.sent.filter((m) => m.type === 'adt:watch-stopped').length === 0);

  // The stream goes live and Twitch mounts the player.
  h.videos.push(h.video);
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('once a player mounts the tab is registered',
    h.sent.filter((m) => m.type === 'adt:watch-heartbeat').length === 1);

  // The stream ends and the player is torn down again.
  h.videos.length = 0;
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('when the player disappears the tab is handed back once',
    h.sent.filter((m) => m.type === 'adt:watch-stopped').length === 1);
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('and not handed back again on every later report',
    h.sent.filter((m) => m.type === 'adt:watch-stopped').length === 1);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  /*
   * The pause the user asked for travels to the background, which is the only
   * way it can tell that standing video time apart from a stall.
   */
  const h = watchContentSandbox();
  h.sandbox.ADT.modules.watchHealth.start({heartbeatSec: 30, keepPlaying: true});
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('a normal heartbeat reports no user pause',
    h.sent[h.sent.length - 1].userPaused === false);
  h.fire('keydown', {key: ' '});
  h.video.paused = true;
  h.fire('pause', {target: h.video});
  h.runTimeouts();
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('a user pause is reported to the background',
    h.sent[h.sent.length - 1].userPaused === true);
  h.video.paused = false;
  h.fire('playing', {target: h.video});
  h.sandbox.ADT.modules.watchHealth.reportNow();
  assert('and is dropped again once playback returns',
    h.sent[h.sent.length - 1].userPaused === false);
  h.sandbox.ADT.modules.watchHealth.stop();
}
{
  /*
   * The background half of the same contract: only the progress reason is
   * waived, so a tab that stops reporting is still caught while paused.
   */
  const h = watchBackgroundSandbox();
  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'paused', playing: false, advancing: false, userPaused: true
  }, 51);
  h.advance(6 * 60000);
  // Keep reporting, as a paused tab really does.
  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'paused', playing: false, advancing: false, userPaused: true
  }, 51);
  await h.sandbox.ADT.watchHealth.check();
  assert('a user-paused tab raises no notification', h.notifications.length === 0);
  assert('and is never reloaded', h.reloads.length === 0);

  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'paused', playing: true, advancing: true, userPaused: false
  }, 51);
  h.advance(6 * 60000);
  await h.sandbox.ADT.watchHealth.handleHeartbeat({
    channel: 'paused', playing: true, advancing: false, userPaused: false
  }, 51);
  await h.sandbox.ADT.watchHealth.check();
  assert('but a real stall after they resume still is',
    h.notifications.length === 1 && h.reloads.length === 1);
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
{
  /*
   * The activity record. Without it the popup cannot distinguish an extension
   * that checked two minutes ago and found nothing from one that died at noon.
   */
  const tabs = {5: {id: 5, inventory: true, mutedInfo: {muted: false}}};
  const h = swSandbox({}, tabs);
  h.setClaimReport({ok: true, report: {mode: 'claim', pending: 2, stale: true}});

  h.send({type: 'adt:drops-check-now'}, 3);
  await h.settle();
  const claimed = h.storage.activityRuntime;
  assert('a check with something to claim is recorded as claimed',
    !!claimed && claimed.outcome === 'claimed');
  assert('and remembers that the popup asked for it', claimed.trigger === 'popup');
  assert('and carries a timestamp', typeof claimed.lastCheckAt === 'number' &&
    claimed.lastCheckAt > 0);

  h.setClaimReport({ok: true, report: {mode: 'claim', pending: 0, stale: false}});
  h.send({type: 'adt:drop-unlocked', text: 'Drop unlocked'}, 3);
  await h.settle();
  assert('a check that found nothing is recorded as idle',
    h.storage.activityRuntime.outcome === 'idle');
  assert('and remembers the unlock notification triggered it',
    h.storage.activityRuntime.trigger === 'unlock');

  const reply = h.send({type: 'adt:status'}, 3);
  await h.settle();
  const activity = reply.response && reply.response.activity;
  assert('the status answer carries the activity record',
    !!activity && activity.drops.outcome === 'idle');
  assert('and what is being watched right now',
    !!activity && activity.watching.length === 1 &&
    activity.watching[0].channel === 'shroud');
  assert('and when the next check is due', activity.nextCheckAt === 1700000000000);
}
{
  // Scraped values arrive from a content script, so the worker treats them as
  // untrusted input rather than as its own data.
  const h = swSandbox({}, {});

  // Deliberately unsorted, and the near-finished one is not first: ranking has
  // to happen over the whole report, not over whatever arrived first.
  h.send({type: 'adt:drops-progress', items: [
    {name: 'x'.repeat(200), percent: 12, hours: 6},
    {name: 'Rare 2', percent: 85, hours: 4},
    {name: 'broken', percent: 400, hours: 1},
    {name: 'no requirement', percent: 30, hours: 0}
  ]}, 5);
  await h.settle();

  const stored = h.storage.dropsProgress;
  assert('a progress report is stored', !!stored && stored.items.length === 3);
  assert('the drop closest to finished is ranked first',
    stored.items[0].name === 'Rare 2');
  assert('an impossible percentage is dropped',
    !stored.items.some((i) => i.percent > 100));
  assert('an overlong name is cut', stored.items[1].name.length === 60);
  assert('a missing requirement survives as zero', stored.items[2].hours === 0);
  assert('and the snapshot is timestamped', typeof stored.updatedAt === 'number');

  h.send({type: 'adt:drops-progress', items: 'not an array'}, 5);
  await h.settle();
  assert('garbage does not overwrite a good snapshot',
    h.storage.dropsProgress.items.length === 3);

  const reply = h.send({type: 'adt:status'}, 5);
  await h.settle();
  assert('the popup gets the snapshot with the rest of the activity',
    reply.response.activity.progress.items[0].name === 'Rare 2');

  /*
   * An empty report means two different things depending on whether the page
   * was read. A scan that found nothing to go on - a page still loading, a
   * renamed selector - must not erase a good snapshot, while a page that was
   * read and holds nothing earnable has to be able to, or the popup keeps
   * listing drops from a campaign that closed weeks ago.
   */
  h.send({type: 'adt:drops-progress', items: []}, 5);
  await h.settle();
  assert('an empty report on its own leaves the snapshot alone',
    h.storage.dropsProgress.items.length === 3);

  h.send({type: 'adt:drops-progress', items: [], read: true}, 5);
  await h.settle();
  assert('an empty report from a page that was read clears the snapshot',
    h.storage.dropsProgress.items.length === 0);
  assert('and timestamps it, so the popup can tell "nothing left" from "never read"',
    typeof h.storage.dropsProgress.updatedAt === 'number');
}

{
  /*
   * MV3 terminates the worker whenever it goes idle, so this whole file runs
   * again on every wake - and the one-minute health alarm guarantees a wake at
   * least once a minute. Creating an alarm that already exists restarts its
   * countdown, so recreating the drops alarm on each boot pushed it ten minutes
   * out once a minute: it could never reach its own delay, and the periodic
   * check was dead code in practice while looking perfectly correct.
   */
  const storage = {};
  const alarms = {};

  const first = swSandbox(storage, {}, alarms);
  await first.settle();
  assert('the first boot schedules the drops alarm',
    first.alarmCreates.filter((a) => a.name === 'adt-drops-check').length === 1);
  assert('and the health alarm',
    first.alarmCreates.filter((a) => a.name === 'adt-health').length === 1);

  const restart = swSandbox(storage, {}, alarms);
  await restart.settle();
  assert('a worker restart does not reschedule the drops alarm',
    restart.alarmCreates.filter((a) => a.name === 'adt-drops-check').length === 0);
  assert('nor the health alarm',
    restart.alarmCreates.filter((a) => a.name === 'adt-health').length === 0);

  // A changed interval is the one reason to restart the countdown, so the
  // period is what identity is judged on rather than mere existence.
  alarms['adt-drops-check'].periodInMinutes = 45;
  const reconfigured = swSandbox(storage, {}, alarms);
  await reconfigured.settle();
  assert('but a changed interval does reschedule it',
    reconfigured.alarmCreates.filter((a) => a.name === 'adt-drops-check').length === 1);
}

{
  /*
   * A tab that is still loading cannot answer a ping, so the background injects
   * into it, and the browser then injects the same files again at
   * document_idle. Everything below is what the second pass used to duplicate.
   */
  const listeners = [];
  const routeHooks = [];
  const changeHooks = [];
  const intervals = [];
  let now = 1000000;
  class FakeDate extends Date { static now() { return now; } }

  const runtime = {
    onMessage: {addListener(fn) { listeners.push(fn); }},
    id: 'adt'
  };
  const sandbox = {
    globalThis: null, window: null, self: null, console,
    Promise, Date: FakeDate, Set, WeakSet, Object, Array, JSON, Math,
    location: {pathname: '/somechannel', href: 'https://twitch.tv/somechannel'},
    document: {body: {}, addEventListener() {}},
    chrome: runtime && {runtime},
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
    addEventListener() {},
    history: {pushState() {}, replaceState() {}},
    ADT: {
      api: {runtime},
      log: {setLevel() {}, debug() {}, info() {}, warn() {}, error() {}},
      dom: {
        currentChannel: () => 'somechannel',
        onRouteChange(fn) { routeHooks.push(fn); },
        resetClickBudget() {}
      },
      modules: {},
      settings: {
        get: () => Promise.resolve({enabled: false, logLevel: 'info'}),
        configSig: () => 'sig',
        onChange(fn) { changeHooks.push(fn); }
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const beacon = read('src/content/beacon.js');
  const index = read('src/content/index.js');

  vm.runInContext(beacon, sandbox);
  vm.runInContext(index, sandbox);
  const afterFirst = {
    listeners: listeners.length,
    routes: routeHooks.length,
    changes: changeHooks.length
  };
  assert('a first injection wires the orchestrator up once',
    afterFirst.listeners === 2 && afterFirst.routes === 1 && afterFirst.changes === 1);

  vm.runInContext(beacon, sandbox);
  vm.runInContext(index, sandbox);
  assert('a second injection adds no second message listener',
    listeners.length === afterFirst.listeners);
  assert('nor a second route observer', routeHooks.length === afterFirst.routes);
  assert('nor a second settings subscriber', changeHooks.length === afterFirst.changes);
  assert('and the second pass is recorded rather than silent',
    sandbox.__ADT_DIAG.reinjected === 1);

  // The diagnostic must keep meaning what it says: `loaded` is files that
  // reached their last statement, and a guarded file still reached it once.
  assert('the ping still reports both files as loaded',
    sandbox.__ADT_DIAG.loaded.includes('content/beacon.js') &&
    sandbox.__ADT_DIAG.loaded.includes('content/index.js'));
}

console.log(failures ? `\n${failures} harness failure(s).\n` : '\nLifecycle harness clean.\n');
process.exit(failures ? 1 : 0);
