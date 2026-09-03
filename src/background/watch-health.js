/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/** @fileoverview Detects stalled Twitch players and alerts the user. */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  g.ADT = g.ADT || {};
  var api = g.ADT.api;
  var log = g.ADT.log;

  /** @const {string} */
  var RT_KEY = 'watchHealthRuntime';
  /** @const {string} */
  var NOTIFICATION_PREFIX = 'adt-watch-health:';
  /** @const {number} */
  var MAX_CHANNELS = 250;
  /** @const {number} */
  var MAX_DAYS = 400;
  /** @const {number} A long gap starts a new viewing session. */
  var SESSION_GAP_MS = 5 * 60000;
  /** @const {number} Longer samples are browser sleep/navigation, not verified playback. */
  var MAX_SAMPLE_GAP_MS = 2 * 60000;
  /** @const {number} Recent intervals prevent duplicate tabs double-counting a channel. */
  var COVERAGE_RETENTION_MS = 3 * 60000;

  /** @return {!Promise<!Object>} */
  function loadRt() {
    return Promise.resolve(api.storage.local.get(RT_KEY)).then(function (res) {
      var rt = (res && res[RT_KEY]) || {};
      rt.tabs = rt.tabs || {};
      rt.samples = rt.samples || {};
      rt.channels = rt.channels || {};
      return rt;
    });
  }

  /** @param {number} timestamp @return {string} */
  function dayKey(timestamp) {
    var d = new Date(timestamp);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  /** @param {string} key @return {number} */
  function dayStart(key) {
    var parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return 0;
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  }

  /** @param {!Array<!Array<number>>} intervals @return {!Array<!Array<number>>} */
  function mergeIntervals(intervals) {
    intervals = intervals.filter(function (x) {
      return Array.isArray(x) && Number(x[1]) > Number(x[0]);
    }).map(function (x) { return [Number(x[0]), Number(x[1])]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    intervals.forEach(function (interval) {
      var last = out[out.length - 1];
      if (!last || interval[0] > last[1]) out.push(interval);
      else last[1] = Math.max(last[1], interval[1]);
    });
    return out;
  }

  /**
   * @param {number} start
   * @param {number} end
   * @param {!Array<!Array<number>>} covered
   * @return {!Array<!Array<number>>}
   */
  function uncoveredIntervals(start, end, covered) {
    var segments = [[start, end]];
    covered.forEach(function (interval) {
      var next = [];
      segments.forEach(function (segment) {
        if (interval[1] <= segment[0] || interval[0] >= segment[1]) {
          next.push(segment);
          return;
        }
        if (interval[0] > segment[0]) next.push([segment[0], interval[0]]);
        if (interval[1] < segment[1]) next.push([interval[1], segment[1]]);
      });
      segments = next;
    });
    return segments;
  }

  /** @param {!Object} record @param {number} now */
  function pruneDays(record, now) {
    record.days = record.days || {};
    var cutoff = now - MAX_DAYS * 86400000;
    Object.keys(record.days).forEach(function (key) {
      if (dayStart(key) < cutoff) delete record.days[key];
    });
  }

  /** @param {!Object} rt */
  function pruneChannels(rt) {
    var keys = Object.keys(rt.channels || {});
    if (keys.length <= MAX_CHANNELS) return;
    keys.sort(function (a, b) {
      return Number(rt.channels[b].lastWatchedAt || 0) -
        Number(rt.channels[a].lastWatchedAt || 0);
    }).slice(MAX_CHANNELS).forEach(function (key) { delete rt.channels[key]; });
  }

  /**
   * Adds only playback not already covered by another tab on this channel.
   * @param {!Object} rt
   * @param {!Object} report
   * @param {number} tabId
   * @param {number} now
   */
  function recordPlayback(rt, report, tabId, now) {
    rt.samples = rt.samples || {};
    rt.channels = rt.channels || {};
    var channel = String(report.channel || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,50}$/.test(channel)) return;
    var sampledAt = Number(report.sampledAt);
    var mediaTimeMs = Number(report.mediaTimeMs);
    var sourceId = String(report.sourceId || '').slice(0, 80);
    var playerEpoch = Number(report.playerEpoch);
    if (!Number.isFinite(sampledAt) || !Number.isFinite(mediaTimeMs) || !sourceId ||
        !Number.isInteger(playerEpoch) || playerEpoch < 0 ||
        Math.abs(now - sampledAt) > 60000) return;

    var key = String(tabId);
    var previous = rt.samples[key];
    rt.samples[key] = {
      channel: channel,
      sampledAt: sampledAt,
      mediaTimeMs: Math.max(0, mediaTimeMs),
      sourceId: sourceId,
      playerEpoch: playerEpoch
    };
    if (!previous || previous.channel !== channel || previous.sourceId !== sourceId ||
        previous.playerEpoch !== playerEpoch || report.seeking) return;

    var wallDelta = sampledAt - Number(previous.sampledAt || 0);
    var mediaDelta = mediaTimeMs - Number(previous.mediaTimeMs || 0);
    if (wallDelta <= 0 || wallDelta > MAX_SAMPLE_GAP_MS || mediaDelta <= 0) return;
    var playedMs = Math.min(mediaDelta, wallDelta + 2000);
    if (playedMs <= 0) return;

    var end = sampledAt;
    var start = end - playedMs;
    var record = rt.channels[channel] || {
      channel: channel,
      watchMs: 0,
      sessions: 0,
      firstWatchedAt: 0,
      lastWatchedAt: 0,
      days: {},
      coverage: []
    };
    var cutoff = start - COVERAGE_RETENTION_MS;
    var coverage = mergeIntervals((record.coverage || []).filter(function (interval) {
      return Number(interval[1]) >= cutoff;
    }));
    var segments = uncoveredIntervals(start, end, coverage);
    var added = segments.reduce(function (sum, interval) {
      return sum + interval[1] - interval[0];
    }, 0);
    record.coverage = mergeIntervals(coverage.concat([[start, end]])).filter(function (interval) {
      return interval[1] >= end - COVERAGE_RETENTION_MS;
    });
    if (!added) {
      rt.channels[channel] = record;
      return;
    }

    var newSession = !record.lastWatchedAt || start - record.lastWatchedAt > SESSION_GAP_MS;
    record.watchMs = Math.max(0, Number(record.watchMs || 0)) + added;
    record.sessions = Math.max(0, Number(record.sessions || 0)) + (newSession ? 1 : 0);
    record.firstWatchedAt = record.firstWatchedAt || start;
    record.lastWatchedAt = Math.max(Number(record.lastWatchedAt || 0), end);
    record.days = record.days || {};

    segments.forEach(function (segment) {
      var cursor = segment[0];
      while (cursor < segment[1]) {
        var d = new Date(cursor);
        var nextDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        var partEnd = Math.min(segment[1], nextDay);
        var bucketKey = dayKey(cursor);
        var bucket = record.days[bucketKey] || { watchMs: 0, sessions: 0, lastWatchedAt: 0 };
        bucket.watchMs += partEnd - cursor;
        bucket.lastWatchedAt = Math.max(bucket.lastWatchedAt || 0, partEnd);
        record.days[bucketKey] = bucket;
        cursor = partEnd;
      }
    });
    if (newSession) {
      var sessionKey = dayKey(start);
      var sessionBucket = record.days[sessionKey] ||
        { watchMs: 0, sessions: 0, lastWatchedAt: 0 };
      sessionBucket.sessions = Math.max(0, Number(sessionBucket.sessions || 0)) + 1;
      record.days[sessionKey] = sessionBucket;
    }
    pruneDays(record, now);
    rt.channels[channel] = record;
    pruneChannels(rt);
  }

  /** @param {number} tabId @return {string} */
  function notificationId(tabId) {
    return NOTIFICATION_PREFIX + tabId;
  }

  /** @param {number} tabId */
  function clearNotification(tabId) {
    if (!api.notifications || !api.notifications.clear) return;
    try {
      Promise.resolve(api.notifications.clear(notificationId(tabId))).catch(function () {});
    } catch (e) {}
  }

  /**
   * @param {number} tabId
   * @param {string} channel
   * @param {string} reason
   */
  function notify(tabId, channel, reason) {
    if (!api.notifications || !api.notifications.create) return;
    var bodyKey = reason === 'discarded'
      ? 'notifyWatchDiscardedBody'
      : 'notifyWatchStaleBody';
    try {
      Promise.resolve(api.notifications.create(notificationId(tabId), {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon128.png'),
        title: g.ADT.msg('notifyWatchStaleTitle'),
        message: g.ADT.msg(bodyKey, channel || 'Twitch')
      })).catch(function (e) {
        log.warn('watch-health notification: ' + (e && e.message));
      });
    } catch (e) {
      log.warn('watch-health notification: ' + (e && e.message));
    }
  }

  /**
   * @param {!Object} report
   * @param {number} tabId
   * @param {boolean=} trackStats False for the extension-owned farming tab.
   * @return {!Promise<void>}
   */
  function handleHeartbeat(report, tabId, trackStats) {
    if (tabId == null) return Promise.resolve();
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled) return forgetTab(tabId);
      var now = Date.now();

      var keep = Promise.resolve();
      if (s.watchHealth.enabled && s.watchHealth.keepAwake) {
        try {
          keep = Promise.resolve(api.tabs.update(tabId, { autoDiscardable: false }))
            .catch(function () {});
        } catch (e) {
          // Firefox versions without this tab flag still keep the watchdog.
        }
      }

      return keep.then(function () {
        return g.ADT.updateLocal(RT_KEY, function (rt) {
          rt.tabs = rt.tabs || {};
          rt.samples = rt.samples || {};
          rt.channels = rt.channels || {};
          var key = String(tabId);
          if (trackStats === false || !s.watchHealth.enabled) delete rt.samples[key];
          else recordPlayback(rt, report, tabId, now);
          if (!s.watchHealth.enabled) {
            if (rt.tabs[key]) delete rt.tabs[key];
            clearNotification(tabId);
            return rt;
          }
          var item = rt.tabs[key] || {
            firstSeenAt: now,
            lastProgressAt: now,
            notified: false
          };
          item.channel = String(report.channel || '').slice(0, 80);
          item.lastHeartbeatAt = now;
          item.playing = !!report.playing;
          item.userPaused = !!report.userPaused;
          if (report.advancing) {
            item.lastProgressAt = now;
            if (item.notified) clearNotification(tabId);
            item.notified = false;
            item.recoveryAttempted = false;
            item.reason = '';
          }
          rt.tabs[key] = item;
          return rt;
        });
      });
    }).catch(function (e) {
      log.warn('watch-health heartbeat: ' + (e && e.message));
    });
  }

  /** @param {number} tabId @return {!Promise<*>} */
  function forgetTab(tabId) {
    return g.ADT.updateLocal(RT_KEY, function (rt) {
      rt.tabs = rt.tabs || {};
      rt.samples = rt.samples || {};
      var key = String(tabId);
      if (!rt.tabs[key] && !rt.samples[key]) return undefined;
      delete rt.tabs[key];
      delete rt.samples[key];
      clearNotification(tabId);
      return rt;
    }).catch(function (e) {
      // Called from tab teardown, where nothing is waiting on the result.
      log.warn('watch-health forget: ' + (e && e.message));
    });
  }

  /** @return {!Promise<void>} */
  function check() {
    return g.ADT.settings.get().then(function (s) {
      if (!s.enabled || !s.watchHealth.enabled) return undefined;

      /*
       * Read, decide and write are one serialized step. Read separately, a
       * heartbeat arriving mid-pass is read by nobody and then overwritten by
       * this pass's older view of the same tab - so a stream that is playing
       * perfectly well looks stalled, gets a notification, and is reloaded
       * under the user.
       */
      return g.ADT.updateLocal(RT_KEY, function (rt) {
        rt.tabs = rt.tabs || {};
        var now = Date.now();
        var staleMs = Math.max(2, s.watchHealth.staleAfterMin || 5) * 60000;
        var chain = Promise.resolve();

        Object.keys(rt.tabs).forEach(function (key) {
          chain = chain.then(function () {
            var tabId = Number(key);
            var item = rt.tabs[key];
            return Promise.resolve(api.tabs.get(tabId)).then(function (tab) {
              var reason = '';
              if (tab.discarded || tab.frozen) reason = 'discarded';
              else if (now - Number(item.lastHeartbeatAt || 0) > staleMs) reason = 'stale';
              /*
               * A player the user paused is idle, not broken, so it gets no
               * notification and no reload. Only the progress reason is waived:
               * a tab that stopped reporting altogether, or that the browser
               * discarded, is still a fault whatever the player was doing.
               */
              else if (!item.userPaused &&
                  now - Number(item.lastProgressAt || 0) > staleMs) reason = 'stalled';

              if (!reason) {
                if (item.notified) clearNotification(tabId);
                item.notified = false;
                item.recoveryAttempted = false;
                item.reason = '';
                return;
              }
              item.reason = reason;
              if (!item.notified && s.watchHealth.notifications) {
                item.notified = true;
                notify(tabId, item.channel, reason);
                log.warn('watch-health: ' + (item.channel || tabId) + ' ' + reason);
              }

              if (!item.recoveryAttempted && s.watchHealth.recoverTab && api.tabs.reload) {
                item.recoveryAttempted = true;
                return Promise.resolve(api.tabs.reload(tabId)).catch(function () {});
              }
            }).catch(function () {
              delete rt.tabs[key];
              if (rt.samples) delete rt.samples[key];
              clearNotification(tabId);
            });
          });
        });

        return chain.then(function () { return rt; });
      });
    }).catch(function (e) {
      log.warn('watch-health check: ' + (e && e.message));
    });
  }

  if (api.notifications && api.notifications.onClicked) {
    api.notifications.onClicked.addListener(function (id) {
      if (id.indexOf(NOTIFICATION_PREFIX) !== 0) return;
      var tabId = Number(id.slice(NOTIFICATION_PREFIX.length));
      if (!Number.isInteger(tabId)) return;
      Promise.resolve(api.tabs.update(tabId, { active: true })).catch(function () {});
    });
  }

  /**
   * The watchdog already knows which tabs are alive; this exposes it so the
   * popup can show that watching is actually happening rather than leaving the
   * user to guess from a counter that only moves once an hour.
   *
   * @return {!Promise<!Array<!Object>>} Watched tabs, most recent heartbeat
   *     first.
   */
  function status() {
    return loadRt().then(function (rt) {
      return Object.keys(rt.tabs).map(function (key) {
        var item = rt.tabs[key] || {};
        return {
          tabId: Number(key),
          channel: item.channel || '',
          playing: !!item.playing,
          reason: item.reason || '',
          since: Number(item.firstSeenAt || 0),
          lastProgressAt: Number(item.lastProgressAt || 0),
          lastHeartbeatAt: Number(item.lastHeartbeatAt || 0)
        };
      }).sort(function (a, b) {
        return b.lastHeartbeatAt - a.lastHeartbeatAt;
      });
    }).catch(function () {
      return [];
    });
  }

  /** @param {string} range @return {number} */
  function rangeStart(range) {
    var now = new Date();
    if (range === 'today') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }
    if (range === 'week') {
      var mondayOffset = (now.getDay() + 6) % 7;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset).getTime();
    }
    if (range === 'month') {
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    }
    return 0;
  }

  /**
   * @param {string} range today, week, month or all.
   * @return {!Promise<!Object>}
   */
  function channelStats(range) {
    range = ['today', 'week', 'month', 'all'].indexOf(range) >= 0 ? range : 'all';
    var start = rangeStart(range);
    return loadRt().then(function (rt) {
      var rows = Object.keys(rt.channels).map(function (key) {
        var record = rt.channels[key] || {};
        var watchMs = 0;
        var sessions = 0;
        var lastWatchedAt = 0;
        if (range === 'all') {
          watchMs = Math.max(0, Number(record.watchMs || 0));
          sessions = Math.max(0, Number(record.sessions || 0));
          lastWatchedAt = Math.max(0, Number(record.lastWatchedAt || 0));
        } else {
          Object.keys(record.days || {}).forEach(function (day) {
            var timestamp = dayStart(day);
            if (timestamp < start || timestamp > Date.now()) return;
            var bucket = record.days[day] || {};
            watchMs += Math.max(0, Number(bucket.watchMs || 0));
            sessions += Math.max(0, Number(bucket.sessions || 0));
            lastWatchedAt = Math.max(lastWatchedAt, Number(bucket.lastWatchedAt || 0));
          });
        }
        return {
          channel: key,
          watchMs: Math.round(watchMs),
          sessions: Math.round(sessions),
          firstWatchedAt: Math.max(0, Number(record.firstWatchedAt || 0)),
          lastWatchedAt: lastWatchedAt
        };
      }).filter(function (row) { return row.watchMs > 0; }).sort(function (a, b) {
        return b.watchMs - a.watchMs || b.lastWatchedAt - a.lastWatchedAt;
      });
      return {
        range: range,
        watchMs: rows.reduce(function (sum, row) { return sum + row.watchMs; }, 0),
        sessions: rows.reduce(function (sum, row) { return sum + row.sessions; }, 0),
        channels: rows.length,
        topChannel: rows.length ? rows[0].channel : '',
        rows: rows.slice(0, 100)
      };
    }).catch(function () {
      return { range: range, watchMs: 0, sessions: 0, channels: 0, topChannel: '', rows: [] };
    });
  }

  /** @return {!Promise<*>} */
  function resetChannelStats() {
    return g.ADT.updateLocal(RT_KEY, function (rt) {
      rt.tabs = rt.tabs || {};
      rt.channels = {};
      rt.samples = {};
      return rt;
    });
  }

  g.ADT.watchHealth = {
    handleHeartbeat: handleHeartbeat,
    forgetTab: forgetTab,
    check: check,
    status: status,
    channelStats: channelStats,
    resetChannelStats: resetChannelStats,
    loadRt: loadRt
  };
})();
