/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/** @fileoverview Persistent, DOM-driven Twitch Drops farming orchestrator. */
(function () {
  'use strict';

  var g = typeof globalThis !== 'undefined' ? globalThis : self;
  g.ADT = g.ADT || {};
  var api = g.ADT.api;
  var log = g.ADT.log;

  /** @const {string} */
  var RT_KEY = 'dropsAutomationRuntime';
  /** @const {string} */
  var HISTORY_KEY = 'dropsClaimHistory';
  /** @const {string} */
  var CATALOG_KEY = 'dropsCampaignCatalog';
  /** @const {string} */
  var NOTIFICATION_PREFIX = 'adt-drops-farm:';
  /** @const {string} Unknown query parameters survive Twitch page bootstrap. */
  var OWNER_QUERY_KEY = 'adt_farm';
  /** @const {number} */
  var MAX_CAMPAIGNS = 50;
  /** @const {number} */
  var MAX_CATALOG_CAMPAIGNS = 200;
  /** @const {number} */
  var MAX_CANDIDATES = 40;
  /** @const {number} */
  var MAX_HISTORY = 100;
  /** @const {number} */
  var DIRECTORY_RENDER_MS = 4500;
  /** @const {number} */
  var SWITCH_COOLDOWN_MS = 3 * 60000;
  /**
   * How long a directory-discovered candidate list stays usable. A stream that
   * was live at discovery goes offline, and the cached list would otherwise be
   * navigated to forever, never re-scanning for a channel that went live since.
   * @const {number}
   */
  var CANDIDATE_TTL_MS = 30 * 60000;

  /** @type {?function(string=): !Promise<*>} */
  var requestInventoryCheck = null;
  /** @type {boolean} */
  var tickRunning = false;
  /** @type {boolean} */
  var tickPending = false;
  /** @type {boolean} */
  var tickPendingProbe = false;
  /** @type {!Promise<void>} */
  var tickPromise = Promise.resolve();
  /** @type {boolean} */
  var ownershipKnown = false;
  /** @type {?number} */
  var ownedTabId = null;
  /** @type {?Promise<?number>} */
  var ownershipLoad = null;

  /** @return {!Object} */
  function emptyRt() {
    return {
      version: 2,
      campaigns: [],
      queue: [],
      priority: [],
      selected: [],
      selectionConfigured: false,
      exhausted: [],
      active: null,
      ownedTabId: null,
      ownedTabUrl: '',
      ownerToken: '',
      state: 'discovering',
      nextProbeAt: 0,
      lastInventoryAt: 0,
      lastEvent: '',
      lastEventAt: 0,
      notificationKey: ''
    };
  }

  /** @param {*} value @param {number=} max @return {string} */
  function text(value, max) {
    return String(value || '').trim().slice(0, max || 100);
  }

  /** @param {*} value @return {number} */
  function finiteNumber(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  /** @param {!Object} rt @return {!Object} */
  function normalizeRt(rt) {
    var base = emptyRt();
    rt = rt && typeof rt === 'object' && !Array.isArray(rt) ? rt : {};
    if (finiteNumber(rt.version) < 2) {
      rt.priority = [];
      rt.version = 2;
    }
    Object.keys(base).forEach(function (key) {
      if (rt[key] === undefined) rt[key] = base[key];
    });
    if (!Array.isArray(rt.campaigns)) rt.campaigns = [];
    if (!Array.isArray(rt.queue)) rt.queue = [];
    if (!Array.isArray(rt.priority)) rt.priority = [];
    if (!Array.isArray(rt.selected)) rt.selected = [];
    if (!Array.isArray(rt.exhausted)) rt.exhausted = [];
    rt.ownerToken = text(rt.ownerToken, 80).replace(/[^a-z0-9-]/gi, '');
    return rt;
  }

  /** @return {!Promise<!Object>} */
  function loadRt() {
    return Promise.resolve(api.storage.local.get(RT_KEY)).then(function (res) {
      return normalizeRt((res && res[RT_KEY]) || {});
    });
  }

  /** @param {?number} tabId */
  function rememberOwnership(tabId) {
    ownedTabId = tabId == null ? null : tabId;
    ownershipKnown = true;
  }

  /**
   * @param {!Object} rt
   * @param {?number} tabId
   * @param {string=} url
   */
  function setOwnership(rt, tabId, url) {
    rt.ownedTabId = tabId == null ? null : tabId;
    rt.ownedTabUrl = tabId == null ? '' : String(url || '');
    if (tabId == null) rt.ownerToken = '';
    rememberOwnership(rt.ownedTabId);
  }

  /** @return {string} */
  function newOwnerToken() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  /** @param {!Object} rt @param {string} url @return {string} */
  function markedFarmUrl(rt, url) {
    if (!rt.ownerToken) rt.ownerToken = newOwnerToken();
    var parsed = new URL(url, 'https://www.twitch.tv/');
    parsed.searchParams.set(OWNER_QUERY_KEY, rt.ownerToken);
    return parsed.href;
  }

  /** @param {string} url @return {string} */
  function ownerTokenFromUrl(url) {
    try {
      return text(new URL(url).searchParams.get(OWNER_QUERY_KEY), 80)
        .replace(/[^a-z0-9-]/gi, '');
    } catch (e) {
      return '';
    }
  }

  /** @param {number} tabId @return {!Promise<boolean>} */
  function ownsTab(tabId) {
    if (ownershipKnown) return Promise.resolve(ownedTabId === tabId);
    if (!ownershipLoad) {
      ownershipLoad = loadRt().then(function (rt) {
        if (!ownershipKnown) rememberOwnership(rt.ownedTabId);
        return ownedTabId;
      }, function (error) {
        ownershipLoad = null;
        throw error;
      });
    }
    return ownershipLoad.then(function () { return ownedTabId === tabId; });
  }

  /** @return {!Promise<!Object>} */
  function loadHistory() {
    return Promise.resolve(api.storage.local.get(HISTORY_KEY)).then(function (res) {
      var out = (res && res[HISTORY_KEY]) || {};
      if (!Array.isArray(out.items)) out.items = [];
      return out;
    });
  }

  /** @return {!Object} */
  function emptyCatalog() {
    return { items: [], selected: [], scanning: false, startedAt: 0, scannedAt: 0, error: '' };
  }

  /** @param {*} value @return {!Object} */
  function normalizeCatalog(value) {
    var catalog = value && typeof value === 'object' && !Array.isArray(value)
      ? value : emptyCatalog();
    if (!Array.isArray(catalog.items)) catalog.items = [];
    if (!Array.isArray(catalog.selected)) catalog.selected = [];
    catalog.scanning = !!catalog.scanning;
    catalog.startedAt = Math.max(0, finiteNumber(catalog.startedAt));
    catalog.scannedAt = Math.max(0, finiteNumber(catalog.scannedAt));
    catalog.error = text(catalog.error, 160);
    if (catalog.scanning && catalog.startedAt && Date.now() - catalog.startedAt > 30000) {
      catalog.scanning = false;
      catalog.startedAt = 0;
      catalog.error = 'Campaign scan timed out';
    }
    return catalog;
  }

  /** @return {!Promise<!Object>} */
  function loadCatalog() {
    return Promise.resolve(api.storage.local.get(CATALOG_KEY)).then(function (res) {
      return normalizeCatalog((res && res[CATALOG_KEY]) || {});
    });
  }

  /** @param {*} raw @return {?Object} */
  function sanitizeCatalogCampaign(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = text(raw.name, 100);
    var key = text(raw.key, 180);
    if (!name || !key) return null;
    var targets = [];
    (Array.isArray(raw.targets) ? raw.targets : []).forEach(function (item) {
      var target = sanitizeTarget(item);
      if (target && !targets.some(function (x) { return x.href === target.href; })) {
        targets.push(target);
      }
    });
    return {
      key: key,
      name: name,
      publisher: text(raw.publisher, 80),
      dateRange: text(raw.dateRange, 120),
      endsAt: Math.max(0, finiteNumber(raw.endsAt)),
      targets: targets.slice(0, 20),
      rewards: (Array.isArray(raw.rewards) ? raw.rewards : [])
        .map(sanitizeReward).filter(Boolean).slice(0, 30)
    };
  }

  /** @param {*} rawCampaigns @param {boolean} read @return {!Promise<!Object>} */
  function handleCatalog(rawCampaigns, read) {
    if (!read) return Promise.resolve();
    var items = [];
    var seen = {};
    (Array.isArray(rawCampaigns) ? rawCampaigns : []).forEach(function (raw) {
      var item = sanitizeCatalogCampaign(raw);
      if (!item || seen[item.key]) return;
      seen[item.key] = true;
      items.push(item);
    });
    items = items.slice(0, MAX_CATALOG_CAMPAIGNS);
    return g.ADT.updateLocal(CATALOG_KEY, function (stored) {
      var catalog = normalizeCatalog(stored);
      catalog.items = items;
      catalog.selected = catalog.selected.filter(function (key) { return !!seen[key]; });
      catalog.scanning = false;
      catalog.startedAt = 0;
      catalog.scannedAt = Date.now();
      catalog.error = '';
      return catalog;
    }).then(function (catalog) {
      return g.ADT.updateLocal(RT_KEY, function (stored) {
        var rt = normalizeRt(stored);
        if (!rt.selectionConfigured) return undefined;
        rt.selected = rt.selected.filter(function (key) {
          return catalog.selected.indexOf(key) >= 0;
        });
        rt.priority = rt.priority.filter(function (key) {
          return rt.selected.indexOf(key) >= 0;
        });
        if (rt.active && rt.selected.indexOf(rt.active.campaignKey) < 0) {
          rt.active = null;
          rt.state = rt.selected.length ? 'switching' : 'complete';
        }
        rt.queue = rankQueue(rt.campaigns, rt.priority, rt.exhausted, rt.selected);
        return rt;
      }).then(function () { return catalog; });
    });
  }

  /** @param {boolean} scanning @param {string=} error @return {!Promise<!Object>} */
  function setCatalogScanning(scanning, error) {
    return g.ADT.updateLocal(CATALOG_KEY, function (stored) {
      var catalog = normalizeCatalog(stored);
      catalog.scanning = scanning;
      catalog.startedAt = scanning ? Date.now() : 0;
      catalog.error = text(error, 160);
      return catalog;
    });
  }

  /**
   * @param {*} raw
   * @return {?{kind: string, href: string, login: string}}
   */
  function sanitizeTarget(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var href = text(raw.href, 300);
    try {
      var parsed = new URL(href, 'https://www.twitch.tv/');
      if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return null;
      var path = parsed.pathname.replace(/\/+$/, '') || '/';
      if (/^\/directory\/category\/[a-z0-9_%.-]+$/i.test(path)) {
        return { kind: 'directory', href: path + parsed.search, login: '' };
      }
      var match = path.match(/^\/([a-z0-9_]{2,50})$/i);
      if (!match) return null;
      var reserved = [
        'directory', 'downloads', 'drops', 'following', 'inventory', 'jobs',
        'login', 'p', 'search', 'settings', 'signup', 'subscriptions', 'turbo',
        'u', 'videos', 'wallet'
      ];
      var login = match[1].toLowerCase();
      if (reserved.indexOf(login) >= 0) return null;
      return { kind: 'channel', href: '/' + login, login: login };
    } catch (e) {
      return null;
    }
  }

  /** @param {*} raw @return {?Object} */
  function sanitizeReward(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var percent = finiteNumber(raw.percent);
    if (percent < 0 || percent > 100) return null;
    return {
      name: text(raw.name, 80),
      percent: Math.round(percent * 10) / 10,
      hours: Math.max(0, finiteNumber(raw.hours))
    };
  }

  /** @param {*} raw @return {?Object} */
  function sanitizeCandidate(raw) {
    var target = sanitizeTarget({ href: raw && (raw.href || raw.url) });
    if (!target || target.kind !== 'channel') return null;
    return {
      login: target.login,
      href: target.href,
      viewers: Math.max(0, Math.round(finiteNumber(raw && raw.viewers)))
    };
  }

  /** @param {*} raw @return {?Object} */
  function sanitizeCampaign(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var targets = [];
    (Array.isArray(raw.targets) ? raw.targets : []).forEach(function (item) {
      var target = sanitizeTarget(item);
      if (!target) return;
      if (!targets.some(function (x) { return x.href === target.href; })) targets.push(target);
    });
    var rewards = (Array.isArray(raw.rewards) ? raw.rewards : [])
      .map(sanitizeReward).filter(Boolean).slice(0, 30);
    if (!rewards.length) return null;
    var name = text(raw.name, 80) || 'Twitch Drops';
    var key = text(raw.key, 180);
    if (!key) {
      key = (name + '|' + targets.map(function (x) { return x.href; }).sort().join('|'))
        .toLowerCase().replace(/[^a-z0-9|/_?=&.-]+/g, '-').slice(0, 180);
    }
    return {
      key: key,
      name: name,
      endsAt: Math.max(0, finiteNumber(raw.endsAt)),
      targets: targets.slice(0, 20),
      rewards: rewards,
      candidates: [],
      candidatesAt: 0,
      discoveredAt: Date.now(),
      lastSeenAt: Date.now()
    };
  }

  /** @param {!Object} campaign @return {boolean} */
  function campaignComplete(campaign) {
    return !!(campaign.rewards && campaign.rewards.length &&
      campaign.rewards.every(function (reward) { return reward.percent >= 100; }));
  }

  /** @param {!Object} campaign @return {number} */
  function campaignRemaining(campaign) {
    var total = 0;
    var known = false;
    (campaign.rewards || []).forEach(function (reward) {
      if (reward.percent >= 100 || !reward.hours) return;
      known = true;
      total += reward.hours * 3600000 * (1 - reward.percent / 100);
    });
    return known ? total : Number.MAX_VALUE;
  }

  /** @param {!Object} campaign @return {string} */
  function progressVector(campaign) {
    return (campaign.rewards || []).map(function (reward) {
      return reward.name + ':' + reward.percent;
    }).join('|');
  }

  /**
   * @param {!Array<!Object>} campaigns
   * @param {!Array<string>} priority
   * @param {!Array<string>=} excluded
   * @param {?Array<string>=} included
   * @return {!Array<string>}
   */
  function rankQueue(campaigns, priority, excluded, included) {
    var rank = {};
    var skip = {};
    priority.forEach(function (key, index) { rank[key] = index; });
    (excluded || []).forEach(function (key) { skip[key] = true; });
    var allow = null;
    if (Array.isArray(included)) {
      allow = {};
      included.forEach(function (key) { allow[key] = true; });
    }
    return campaigns.filter(function (campaign) {
      return (!allow || allow[campaign.key]) && !skip[campaign.key] &&
        !campaignComplete(campaign) && campaign.targets.length &&
        (!campaign.endsAt || campaign.endsAt > Date.now());
    }).sort(function (a, b) {
      var ar = rank[a.key] === undefined ? Number.MAX_VALUE : rank[a.key];
      var br = rank[b.key] === undefined ? Number.MAX_VALUE : rank[b.key];
      if (ar !== br) return ar - br;
      if (a.endsAt && b.endsAt && a.endsAt !== b.endsAt) return a.endsAt - b.endsAt;
      if (a.endsAt && !b.endsAt) return -1;
      if (!a.endsAt && b.endsAt) return 1;
      return campaignRemaining(a) - campaignRemaining(b);
    }).map(function (campaign) { return campaign.key; });
  }

  /**
   * @param {*} rawCampaigns
   * @return {!Array<!Object>}
   */
  function sanitizeCampaigns(rawCampaigns) {
    var out = [];
    var seen = {};
    (Array.isArray(rawCampaigns) ? rawCampaigns : []).forEach(function (raw) {
      var campaign = sanitizeCampaign(raw);
      if (!campaign || seen[campaign.key]) return;
      seen[campaign.key] = true;
      out.push(campaign);
    });
    return out.slice(0, MAX_CAMPAIGNS);
  }

  /**
   * @param {*} rawCampaigns
   * @param {boolean} read
   * @return {!Promise<!Object>}
   */
  function handleSnapshot(rawCampaigns, read) {
    if (!read) return Promise.resolve();
    var incoming = sanitizeCampaigns(rawCampaigns);
    var now = Date.now();
    return g.ADT.updateLocal(RT_KEY, function (stored) {
      var rt = normalizeRt(stored);
      var oldByKey = {};
      rt.campaigns.forEach(function (campaign) { oldByKey[campaign.key] = campaign; });
      incoming.forEach(function (campaign) {
        var old = oldByKey[campaign.key];
        if (!old) return;
        campaign.discoveredAt = old.discoveredAt || campaign.discoveredAt;
        campaign.candidates = Array.isArray(old.candidates) ? old.candidates : [];
        campaign.candidatesAt = finiteNumber(old.candidatesAt);
      });

      if (rt.selectionConfigured) {
        var selectedByKey = {};
        rt.selected.forEach(function (key) { selectedByKey[key] = true; });
        rt.campaigns.forEach(function (campaign) {
          if (!selectedByKey[campaign.key]) return;
          var targetPaths = (campaign.targets || []).map(function (target) {
            return String(target.href || '').split('?')[0];
          });
          var match = incoming.find(function (candidate) {
            return (candidate.targets || []).some(function (target) {
              return targetPaths.indexOf(String(target.href || '').split('?')[0]) >= 0;
            });
          });
          if (match) {
            campaign.rewards = match.rewards;
            campaign.endsAt = match.endsAt || campaign.endsAt;
            campaign.targets = match.targets.length ? match.targets : campaign.targets;
          }
          if (match && !incoming.some(function (candidate) {
            return candidate.key === campaign.key;
          })) {
            incoming.push(campaign);
          }
        });
      }

      rt.campaigns = incoming;
      rt.exhausted = [];
      rt.priority = rt.priority.filter(function (key) {
        return incoming.some(function (campaign) { return campaign.key === key; });
      });
      rt.queue = rankQueue(incoming, rt.priority, [],
        rt.selectionConfigured ? rt.selected : null);
      rt.lastInventoryAt = now;

      if (rt.active) {
        var active = incoming.find(function (campaign) { return campaign.key === rt.active.campaignKey; });
        if (!active || campaignComplete(active)) {
          rt.active = null;
          rt.state = rt.queue.length ? 'switching' : 'complete';
          rt.lastEvent = active ? 'campaign-complete' : 'campaign-gone';
          rt.lastEventAt = now;
        } else {
          var vector = progressVector(active);
          if (vector !== rt.active.progressVector) {
            rt.active.progressVector = vector;
            rt.active.lastProgressAt = now;
            rt.active.unchangedSnapshots = 0;
            rt.state = 'watching';
            rt.notificationKey = '';
          } else {
            rt.active.unchangedSnapshots = Number(rt.active.unchangedSnapshots || 0) + 1;
          }
          rt.active.lastSnapshotAt = now;
        }
      }
      return rt;
    }).then(function (rt) {
      return tick(false).then(function () { return rt; });
    });
  }

  /** @param {string} key @param {string} messageKey @param {*=} subs */
  function notify(key, messageKey, subs) {
    if (!api.notifications || !api.notifications.create) return;
    try {
      Promise.resolve(api.notifications.create(NOTIFICATION_PREFIX + key, {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon128.png'),
        title: g.ADT.msg('notifyFarmTitle'),
        message: g.ADT.msg(messageKey, subs)
      })).catch(function (e) {
        log.warn('drops farm notification: ' + (e && e.message));
      });
    } catch (e) {
      log.warn('drops farm notification: ' + (e && e.message));
    }
  }

  /** @param {!Object} rt @param {string} key @param {string} messageKey @param {*=} subs */
  function notifyOnce(rt, key, messageKey, subs) {
    if (rt.notificationKey === key) return;
    rt.notificationKey = key;
    notify(key, messageKey, subs);
  }

  /** @param {!Object} rt @param {string} key @return {?Object} */
  function campaignByKey(rt, key) {
    return rt.campaigns.find(function (campaign) { return campaign.key === key; }) || null;
  }

  /** @param {!Object} campaign @return {!Array<!Object>} */
  function directCandidates(campaign) {
    return campaign.targets.filter(function (target) {
      return target.kind === 'channel';
    }).map(function (target) {
      return { login: target.login, href: target.href, viewers: 0 };
    });
  }

  /** @param {!Object} rt @param {string} url @return {!Promise<!Array<!Object>>} */
  function scanDirectoryCandidates(rt, url) {
    return ensureOwnedTab(rt, url).then(function (tab) {
      var markedUrl = markedFarmUrl(rt, url);
      return Promise.resolve(api.tabs.update(tab.id, { url: markedUrl, active: false })).then(function () {
        rt.ownedTabUrl = markedUrl;
        return g.ADT.sleep(DIRECTORY_RENDER_MS);
      }).then(function () {
        return g.ADT.sendToTab(tab.id, { type: 'adt:scan-drop-candidates' });
      }).then(function (res) {
        if (res && res.ok && Array.isArray(res.candidates)) return res;
        return g.ADT.sleep(2000).then(function () {
          return g.ADT.sendToTab(tab.id, { type: 'adt:scan-drop-candidates' });
        });
      }).then(function (res) {
        var candidates = (res && Array.isArray(res.candidates) ? res.candidates : [])
          .map(sanitizeCandidate).filter(Boolean);
        var seen = {};
        return candidates.filter(function (candidate) {
          if (seen[candidate.login]) return false;
          seen[candidate.login] = true;
          return true;
        }).slice(0, MAX_CANDIDATES);
      });
    });
  }

  /** @param {!Object} rt @param {!Object} campaign @return {!Promise<?Object>} */
  function resolveDirectoryTarget(rt, campaign) {
    var url = 'https://www.twitch.tv/search?term=' + encodeURIComponent(campaign.name);
    return ensureOwnedTab(rt, url).then(function (tab) {
      var markedUrl = markedFarmUrl(rt, url);
      return Promise.resolve(api.tabs.update(tab.id, { url: markedUrl, active: false })).then(function () {
        rt.ownedTabUrl = markedUrl;
        return g.ADT.sleep(DIRECTORY_RENDER_MS);
      }).then(function () {
        return g.ADT.sendToTab(tab.id, {
          type: 'adt:resolve-drop-category', name: campaign.name
        });
      }).then(function (res) {
        var target = sanitizeTarget(res && res.target);
        if (!target || target.kind !== 'directory') return null;
        var parsed = new URL(target.href, 'https://www.twitch.tv/');
        parsed.searchParams.set('filter', 'drops');
        return sanitizeTarget({ href: parsed.pathname + parsed.search });
      });
    });
  }

  /**
   * @param {!Object} rt
   * @return {!Promise<?Object>}
   */
  function existingOwnedTab(rt) {
    if (rt.ownedTabId == null || !rt.ownedTabUrl) return Promise.resolve(null);
    return Promise.resolve(api.tabs.get(rt.ownedTabId)).then(function (tab) {
      if (!tab || tab.id == null || !tab.url) return null;
      try {
        var actual = new URL(tab.url);
        var expected = new URL(rt.ownedTabUrl);
        var actualPath = actual.pathname.replace(/\/+$/, '') || '/';
        var expectedPath = expected.pathname.replace(/\/+$/, '') || '/';
        if (actual.origin !== expected.origin || actualPath !== expectedPath) return null;
        if (rt.ownerToken && ownerTokenFromUrl(tab.url) !== rt.ownerToken) return null;
      } catch (e) {
        return null;
      }
      return tab;
    }).catch(function () { return null; });
  }

  /** @param {!Object} rt @return {!Promise<!Object>} */
  function closeOwnedTab(rt) {
    return existingOwnedTab(rt).then(function (tab) {
      setOwnership(rt, null);
      if (!tab) return rt;
      return Promise.resolve(api.tabs.remove(tab.id)).catch(function () {}).then(function () {
        return rt;
      });
    });
  }

  /**
   * @param {!Object} rt
   * @param {string} url
   * @return {!Promise<!Object>}
   */
  function ensureOwnedTab(rt, url) {
    return existingOwnedTab(rt).then(function (tab) {
      if (tab && tab.id != null) {
        rememberOwnership(tab.id);
        return tab;
      }
      setOwnership(rt, null);
      var markedUrl = markedFarmUrl(rt, url);
      return Promise.resolve(api.tabs.create({ url: markedUrl, active: false })).then(function (created) {
        if (!created || created.id == null) throw new Error('farming tab was not created');
        setOwnership(rt, created.id, markedUrl);
        Promise.resolve(api.tabs.update(created.id, {
          muted: true,
          autoDiscardable: false
        })).catch(function () {});
        Promise.resolve(g.ADT.settings.bumpStat('streamsOpened')).catch(function () {});
        return created;
      });
    });
  }

  /**
   * @param {!Object} rt
   * @param {!Object} campaign
   * @return {!Promise<!Array<!Object>>}
   */
  function discoverCandidates(rt, campaign) {
    var direct = directCandidates(campaign);
    if (direct.length) return Promise.resolve(direct.slice(0, MAX_CANDIDATES));
    var directory = campaign.targets.find(function (target) {
      return target.kind === 'directory';
    });
    if (!directory) return Promise.resolve([]);

    var url = 'https://www.twitch.tv' + directory.href;
    rt.state = 'discovering';
    return scanDirectoryCandidates(rt, url).then(function (candidates) {
      if (candidates.length) return candidates;
      return resolveDirectoryTarget(rt, campaign).then(function (resolved) {
        if (!resolved || resolved.href === directory.href) return [];
        campaign.targets = campaign.targets.filter(function (target) {
          return target.kind !== 'directory';
        }).concat([resolved]);
        return scanDirectoryCandidates(rt, 'https://www.twitch.tv' + resolved.href);
      });
    }).then(function (candidates) {
      campaign.candidates = candidates;
      campaign.candidatesAt = Date.now();
      return campaign.candidates;
    });
  }

  /** @param {!Array<!Object>} candidates @param {!Object} settings @return {!Array<!Object>} */
  function orderCandidates(candidates, settings) {
    var out = candidates.slice();
    var strategy = settings.drops.streamSelection || 'first';
    if (strategy === 'random') {
      for (var i = out.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var swap = out[i];
        out[i] = out[j];
        out[j] = swap;
      }
    } else if (strategy === 'low') {
      out.sort(function (a, b) { return a.viewers - b.viewers; });
    } else if (strategy === 'top') {
      out.sort(function (a, b) { return b.viewers - a.viewers; });
    }
    return out;
  }

  /**
   * @param {!Object} rt
   * @param {!Object} campaign
   * @param {!Object} settings
   * @param {number=} nextIndex
   * @return {!Promise<!Object>}
   */
  function watchCandidate(rt, campaign, settings, nextIndex) {
    var direct = directCandidates(campaign);
    var now = Date.now();
    var index = Math.max(0, Number(nextIndex || 0));
    var discovery;
    var needsOrdering = false;
    if (direct.length) {
      // Channel targets never go stale: the campaign names them outright.
      var directLogins = {};
      direct.forEach(function (candidate) { directLogins[candidate.login] = true; });
      var cachedDirect = (campaign.candidates || []).filter(function (candidate) {
        return directLogins[candidate.login];
      });
      if (cachedDirect.length === direct.length) {
        discovery = Promise.resolve(cachedDirect);
      } else {
        discovery = Promise.resolve(direct);
        needsOrdering = true;
      }
    } else if (campaign.candidates && campaign.candidates.length &&
        now - finiteNumber(campaign.candidatesAt) < CANDIDATE_TTL_MS) {
      discovery = Promise.resolve(campaign.candidates);
    } else {
      // No channel targets and the directory-scanned list is empty or stale:
      // re-scan and start from the top, so a stream that went live since the
      // last scan can be picked up and a list of dead streams is not replayed.
      index = 0;
      discovery = discoverCandidates(rt, campaign);
      needsOrdering = true;
    }
    return discovery.then(function (found) {
      if (needsOrdering) found = orderCandidates(found, settings);
      campaign.candidates = found;
      if (!found.length || index >= found.length) {
        if (rt.exhausted.indexOf(campaign.key) < 0) rt.exhausted.push(campaign.key);
        rt.active = null;
        rt.state = 'no-candidates';
        rt.lastEvent = 'no-candidates';
        rt.lastEventAt = Date.now();
        if (settings.drops.farmNotifications) {
          notifyOnce(rt, 'no-candidate:' + campaign.key,
            'notifyFarmNoCandidate', campaign.name);
        }
        return reconcile(rt, settings);
      }

      var candidate = found[index];
      var url = 'https://www.twitch.tv/' + candidate.login;
      return ensureOwnedTab(rt, url).then(function (tab) {
        var markedUrl = markedFarmUrl(rt, url);
        return Promise.resolve(api.tabs.update(tab.id, {
          url: markedUrl,
          active: false,
          muted: true
        })).then(function () {
          // Fire-and-forget: older Firefox rejects tabs.update when it sees
          // unsupported properties, so only essential options go into the
          // awaited call above.
          try { api.tabs.update(tab.id, { autoDiscardable: false }); } catch (_e) {}
          var now = Date.now();
          rt.ownedTabUrl = markedUrl;
          rt.active = {
            campaignKey: campaign.key,
            campaignName: campaign.name,
            candidateIndex: index,
            channel: candidate.login,
            tabId: tab.id,
            startedAt: now,
            switchedAt: now,
            lastProgressAt: now,
            lastSnapshotAt: 0,
            unchangedSnapshots: 0,
            progressVector: progressVector(campaign),
            userPaused: false,
            playing: false,
            lastHeartbeatAt: 0,
            lastVideoProgressAt: 0
          };
          rt.state = 'watching';
          rt.lastEvent = 'watching:' + candidate.login;
          rt.lastEventAt = now;
          rt.notificationKey = '';
          log.info('drops farm: ' + campaign.name + ' -> ' + candidate.login);
          return rt;
        });
      });
    });
  }

  /**
   * @param {!Object} rt
   * @param {!Object} settings
   * @return {!Promise<!Object>}
   */
  function reconcile(rt, settings) {
    var now = Date.now();
    rt.queue = rankQueue(rt.campaigns, rt.priority, rt.exhausted,
      rt.selectionConfigured ? rt.selected : null);
    if (!rt.queue.length) {
      rt.active = null;
      var pendingWithoutLiveStream = rankQueue(rt.campaigns, rt.priority, [],
        rt.selectionConfigured ? rt.selected : null).length > 0;
      rt.state = pendingWithoutLiveStream
        ? 'no-candidates' : (rt.lastInventoryAt ? 'complete' : 'discovering');
      if (!pendingWithoutLiveStream && rt.lastInventoryAt && settings.drops.farmNotifications) {
        notifyOnce(rt, 'complete', 'notifyFarmComplete');
      }
      return closeOwnedTab(rt);
    }

    var activeCampaign = rt.active && campaignByKey(rt, rt.active.campaignKey);
    if (!activeCampaign || campaignComplete(activeCampaign) ||
        rt.queue.indexOf(activeCampaign.key) < 0) {
      var nextCampaign = campaignByKey(rt, rt.queue[0]);
      return nextCampaign ? watchCandidate(rt, nextCampaign, settings, 0) : Promise.resolve(rt);
    }

    var noProgressMs = Math.max(5, finiteNumber(settings.drops.noProgressMin) || 15) * 60000;
    var stalled = rt.active.unchangedSnapshots >= 2 &&
      now - finiteNumber(rt.active.lastProgressAt) >= noProgressMs &&
      now - finiteNumber(rt.active.switchedAt) >= SWITCH_COOLDOWN_MS &&
      !rt.active.userPaused;
    if (!stalled) return Promise.resolve(rt);

    rt.state = 'stalled';
    var nextIndex = finiteNumber(rt.active.candidateIndex) + 1;
    if (settings.drops.farmNotifications) {
      notifyOnce(rt, 'switch:' + activeCampaign.key + ':' + nextIndex,
        'notifyFarmSwitch', [rt.active.channel || '?', activeCampaign.name]);
    }
    return watchCandidate(rt, activeCampaign, settings, nextIndex);
  }

  /**
   * @param {boolean=} forceProbe
   * @return {!Promise<void>}
   */
  function runTick(forceProbe) {
    var probe = false;
    return g.ADT.settings.get().then(function (settings) {
      return g.ADT.updateLocal(RT_KEY, function (stored) {
        var rt = normalizeRt(stored);
        if (!settings.enabled || !settings.drops.enabled || !settings.drops.autoFarm) {
          rt.state = 'off';
          rt.active = null;
          return closeOwnedTab(rt);
        }
        var now = Date.now();
        var probeMs = Math.max(2, finiteNumber(settings.drops.progressProbeMin) || 5) * 60000;
        if (forceProbe || !rt.nextProbeAt || now >= rt.nextProbeAt) {
          probe = true;
          rt.nextProbeAt = now + probeMs;
        }
        return reconcile(rt, settings);
      });
    }).then(function () {
      if (probe && requestInventoryCheck) return requestInventoryCheck('farm');
      return null;
    }).catch(function (e) {
      log.error('drops farm tick: ' + (e && e.message));
    });
  }

  /**
   * Coalesces overlapping requests. A settings change that arrives during a
   * directory scan must run immediately afterwards rather than waiting for the
   * next alarm with stale settings.
   *
   * @param {boolean=} forceProbe
   * @return {!Promise<void>}
   */
  function tick(forceProbe) {
    if (tickRunning) {
      tickPending = true;
      tickPendingProbe = tickPendingProbe || !!forceProbe;
      return tickPromise;
    }
    tickRunning = true;
    function drain(probe) {
      return runTick(probe).then(function () {
        if (tickPending) {
          var nextProbe = tickPendingProbe;
          tickPending = false;
          tickPendingProbe = false;
          return drain(nextProbe);
        }
        tickRunning = false;
      });
    }
    tickPromise = drain(!!forceProbe);
    return tickPromise;
  }

  /**
   * @param {!Object} report
   * @param {number} tabId
   * @return {!Promise<*>}
   */
  function handleHeartbeat(report, tabId) {
    if (tabId == null) return Promise.resolve(false);
    return ownsTab(tabId).then(function (owned) {
      if (!owned) return false;
      // Farming telemetry may wait behind discovery, but ownership must not:
      // the watch-health route uses this answer to exclude personal statistics.
      try {
        Promise.resolve(g.ADT.updateLocal(RT_KEY, function (stored) {
          var rt = normalizeRt(stored);
          if (rt.ownedTabId !== tabId || !rt.active) return undefined;
          var now = Date.now();
          rt.active.lastHeartbeatAt = now;
          rt.active.playing = !!report.playing;
          rt.active.userPaused = !!report.userPaused;
          if (report.advancing) rt.active.lastVideoProgressAt = now;
          return rt;
        })).catch(function (e) {
          log.warn('drops farm heartbeat: ' + (e && e.message));
        });
      } catch (e) {
        log.warn('drops farm heartbeat: ' + (e && e.message));
      }
      return true;
    });
  }

  /** @param {number} tabId @return {!Promise<*>} */
  function forgetTab(tabId) {
    return g.ADT.updateLocal(RT_KEY, function (stored) {
      var rt = normalizeRt(stored);
      if (rt.ownedTabId !== tabId) return undefined;
      setOwnership(rt, null);
      rt.active = null;
      rt.state = 'switching';
      rt.lastEvent = 'farming-tab-closed';
      rt.lastEventAt = Date.now();
      return rt;
    }).then(function () { return tick(false); });
  }

  /**
   * @param {!Object} msg
   * @return {!Promise<*>}
   */
  function handleClaimAttempt(msg) {
    var claimId = text(msg.claimId, 200);
    if (!claimId) return Promise.resolve();
    return g.ADT.updateLocal(HISTORY_KEY, function (history) {
      history.items = Array.isArray(history.items) ? history.items : [];
      if (history.items.some(function (item) { return item.claimId === claimId; })) return undefined;
      history.items.unshift({
        claimId: claimId,
        campaign: text(msg.campaign, 80),
        reward: text(msg.reward, 80),
        attemptedAt: Date.now(),
        verifiedAt: 0,
        status: 'pending'
      });
      history.items = history.items.slice(0, MAX_HISTORY);
      return history;
    });
  }

  /**
   * @param {!Object} msg
   * @return {!Promise<*>}
   */
  function handleClaimResult(msg) {
    var claimId = text(msg.claimId, 200);
    if (!claimId) return Promise.resolve();
    var becameVerified = false;
    var verifiedItem = null;
    return g.ADT.updateLocal(HISTORY_KEY, function (history) {
      history.items = Array.isArray(history.items) ? history.items : [];
      var item = history.items.find(function (entry) { return entry.claimId === claimId; });
      if (!item) {
        item = {
          claimId: claimId,
          campaign: text(msg.campaign, 80),
          reward: text(msg.reward, 80),
          attemptedAt: Date.now(),
          verifiedAt: 0,
          status: 'pending'
        };
        history.items.unshift(item);
      }
      if (msg.verified && item.status !== 'verified') {
        item.status = 'verified';
        item.verifiedAt = Date.now();
        becameVerified = true;
        verifiedItem = item;
      } else if (!msg.verified && item.status !== 'verified') {
        item.status = 'unverified';
      }
      history.items = history.items.slice(0, MAX_HISTORY);
      return history;
    }).then(function () {
      if (!becameVerified) return null;
      return Promise.resolve(g.ADT.settings.bumpStat('dropsClaimed')).then(function () {
        return g.ADT.settings.get();
      }).then(function (settings) {
        if (settings.drops.farmNotifications) {
          notify('claim:' + claimId, 'notifyFarmClaimed',
            verifiedItem.reward || verifiedItem.campaign || 'Twitch Drop');
        }
      }).then(function () { return tick(true); });
    });
  }

  /**
   * @param {string} key
   * @param {number} direction
   * @return {!Promise<*>}
   */
  function movePriority(key, direction) {
    key = text(key, 180);
    direction = direction < 0 ? -1 : 1;
    return g.ADT.updateLocal(RT_KEY, function (stored) {
      var rt = normalizeRt(stored);
      var ordered = rankQueue(rt.campaigns, rt.priority, rt.exhausted,
        rt.selectionConfigured ? rt.selected : null);
      var index = ordered.indexOf(key);
      if (index < 0) return undefined;
      var target = index + direction;
      if (target < 0 || target >= ordered.length) return undefined;
      var swap = ordered[index];
      ordered[index] = ordered[target];
      ordered[target] = swap;
      rt.priority = ordered;
      rt.queue = rankQueue(rt.campaigns, rt.priority, rt.exhausted,
        rt.selectionConfigured ? rt.selected : null);
      return rt;
    });
  }

  /** @return {!Promise<!Object>} */
  function status() {
    return Promise.all([loadRt(), loadHistory(), loadCatalog()]).then(function (all) {
      var rt = all[0];
      var catalog = all[2];
      var byKey = {};
      rt.campaigns.forEach(function (campaign) { byKey[campaign.key] = campaign; });
      return {
        state: rt.state,
        active: rt.active,
        ownedTabId: rt.ownedTabId,
        nextProbeAt: rt.nextProbeAt,
        lastInventoryAt: rt.lastInventoryAt,
        lastEvent: rt.lastEvent,
        lastEventAt: rt.lastEventAt,
        queue: rt.queue.map(function (key) {
          var campaign = byKey[key];
          return campaign ? {
            key: campaign.key,
            name: campaign.name,
            endsAt: campaign.endsAt,
            remainingMs: campaignRemaining(campaign),
            candidates: (campaign.candidates || []).length
          } : null;
        }).filter(Boolean),
        availableCampaigns: catalog.items.map(function (campaign) {
          return {
            key: campaign.key,
            name: campaign.name,
            publisher: campaign.publisher,
            dateRange: campaign.dateRange,
            endsAt: campaign.endsAt,
            remainingMs: campaign.endsAt ? Math.max(0, campaign.endsAt - Date.now()) : 0,
            rewards: (campaign.rewards || []).map(function (r) {
              return { name: r.name, percent: r.percent, hours: r.hours };
            }),
            farmable: !!campaign.targets.length
          };
        }),
        selected: catalog.selected.slice(),
        catalog: {
          scanning: catalog.scanning,
          scannedAt: catalog.scannedAt,
          count: catalog.items.length,
          error: catalog.error
        },
        history: all[1].items.slice(0, 10)
      };
    });
  }

  if (api.notifications && api.notifications.onClicked) {
    api.notifications.onClicked.addListener(function (id) {
      if (id.indexOf(NOTIFICATION_PREFIX) !== 0) return;
      loadRt().then(function (rt) {
        if (rt.ownedTabId != null) {
          Promise.resolve(api.tabs.update(rt.ownedTabId, { active: true })).catch(function () {});
        }
      });
    });
  }

  /**
   * @param {!Array<string>} keys
   * @return {!Promise<*>}
   */
  function setPriority(keys) {
    var sanitized = (Array.isArray(keys) ? keys : [])
      .map(function (k) { return text(k, 180); })
      .filter(Boolean);
    return loadCatalog().then(function (catalog) {
      var valid = {};
      catalog.items.forEach(function (item) { valid[item.key] = item; });
      var filtered = sanitized.filter(function (k) { return !!valid[k]; });
      var seen = {};
      filtered = filtered.filter(function (k) {
        if (seen[k]) return false;
        seen[k] = true;
        return true;
      });
      return Promise.all([
        g.ADT.updateLocal(CATALOG_KEY, function (stored) {
          var next = normalizeCatalog(stored);
          next.selected = filtered;
          return next;
        }),
        g.ADT.updateLocal(RT_KEY, function (stored) {
          var rt = normalizeRt(stored);
          var byKey = {};
          rt.campaigns.forEach(function (campaign) { byKey[campaign.key] = campaign; });
          filtered.forEach(function (key) {
            var item = valid[key];
            if (byKey[key] || !item.targets.length) return;
            var campaign = sanitizeCampaign({
              key: item.key,
              name: item.name,
              endsAt: item.endsAt,
              targets: item.targets,
              rewards: item.rewards.length ? item.rewards : [
                { name: item.name, percent: 0, hours: 0 }
              ]
            });
            if (campaign) {
              rt.campaigns.push(campaign);
              byKey[key] = campaign;
            }
          });
          rt.selected = filtered;
          rt.selectionConfigured = true;
          rt.priority = filtered;
          if (rt.active && filtered.indexOf(rt.active.campaignKey) < 0) {
            rt.active = null;
            rt.state = filtered.length ? 'switching' : 'complete';
            rt.lastEvent = 'selection-changed';
            rt.lastEventAt = Date.now();
          }
          rt.exhausted = rt.exhausted.filter(function (key) {
            return filtered.indexOf(key) >= 0;
          });
          rt.queue = rankQueue(rt.campaigns, rt.priority, rt.exhausted, rt.selected);
          return rt;
        })
      ]);
    }).then(function () { return tick(false); });
  }

  /**
   * Finds a restored farming tab by the token on URLs created by this module.
   * Twitch preserves unknown query parameters; an unmarked user tab on the
   * same channel is never adopted.
   *
   * @return {!Promise<*>}
   */
  function recoverOwnership() {
    return loadRt().then(function (rt) {
      return existingOwnedTab(rt).then(function (tab) {
        if (tab || !rt.ownerToken) return tab;
        return Promise.resolve(api.tabs.query({ url: '*://*.twitch.tv/*' }))
          .then(function (tabs) {
            return (tabs || []).find(function (candidate) {
              return candidate && candidate.id != null &&
                ownerTokenFromUrl(candidate.url || '') === rt.ownerToken;
            }) || null;
          });
      }).then(function (tab) {
        return g.ADT.updateLocal(RT_KEY, function (stored) {
          var current = normalizeRt(stored);
          if (current.ownerToken !== rt.ownerToken) return undefined;
          if (tab && tab.id != null) {
            setOwnership(current, tab.id, tab.url);
            if (current.active) current.active.tabId = tab.id;
            current.lastEvent = 'farming-tab-restored';
            current.lastEventAt = Date.now();
            return current;
          }
          if (current.ownedTabId == null && !current.ownedTabUrl) return undefined;
          setOwnership(current, null);
          current.active = null;
          current.state = 'switching';
          current.lastEvent = 'browser-restart';
          current.lastEventAt = Date.now();
          return current;
        });
      });
    });
  }

  g.ADT.dropsOrchestrator = {
    configure: function (hooks) {
      requestInventoryCheck = hooks && hooks.requestInventoryCheck;
    },
    handleSnapshot: handleSnapshot,
    handleCatalog: handleCatalog,
    setCatalogScanning: setCatalogScanning,
    handleHeartbeat: handleHeartbeat,
    handleClaimAttempt: handleClaimAttempt,
    handleClaimResult: handleClaimResult,
    movePriority: movePriority,
    setPriority: setPriority,
    forgetTab: forgetTab,
    tick: tick,
    resume: function () {
      return recoverOwnership().then(function () { return tick(false); });
    },
    recoverOwnership: recoverOwnership,
    clearOwnership: function () {
      return g.ADT.updateLocal(RT_KEY, function (stored) {
        var rt = normalizeRt(stored);
        if (rt.ownedTabId == null && !rt.ownedTabUrl) return undefined;
        setOwnership(rt, null);
        rt.active = null;
        rt.state = 'switching';
        rt.lastEvent = 'browser-restart';
        rt.lastEventAt = Date.now();
        return rt;
      });
    },
    status: status,
    loadRt: loadRt,
    sanitizeCampaigns: sanitizeCampaigns,
    rankQueue: rankQueue
  };
})();
