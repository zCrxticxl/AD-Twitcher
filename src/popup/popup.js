/**
 * @license
 * Copyright 2026 zCrxticxl
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Popup controller. Renders settings, counters, live-watch state
 * and the per-tab diagnosis, and localizes the static markup on load.
 */
(function () {
  'use strict';

  var api = ADT.api;

  /**
   * @param {string} id
   * @return {?Element}
   */
  var $ = function (id) {
    return document.getElementById(id);
  };

  /**
   * @param {string} sel
   * @return {!Array<!Element>}
   */
  var $$ = function (sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel));
  };

  /** @type {?number} */
  var activeTabId = null;

  /** @type {?number} */
  var pollTimer = null;

  /** @type {?number} */
  var watchlistTimer = null;

  /**
   * True while a master-toggle write is in flight. `set()` round-trips through
   * the background, so a poll landing in that window would otherwise read the
   * still-cached pre-toggle value and flip the checkbox back under the user's
   * click until the next poll catches up.
   * @type {boolean}
   */
  var masterTogglePending = false;

  /**
   * Must mirror content_scripts[0].js in both manifests. scripts/check.mjs
   * fails the build if the two drift apart.
   * @const {!Array<string>}
   */
  var EXPECTED_FILES = [
    'content/beacon.js',
    'lib/browser.js',
    'lib/log.js',
    'lib/storage.js',
    'lib/dom.js',
    'content/modules/watch-health.js',
    'content/modules/channel-points.js',
    'content/modules/drops.js',
    'content/modules/ad-mute.js',
    'content/modules/viewer-stats.js',
    'content/modules/sidebar-watch.js',
    'content/index.js'
  ];

  /** @const {!Object<string, string>} Module name to message key. */
  var MODULE_LABELS = {
    watchHealth: 'moduleWatchHealth',
    channelPoints: 'moduleChannelPoints',
    drops: 'moduleDrops',
    adMute: 'moduleAdMute',
    viewerStats: 'moduleViewerStats',
    sidebarWatch: 'moduleSidebarWatch'
  };

  /** @const {string} Shown wherever a value is not available. */
  var EMPTY = '-';

  /* --------------------------------------------------------------- i18n */

  /**
   * Fills every element carrying data-i18n or a data-i18n-<attr> pair. Called
   * once, before the first render.
   */
  function localizeDom() {
    document.documentElement.lang = ADT.uiLocale;

    $$('[data-i18n]').forEach(function (el) {
      el.textContent = ADT.msg(el.dataset.i18n);
    });

    ['title', 'placeholder', 'aria-label'].forEach(function (attr) {
      var key = 'data-i18n-' + attr;
      $$('[' + key + ']').forEach(function (el) {
        el.setAttribute(attr, ADT.msg(el.getAttribute(key)));
      });
    });

    document.title = ADT.msg('extName');
  }

  /**
   * Writes the installed version into the footer. The manifest is the only
   * source: build.mjs stamps it from package.json, so a badge read at runtime
   * cannot drift from the package that is actually loaded.
   */
  function renderVersion() {
    var el = $('appVersion');
    if (!el) return;
    var manifest = api.runtime.getManifest ? api.runtime.getManifest() : null;
    var version = manifest && manifest.version;
    el.textContent = version ? 'v' + version : EMPTY;
  }

  /* --------------------------------------------- path helpers for data-set */

  /**
   * @param {!Object} obj
   * @param {string} path Dotted, for example "drops.autoClaim".
   * @return {*}
   */
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) {
      return o == null ? undefined : o[k];
    }, obj);
  }

  /**
   * @param {string} path Dotted.
   * @param {*} value
   * @return {!Object} A nested patch object carrying only that leaf.
   */
  function patchFromPath(path, value) {
    var parts = path.split('.');
    var root = {};
    var cur = root;
    for (var i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return root;
  }

  /* --------------------------------------------------------- popup tabs */

  function bindTabs() {
    $$('.tabs__btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('.tabs__btn').forEach(function (b) {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        $$('.pane').forEach(function (p) { p.classList.remove('is-active'); });
        btn.classList.add('is-active');
        btn.setAttribute('aria-selected', 'true');
        var pane = document.querySelector('.pane[data-pane="' + btn.dataset.tab + '"]');
        if (pane) pane.classList.add('is-active');
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        if (btn.dataset.tab === 'viewers') refreshViewerStats();
      });
    });
  }

  /* ----------------------------------------------------------- rendering */

  /**
   * The whole popup re-renders every three seconds. A control the user is
   * typing in must be left alone during that: what they typed is normalized on
   * the way into storage - lowercased, trimmed, a pasted channel URL reduced to
   * the login - so writing the stored value back mid-edit rewrites the text
   * under the caret and sends the caret to the end of the field.
   *
   * @param {!Object} s Settings.
   */
  function renderSettings(s) {
    var editing = document.activeElement;

    if (!masterTogglePending) {
      $('masterToggle').checked = !!s.enabled;
      $('statusDot').classList.toggle('is-on', !!s.enabled);
    }

    $$('[data-set]').forEach(function (el) {
      if (el === editing) return;
      var v = getPath(s, el.dataset.set);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });

    if ($('watchlist') !== editing && !watchlistTimer) {
      $('watchlist').value = (s.autoJoin.channels || []).join('\n');
    }
  }

  /**
   * Counters live under their own storage key so that incrementing them never
   * looks like a settings change.
   *
   * @param {!Object} st
   */
  function renderStats(st) {
    $('sPoints').textContent = ADT.formatNumber(st.pointsClaimed || 0);
    $('sDrops').textContent = ADT.formatNumber(st.dropsClaimed || 0);
    $('sAds').textContent = ADT.formatNumber(st.adsMuted || 0);
    $('sStreams').textContent = ADT.formatNumber(st.streamsOpened || 0);
    if (st.trackingSince) {
      var date = new Intl.DateTimeFormat(ADT.uiLocale, {
        year: 'numeric', month: 'short', day: 'numeric'
      }).format(new Date(st.trackingSince));
      $('statsSince').textContent = ADT.msg('statsRecordedSince', date);
    } else {
      $('statsSince').textContent = ADT.msg('statsRecordedOverall');
    }
  }

  /**
   * @param {number} ts Epoch milliseconds, 0 for never.
   * @return {string}
   */
  function ago(ts) {
    if (!ts) return ADT.msg('agoNever');
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return ADT.msg('agoSeconds', s);
    if (s < 3600) return ADT.msg('agoMinutes', Math.round(s / 60));
    return ADT.msg('agoHours', Math.round(s / 3600));
  }

  /**
   * @param {number} ms
   * @return {string} A duration, not a point in time. "2 h 5 min", never "ago".
   */
  function duration(ms) {
    var minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return ADT.msg('durationMinutes', minutes);
    return ADT.msg('durationHours', [String(Math.floor(minutes / 60)), String(minutes % 60)]);
  }

  /** @const {!Object<string, string>} Drops-check outcome to message key. */
  var DROPS_OUTCOMES = {
    claimed: 'dropsOutcomeClaimed',
    reloaded: 'dropsOutcomeReloaded',
    opened: 'dropsOutcomeOpened',
    idle: 'dropsOutcomeIdle',
    off: 'dropsOutcomeOff',
    error: 'dropsOutcomeError'
  };

  /** @const {!Object<string, string>} Stats key to the label already in use. */
  var ACTION_LABELS = {
    pointsClaimed: 'statBonuses',
    dropsClaimed: 'statDrops',
    adsMuted: 'statAdsMuted',
    streamsOpened: 'statTabsOpened'
  };

  /**
   * The proof-of-life card. Counters alone cannot show that anything is
   * happening, because hours can pass between two claims; these rows can.
   *
   * @param {!Object} activity Background activityStatus() result.
   * @param {!Object} stats
   */
  function renderActivity(activity, stats) {
    var watched = (activity && activity.watching) || [];
    var top = watched[0];

    if (top && top.channel) {
      var state = top.reason
        ? ADT.msg('watchStateStalled')
        : (top.playing ? ADT.msg('watchStatePlaying') : ADT.msg('watchStatePaused'));
      $('acWatching').textContent = top.channel + ' · ' + state;
      $('acFor').textContent = top.since ? duration(Date.now() - top.since) : EMPTY;
    } else {
      $('acWatching').textContent = EMPTY;
      $('acFor').textContent = EMPTY;
    }

    var drops = (activity && activity.drops) || {};
    if (drops.lastCheckAt) {
      var outcome = ADT.msg(DROPS_OUTCOMES[drops.outcome] || 'dropsOutcomeIdle');
      $('acDrops').textContent = ago(drops.lastCheckAt) + ' · ' + outcome;
    } else {
      $('acDrops').textContent = ADT.msg('agoNever');
    }

    var next = activity && activity.nextCheckAt;
    $('acNext').textContent = next && next > Date.now()
      ? ADT.msg('inMinutes', Math.max(1, Math.round((next - Date.now()) / 60000)))
      : EMPTY;

    var labelKey = stats && ACTION_LABELS[stats.lastAction];
    $('acClaim').textContent = labelKey && stats.lastActivityAt
      ? ADT.msg(labelKey) + ' · ' + ago(stats.lastActivityAt)
      : ADT.msg('agoNever');

    $('acHint').textContent = watched.length ? '' : ADT.msg('activityHintIdle');
  }

  /**
   * One row per running drop.
   *
   * @param {!Object} item
   * @return {!Element}
   */
  function progressRow(item) {
    var row = document.createElement('div');
    row.className = 'dp-row';

    var head = document.createElement('div');
    head.className = 'dp-head';

    var name = document.createElement('span');
    name.className = 'dp-name';
    name.textContent = item.name || ADT.msg('dropUnnamed');

    var value = document.createElement('span');
    value.className = 'dp-value';
    var left = remainingMs(item);
    value.textContent = ADT.formatNumber(Math.round(item.percent)) + ' %' +
      (item.hours ? ' · ' + ADT.msg('dropRemaining', duration(left)) : '');

    head.appendChild(name);
    head.appendChild(value);
    row.appendChild(head);

    if (item.campaign) {
      var campaign = document.createElement('span');
      campaign.className = 'dp-campaign';
      campaign.textContent = item.campaign;
      row.appendChild(campaign);
    }

    var track = document.createElement('div');
    track.className = 'dp-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuenow', String(Math.round(item.percent)));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');

    var fill = document.createElement('div');
    fill.className = 'dp-fill';
    fill.style.width = Math.max(1, Math.min(100, item.percent)) + '%';

    track.appendChild(fill);
    row.appendChild(track);
    return row;
  }

  /**
   * Finished drops as markers rather than rows: they carry no remaining time,
   * and a full row each would push the running ones out of view.
   *
   * @param {!Array<!Object>} items
   * @return {!Element}
   */
  function doneRow(items) {
    var wrap = document.createElement('div');
    wrap.className = 'dp-done';

    var label = document.createElement('span');
    label.className = 'dp-done__label';
    label.textContent = ADT.msg('dropProgressDone');
    wrap.appendChild(label);

    items.forEach(function (item) {
      var chip = document.createElement('span');
      chip.className = 'dp-chip';
      chip.textContent = item.name || ADT.msg('dropUnnamed');
      if (item.campaign) chip.title = item.campaign;
      wrap.appendChild(chip);
    });
    return wrap;
  }

  /**
   * How much longer each drop needs, closest first. The percentage comes from
   * the inventory page; the remaining time is derived from it, so it is an
   * estimate that assumes uninterrupted watching - which is exactly what the
   * watchdog is there to keep true.
   *
   * @param {!Object} progress Stored snapshot: {items, updatedAt}.
   */
  function renderProgress(progress) {
    var list = $('dpList');
    var items = (progress && progress.items) || [];

    while (list.firstChild) list.removeChild(list.firstChild);

    var running = items.filter(function (item) { return item.percent < 100; });
    running.sort(function (a, b) { return remainingMs(a) - remainingMs(b); });
    running.forEach(function (item) { list.appendChild(progressRow(item)); });

    // The same tier can be finished in two campaigns running under one name;
    // as a marker that is a repetition, not information.
    var seen = {};
    var done = items.filter(function (item) {
      if (item.percent < 100) return false;
      var key = item.campaign + '\u0000' + item.name;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    if (done.length) list.appendChild(doneRow(done));

    $('dpUpdated').textContent = progress && progress.updatedAt
      ? ago(progress.updatedAt)
      : '';
    /*
     * Two different empty states, and saying the wrong one is worse than
     * saying nothing. A snapshot with a timestamp means the inventory was
     * read and every campaign on it has closed or been collected; without
     * one, no inventory page has been open yet and there is nothing to
     * report either way.
     */
    $('dpHint').textContent = items.length
      ? ''
      : ADT.msg(progress && progress.updatedAt
        ? 'dropProgressNone'
        : 'dropProgressEmpty');
  }

  /**
   * @param {!Object} item
   * @return {number} Milliseconds left, or 0 when the requirement is unknown.
   */
  function remainingMs(item) {
    /*
     * Unknown requirement sorts last: 0 would put it in front of a drop that
     * really is nearly finished. A finite sentinel rather than Infinity,
     * because two unknowns subtract to NaN, and a comparator that returns NaN
     * leaves the order of the whole list up to the engine.
     */
    if (!item || !item.hours) return Number.MAX_VALUE;
    return Math.max(0, item.hours * 3600000 * (1 - (item.percent || 0) / 100));
  }

  /* ------------------------------------------------------------ live watch */

  /** @param {!Object} live liveWatch.status() result. */
  function renderLive(live) {
    $('lwAge').textContent = ago(live.lastReportAt);
    $('lwLive').textContent = live.liveNow.length
      ? live.liveNow.length +
        (live.liveNow.length <= 3 ? ' (' + live.liveNow.join(', ') + ')' : '')
      : '0';
    $('lwOpen').textContent = live.watchedOpen.length
      ? live.watchedOpen.join(', ')
      : EMPTY;

    var hint = '';
    if (live.stale) hint = ADT.msg('liveHintStale');
    else if (!live.knownCount) hint = ADT.msg('liveHintEmpty');
    $('lwHint').textContent = hint;
  }

  /**
   * @param {string} className
   * @param {string} text
   * @return {!Element}
   */
  function chip(className, text) {
    var el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  /**
   * @param {!Element} host
   * @param {!Array<!Element>} children
   */
  function replaceChildren(host, children) {
    host.textContent = '';
    children.forEach(function (c) { host.appendChild(c); });
  }

  /** No beacon at all, so no script is present in the tab. */
  function renderNoScript(tab) {
    var title = document.createElement('b');
    title.textContent = ADT.msg('statusNoScript');
    var url = document.createElement('span');
    url.className = 'muted';
    url.textContent = (tab.url || '').replace(/^https?:\/\//, '').slice(0, 44);

    replaceChildren($('ctxLine'), [title, document.createElement('br'), url]);
    replaceChildren($('activeModules'), [chip('chip chip--off', ADT.msg('chipNotInjected'))]);
    $('diagBox').hidden = true;
    $('btnInject').hidden = false;
  }

  /**
   * The beacon answers but the rest is incomplete. The first missing file is
   * the one that threw.
   *
   * @param {!Object} res Beacon response.
   */
  function renderPartial(res) {
    var missing = EXPECTED_FILES.filter(function (f) {
      return res.loaded.indexOf(f) < 0;
    });

    var title = document.createElement('b');
    title.textContent = ADT.msg('statusPartial');
    var count = document.createElement('span');
    count.className = 'muted';
    count.textContent = ADT.msg('statusFilesLoaded',
      [res.loaded.length, EXPECTED_FILES.length]);

    replaceChildren($('ctxLine'), [title, document.createElement('br'), count]);
    replaceChildren($('activeModules'), [chip('chip chip--off', ADT.msg('chipDegraded'))]);

    var box = $('diagBox');
    box.textContent = '';

    if (missing.length) {
      var h = document.createElement('div');
      h.className = 'diag__h';
      h.textContent = ADT.msg('diagMissingHeader');
      var ol = document.createElement('ol');
      ol.className = 'diag__l';
      missing.forEach(function (f, i) {
        var li = document.createElement('li');
        if (i === 0) li.className = 'diag__first';
        li.textContent = f;
        ol.appendChild(li);
      });
      box.appendChild(h);
      box.appendChild(ol);
    }

    if (res.errors && res.errors.length) {
      var eh = document.createElement('div');
      eh.className = 'diag__h';
      eh.textContent = ADT.msg('diagErrorsHeader');
      var ul = document.createElement('ul');
      ul.className = 'diag__l';
      res.errors.forEach(function (e) {
        var li = document.createElement('li');
        var where = document.createElement('b');
        where.textContent = e.where;
        li.appendChild(where);
        li.appendChild(document.createElement('br'));
        li.appendChild(document.createTextNode(e.msg));
        if (e.stack) {
          li.appendChild(document.createElement('br'));
          var st = document.createElement('span');
          st.className = 'muted';
          st.textContent = e.stack;
          li.appendChild(st);
        }
        ul.appendChild(li);
      });
      box.appendChild(eh);
      box.appendChild(ul);
    }

    if (!box.childNodes.length) {
      var note = document.createElement('div');
      note.className = 'diag__h';
      note.textContent = ADT.msg('diagStartupFailed');
      box.appendChild(note);
    }

    box.hidden = false;
    $('btnInject').hidden = false;
  }

  function renderNoTab() {
    $('ctxLine').textContent = ADT.msg('statusNoTab');
    replaceChildren($('activeModules'), [chip('chip chip--off', EMPTY)]);
    $('diagBox').hidden = true;
    $('btnInject').hidden = true;
  }

  /** @param {?Object} res Beacon response. */
  function renderContext(res) {
    if (!res || !res.ok) {
      renderNoTab();
      return;
    }
    $('btnInject').hidden = true;
    $('diagBox').hidden = true;

    var label = {
      channel: ADT.msg('pageChannel', res.channel || '?'),
      drops: ADT.msg('pageDrops'),
      other: ADT.msg('pageOther')
    }[res.page] || ADT.msg('pageOther');
    $('ctxLine').textContent = label;

    replaceChildren($('activeModules'), res.active && res.active.length
      ? res.active.map(function (m) {
        return chip('chip', MODULE_LABELS[m] ? ADT.msg(MODULE_LABELS[m]) : m);
      })
      : [chip('chip chip--off', ADT.msg('chipNone'))]);
  }

  /* ------------------------------------------------------- viewer stats */

  function refreshViewerStats() {
    if (activeTabId == null) return;
    ADT.sendToTab(activeTabId, { type: 'adt:get-viewer-stats' }).then(function (res) {
      var fields = ['vsViewers', 'vsMpm', 'vsUnique', 'vsRatio', 'vsMpc', 'vsJumps'];
      if (!res || !res.ok) {
        fields.forEach(function (id) { $(id).textContent = EMPTY; });
        $('vsChannel').textContent = '';
        $('vsMeta').textContent = ADT.msg('viewerMetaInactive');
        return;
      }
      var d = res.data;
      $('vsChannel').textContent = d.channel ? '· ' + d.channel : '';
      $('vsViewers').textContent = ADT.formatNumber(d.viewers, EMPTY);
      $('vsMpm').textContent = ADT.formatNumber(d.msgsPerMin, EMPTY);
      $('vsUnique').textContent = ADT.formatNumber(d.uniqueChatters, EMPTY);
      $('vsRatio').textContent = ADT.formatNumber(d.chattersPer1k, EMPTY);
      $('vsMpc').textContent = ADT.formatNumber(d.msgsPerChatter, EMPTY);
      $('vsJumps').textContent = d.jumps.length
        ? d.jumps.map(function (j) { return (j.delta > 0 ? '+' : '') + j.delta; }).join(', ')
        : ADT.msg('chipNone');
      $('vsMeta').textContent = ADT.msg('viewerMeta',
        [d.windowMin, d.messages, d.sampledFor]);
    });
  }

  /* ---------------------------------------------------------------- log */

  /** @param {?Object} res */
  function showLog(res) {
    if (!res || !res.ok || !res.lines || !res.lines.length) {
      $('logOut').textContent = ADT.msg('logEmpty');
      return;
    }
    $('logOut').textContent = res.lines.map(function (l) {
      var d = new Date(l.t);
      var hh = String(d.getHours()).padStart(2, '0');
      var mm = String(d.getMinutes()).padStart(2, '0');
      var ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss + '  ' +
        l.kind.toUpperCase().padEnd(5) + '  ' + l.msg;
    }).join('\n');
  }

  /* ------------------------------------------------------- tab discovery */

  /**
   * Prefers the active tab, then any tab in the same window, then any tab at
   * all. Users often click the toolbar icon from somewhere else.
   *
   * @return {!Promise<?Object>}
   */
  function findTwitchTab() {
    return Promise.resolve(api.tabs.query({ active: true, currentWindow: true }))
      .then(function (tabs) {
        var t = tabs && tabs[0];
        if (t && /:\/\/[^\/]*twitch\.tv\//.test(t.url || '')) return t;
        return Promise.resolve(api.tabs.query({ url: '*://*.twitch.tv/*' }))
          .then(function (all) {
            if (!all || !all.length) return null;
            var win = t && t.windowId;
            return all.filter(function (x) { return x.windowId === win; })[0] || all[0];
          });
      })
      .catch(function () { return null; });
  }

  /* ------------------------------------------------------------ bindings */

  /**
   * `settings.set()` round-trips through the background and rejects if that
   * fails - most often a message sent while the MV3 worker is mid-restart.
   * The control whatever the user just touched shows right now was never
   * actually stored, so the only correct move is to put it back in sync with
   * what is. `renderSettings` already knows how to do that without touching a
   * field the user is still editing.
   *
   * @param {*} e
   */
  function settingsWriteFailed(e) {
    ADT.log.error('Settings write failed: ' + (e && e.message));
    ADT.settings.get().then(renderSettings);
  }

  function bindInputs() {
    $$('[data-set]').forEach(function (el) {
      var evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evt, function () {
        var val;
        if (el.type === 'checkbox') {
          val = el.checked;
        } else if (el.type === 'number') {
          val = parseInt(el.value, 10);
          if (isNaN(val)) return;
        } else {
          val = el.value;
        }

        ADT.settings.set(patchFromPath(el.dataset.set, val)).then(function () {
          ADT.send({ type: 'adt:settings-changed' });
        }, settingsWriteFailed);
      });
    });

    $('watchlist').addEventListener('input', function () {
      clearTimeout(watchlistTimer);
      watchlistTimer = setTimeout(function () {
        watchlistTimer = null;
        var list = $('watchlist').value
          .split('\n')
          .map(function (x) {
            return x.trim().toLowerCase()
              .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
              .replace(/[\/?#].*$/, '');
          })
          .filter(Boolean);
        // Drop duplicates, keep order.
        list = list.filter(function (x, i) { return list.indexOf(x) === i; });
        ADT.settings.set({ autoJoin: { channels: list } }).catch(settingsWriteFailed);
      }, 500);
    });

    $('masterToggle').addEventListener('change', function () {
      var checked = $('masterToggle').checked;
      masterTogglePending = true;
      ADT.settings.set({ enabled: checked }).then(function () {
        masterTogglePending = false;
        $('statusDot').classList.toggle('is-on', checked);
        ADT.send({ type: 'adt:settings-changed' });
      }, function (e) {
        masterTogglePending = false;
        settingsWriteFailed(e);
      });
    });

    $('btnReset').addEventListener('click', function () {
      if (!confirm(ADT.msg('confirmReset'))) return;
      ADT.settings.reset().then(function (s) {
        renderSettings(s);
        ADT.settings.getStats().then(renderStats);
        ADT.send({ type: 'adt:settings-changed' });
      });
    });

    $('btnDropsNow').addEventListener('click', function () {
      ADT.send({ type: 'adt:drops-check-now' });
      if (activeTabId != null) {
        ADT.sendToTab(activeTabId, { type: 'adt:claim-drops-now' });
      }
      $('btnDropsNow').textContent = ADT.msg('btnDropsNowBusy');
      setTimeout(function () {
        $('btnDropsNow').textContent = ADT.msg('btnDropsNow');
      }, 2500);
    });

    $('btnRefresh').addEventListener('click', function () {
      if (activeTabId != null) ADT.sendToTab(activeTabId, { type: 'adt:refresh' });
      refreshAll();
    });

    $('btnInject').addEventListener('click', function () {
      var b = $('btnInject');
      b.disabled = true;
      b.textContent = ADT.msg('btnInjectBusy');
      ADT.send({ type: 'adt:reinject' }).then(function (r) {
        b.disabled = false;
        b.textContent = ADT.msg('btnInject');
        if (r && r.ok) {
          var n = r.result.injected;
          $('ctxLine').textContent = n
            ? ADT.msg('injectDone', n)
            : ADT.msg('injectNothing');
        }
        setTimeout(refreshAll, 1200);
      });
    });

    $('btnLogTab').addEventListener('click', function () {
      if (activeTabId == null) {
        $('logOut').textContent = ADT.msg('logNoTab');
        return;
      }
      ADT.sendToTab(activeTabId, { type: 'adt:get-log' }).then(showLog);
    });

    $('btnLogBg').addEventListener('click', function () {
      ADT.send({ type: 'adt:bg-log' }).then(showLog);
    });
  }

  /* ---------------------------------------------------------- bootstrap */

  function refreshAll() {
    ADT.settings.get().then(renderSettings);

    // Stats and status are rendered together because the activity card needs
    // both: the last claim comes from the counters, the rest from the worker.
    Promise.all([
      ADT.settings.getStats(),
      ADT.send({ type: 'adt:status' })
    ]).then(function (r) {
      var stats = r[0];
      var res = r[1];
      renderStats(stats);
      if (res && res.ok) {
        renderLive(res.live);
        renderActivity(res.activity || {}, stats);
        renderProgress((res.activity && res.activity.progress) || {});
      }
    });

    findTwitchTab().then(function (t) {
      if (!t || t.id == null) {
        activeTabId = null;
        renderNoTab();
        return null;
      }
      activeTabId = t.id;
      return ADT.pingTab(t.id).then(function (res) {
        if (!res) renderNoScript(t);                 // No script at all.
        else if (!res.complete) renderPartial(res);  // Beacon alive, rest broken.
        else renderContext(res);                     // Healthy.
      });
    });
  }

  localizeDom();
  renderVersion();
  bindTabs();
  bindInputs();
  refreshAll();

  pollTimer = setInterval(function () {
    refreshAll();
    var pane = document.querySelector('.pane[data-pane="viewers"]');
    if (pane && pane.classList.contains('is-active')) refreshViewerStats();
  }, 3000);

  window.addEventListener('unload', function () { clearInterval(pollTimer); });
})();
