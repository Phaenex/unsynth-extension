/**
 * Unsynth Subscription Manager.
 *
 * Groups are stored locally (chrome.storage.local 'subStore' = {groups,names});
 * the active group filter is 'subActive'. Filtering the subscriptions feed is
 * pure DOM (match each tile's channel key against the active group) — no API on
 * the page itself. Also injects a sidebar group switcher and a channel-page
 * "＋ Group" button. Bulk import uses the Data API from the dashboard.
 */
(function () {
  'use strict';

  var SG = window.UNSubGroups;
  var SF = window.UNSubFeed;
  var YD = window.UNYtDom;
  var core = null;
  var store = { groups: {}, names: {} };
  var active = '';
  // Home-page surfacing: a chosen group can FILTER the home feed (hide non-group
  // tiles), pin a SHELF of that group's loaded uploads at the top, or BOTH.
  var homeMode = 'off'; // 'off' | 'filter' | 'shelf' | 'both'
  var homeGroup = '';

  function load(cb) {
    chrome.storage.local.get({ subStore: { groups: {}, names: {} }, subActive: '', subHomeMode: 'off', subHomeGroup: '' }, function (d) {
      store = d.subStore || { groups: {}, names: {} };
      active = d.subActive || '';
      homeMode = d.subHomeMode || 'off';
      homeGroup = d.subHomeGroup || '';
      cb && cb();
    });
  }
  function saveStore() {
    chrome.storage.local.set({ subStore: store });
  }
  function setActive(name) {
    active = name;
    chrome.storage.local.set({ subActive: name }, function () {
      if (chrome.runtime.lastError) return;
      try {
        document.dispatchEvent(new CustomEvent('unsynth-sub-filter-apply'));
      } catch (e) {
        /* ignore */
      }
    });
  }
  function setHome(mode, group) {
    homeMode = mode;
    if (group !== undefined) homeGroup = group;
    chrome.storage.local.set({ subHomeMode: homeMode, subHomeGroup: homeGroup });
  }

  // Surfaces the group filter applies to: Subscriptions, History, and single
  // playlist pages incl. Watch Later (/playlist?list=…). All are video-tile
  // feeds the active group can filter. (Not /feed/playlists — that's folders.)
  // Surfaces where a subscription-group filter makes sense: feeds YouTube built
  // FOR you out of channels you follow.
  //
  // '/playlist' is deliberately NOT here. A playlist is a list you curated by
  // hand; hiding its videos because their channels aren't in the active
  // subscription group removes things you explicitly put there. With a group
  // selected, a mixed-channel playlist rendered almost entirely blank — all rows
  // present in the DOM, every one display:none via the un-sub-filter-on body
  // class. Clicking a video appeared to "fix" it only because navigating drops
  // that class before the next page re-applies it.
  function onFilterFeed() {
    var p = location.pathname;
    return p.startsWith('/feed/subscriptions') || p.startsWith('/feed/history');
  }
  // Iterate the filterable tiles for the current surface. Only the subscription
  // and history feeds are filterable now, so this is the shared feed-tile walk;
  // the playlist-row branch was removed with '/playlist' (see onFilterFeed).
  function filterEachTile(cb) {
    forEachFeedTile(cb);
  }

  function tileChannelKey(tile) {
    return SF ? SF.tileChannelKey(tile) : null;
  }

  function forEachFeedTile(cb) {
    if (SF && SF.forEachFeedTile) {
      SF.forEachFeedTile(cb);
      return;
    }
    if (YD && YD.FEED_TILES) {
      YD.FEED_TILES.forEach(function (sel) { document.querySelectorAll(sel).forEach(cb); });
    }
  }

  function clearFilter() {
    document.body.classList.remove('un-sub-filter-on', 'un-sub-feed-capped');
    document.querySelectorAll('[data-unsub]').forEach(function (el) {
      delete el.dataset.unsub;
      el.classList.remove('un-sub-hidden');
    });
    // The group-switcher chip is managed by ensureFilterBanner (it persists even
    // when "All" is selected so you can switch back), so don't remove it here.
  }

  // "YT Default" masthead peek (watch-history.js toggleDefaultFeed) — same flag
  // ai-filter.js already reads to bypass AI filtering while it's on. Sub-group
  // filtering didn't listen for it at all, so a user previewing "what YouTube
  // would normally show" still had non-group tiles hidden. Mirrors ai-filter.js's
  // defaultCleared pattern: clear once, not on every scan while peeking.
  function defaultFeedOn() {
    return document.documentElement.classList.contains('un-default-feed');
  }
  var filterPeekCleared = false;
  var homePeekCleared = false;

  // Content-type facets, independently toggled. Was a single string with an
  // 'all' member, which made the group single-select and put a persistent "All"
  // chip next to the watch-status cluster's own "All" — two identical words,
  // different meanings, byte-identical styling. Absence of selection IS "all",
  // so the chip is gone and combinations that were previously unreachable
  // (long AND live) now work. 'unwatched' is gone too: Watched: Hide is the
  // same predicate against the real watch store, rather than a second guess
  // from YouTube's resume bar.
  var typeFilters = new Set(); // any of 'long' | 'shorts' | 'live'

  function activeGroupList(act) {
    if (!act) return [];
    return String(act).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function parseTileInfo(tile) {
    if (!tile) return { isShort: false, isLive: false, durationSec: 0 };
    var isShort = false;
    var isLive = false;
    var durationSec = 0;

    var link = tile.querySelector('a[href*="/shorts/"]');
    if (link || (tile.tagName && YD && tile.tagName.toLowerCase() === YD.REEL_TILE_TAG)) isShort = true;

    var overlays = tile.querySelectorAll(YD ? YD.TILE_LIVE_OVERLAY_SEL : '#time-status');
    overlays.forEach(function (el) {
      var txt = (el.textContent || '').trim().toUpperCase();
      if (txt.indexOf('LIVE') !== -1 || txt.indexOf('UPCOMING') !== -1 || txt.indexOf('STREAM') !== -1) isLive = true;
      if (txt.indexOf('SHORTS') !== -1) isShort = true;
      var timeMatch = txt.match(/(\d+):(\d+)(?::(\d+))?/);
      if (timeMatch) {
        if (timeMatch[3] != null) {
          durationSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
        } else {
          durationSec = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
        }
      }
    });
    return { isShort: isShort, isLive: isLive, durationSec: durationSec };
  }

  // isTileWatched() lived here and is deliberately gone. It tested
  // `classList.contains('un-watched')`, a token nothing in the codebase ever
  // applies, so that branch was always false and it silently fell through to
  // YouTube's own resume bar at >85%. Meanwhile watch-history judged the same
  // question from Unsynth's own store at 75%. Two chips about "watched", two
  // data sources, two thresholds, and they could be set to contradict each
  // other on the same page. There is now exactly one definition of watched, in
  // watch-history, reached through the Watched control.

  // Facets are OR within the set and AND against the group, the standard
  // faceted rule. An empty set means no type filtering at all.
  function tileMatchesTypes(tile, types) {
    if (!types || !types.size) return true;
    var info = parseTileInfo(tile);
    if (types.has('long') && info.durationSec >= 1200) return true;
    if (types.has('shorts') && (info.isShort || (info.durationSec > 0 && info.durationSec <= 60))) return true;
    if (types.has('live') && info.isLive) return true;
    return false;
  }

  // A group switcher chip and feed sort bar in the masthead slot
  function ensureFilterBanner() {
    var groupNames = Object.keys(store.groups || {});
    if (!onFilterFeed() || !groupNames.length) {
      var existing = document.getElementById('un-sub-filter-banner');
      if (existing) existing.remove();
      var existingBar = document.getElementById('un-sub-quick-sorts');
      if (existingBar) existingBar.remove();
      closeGroupSwitcher();
      return;
    }
    var host = null;
    if (window.UNMastheadSlot && window.UNMastheadSlot.ensureMastheadStructure) {
      var slot = window.UNMastheadSlot.ensureMastheadStructure();
      host = slot && slot.extra;
    }
    if (!host) host = document.getElementById('un-synth-masthead-extra');
    if (!host) return;

    var chip = document.getElementById('un-sub-filter-banner');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'un-sub-filter-banner';
      chip.type = 'button';
      chip.className = 'un-sub-filter-chip';
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleGroupSwitcher(chip);
      });
      host.insertBefore(chip, host.firstChild);
    }
    var groups = activeGroupList(active);
    var label = groups.length === 0 ? 'All' : (groups.length === 1 ? groups[0] : groups.length + ' groups') + (defaultFeedOn() ? ' (preview)' : '');
    if (chip.dataset.group !== label) {
      chip.dataset.group = label;
      chip.textContent = '';
      // Name the axis. A bare "All" here sat beside the watch-status cluster's
      // own "All" and the type cluster's "All", three identical words meaning
      // three different things. Prefixed, the word is unambiguous and the chip
      // reads as a value, which is what it is.
      var axis = document.createElement('span');
      axis.className = 'un-sub-chip-axis';
      axis.textContent = 'Channels: ';
      chip.appendChild(axis);
      var bold = document.createElement('b');
      bold.textContent = label;
      chip.appendChild(bold);
      chip.appendChild(document.createTextNode(' ▾'));
    }
    // Scope narrowed = this control is acting. "All" is a no-op, so it stays
    // outlined. This chip previously had no active state in either direction.
    chip.classList.toggle('on', groups.length > 0);
    chip.setAttribute('aria-haspopup', 'menu');
    // aria-haspopup with no aria-expanded announces a menu button whose state
    // never exists. This file had haspopup and ZERO aria-expanded anywhere, so
    // the chip never reported open or closed in either direction. Seeded here
    // and kept in step by toggleGroupMenu / closeGroupMenu.
    if (!chip.hasAttribute('aria-expanded')) chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-label', 'Channels: ' + label);

    var sortBar = document.getElementById('un-sub-quick-sorts');
    if (!sortBar) {
      sortBar = document.createElement('div');
      sortBar.id = 'un-sub-quick-sorts';
      sortBar.className = 'un-sub-quick-sorts';
      // '> 20m' became 'Long': it was the only control in the bar exposing an
      // implementation constant, and the only one punctuated, sitting between
      // two plain nouns. The threshold lives in the tooltip instead.
      var sorts = [
        { id: 'long', label: 'Long', title: '20 minutes or longer' },
        { id: 'shorts', label: 'Shorts', title: 'Shorts only' },
        { id: 'live', label: 'Live', title: 'Live streams only' }
      ];
      sorts.forEach(function (s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-sub-sort-btn' + (typeFilters.has(s.id) ? ' on' : '');
        btn.dataset.sort = s.id;
        btn.textContent = s.label;
        btn.title = s.title;
        // State was colour-only, so a screen reader had no active state at all.
        btn.setAttribute('aria-pressed', typeFilters.has(s.id) ? 'true' : 'false');
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeFilters.has(s.id)) typeFilters.delete(s.id);
          else typeFilters.add(s.id);
          sortBar.querySelectorAll('.un-sub-sort-btn').forEach(function (b) {
            var on = typeFilters.has(b.dataset.sort);
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          applyFilter();
        });
        sortBar.appendChild(btn);
      });
      chip.insertAdjacentElement('afterend', sortBar);
    }
  }

  // Live-streams bar: shows which subscriptions are currently live
  function ensureLiveBar() {
    if (!onFilterFeed()) {
      var old = document.getElementById('un-sub-live-bar');
      if (old) old.remove();
      return;
    }
    var liveChannels = [];
    var seen = {};
    filterEachTile(function (tile) {
      var info = parseTileInfo(tile);
      if (!info.isLive) return;
      var name = tileChannelName(tile);
      if (!name || seen[name]) return;
      seen[name] = true;
      liveChannels.push({ name: name });
    });
    var bar = document.getElementById('un-sub-live-bar');
    if (!liveChannels.length) {
      if (bar) bar.remove();
      return;
    }
    var feedContainer = document.querySelector(YD ? YD.SUB_FEED_CONTAINER_SEL : '#primary #contents');
    if (!feedContainer) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'un-sub-live-bar';
      bar.className = 'un-sub-live-bar';
      feedContainer.parentNode.insertBefore(bar, feedContainer);
    } else if (!document.body.contains(bar) && feedContainer.parentNode) {
      feedContainer.parentNode.insertBefore(bar, feedContainer);
    }
    bar.textContent = '';
    var label = document.createElement('span');
    label.className = 'un-sub-live-bar-label';
    label.innerHTML = '<span class="un-sub-live-dot"></span>LIVE NOW';
    bar.appendChild(label);
    var scroll = document.createElement('div');
    scroll.className = 'un-sub-live-bar-scroll';
    liveChannels.forEach(function (ch) {
      var chip = document.createElement('a');
      chip.className = 'un-sub-live-bar-chip';
      chip.textContent = ch.name;
      chip.href = '#';
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        // Scroll to this channel's tile
        var tiles = document.querySelectorAll(YD ? YD.SUB_RICH_ITEM_SEL : 'a[href*="/watch"]');
        tiles.forEach(function (t) {
          var tName = tileChannelName(t);
          if (tName === ch.name) {
            t.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      });
      scroll.appendChild(chip);
    });
    bar.appendChild(scroll);
  }

  var groupSwitchDocClick = null;
  var groupSwitchKey = null;
  var groupSwitchEsc = null;
  var groupMenuEsc = null;
  var homeMenuEsc = null;
  function closeGroupSwitcher() {
    var m = document.getElementById('un-sub-switcher');
    if (m) m.remove();
    if (groupSwitchDocClick) {
      document.removeEventListener('click', groupSwitchDocClick, true);
      groupSwitchDocClick = null;
    }
    if (groupSwitchEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(groupSwitchEsc);
      groupSwitchEsc = null;
    }
    if (groupSwitchKey) {
      document.removeEventListener('keydown', groupSwitchKey, true);
      groupSwitchKey = null;
    }
  }
  function toggleGroupSwitcher(chip) {
    if (document.getElementById('un-sub-switcher')) {
      closeGroupSwitcher();
      return;
    }
    var menu = document.createElement('div');
    menu.id = 'un-sub-switcher';
    menu.className = 'un-home-menu';
    var currentList = activeGroupList(active);

    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'un-sub-guide-item' + (!currentList.length ? ' on' : '');
    all.textContent = 'All subscriptions';
    all.addEventListener('click', function () {
      closeGroupSwitcher();
      setActive('');
    });
    menu.appendChild(all);

    Object.keys(store.groups || {}).forEach(function (name) {
      var row = document.createElement('button');
      row.type = 'button';
      var isAct = currentList.indexOf(name) !== -1;
      row.className = 'un-sub-guide-item' + (isAct ? ' on' : '');
      row.textContent = (isAct ? '✓ ' : '') + name + ' (' + (store.groups[name] || []).length + ')';
      row.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          var next = isAct ? currentList.filter(function (x) { return x !== name; }) : currentList.concat([name]);
          setActive(next.join(','));
          row.classList.toggle('on', !isAct);
          row.textContent = (!isAct ? '✓ ' : '') + name + ' (' + (store.groups[name] || []).length + ')';
        } else {
          closeGroupSwitcher();
          setActive(name);
        }
      });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    var r = chip.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    var w = menu.offsetWidth || 230;
    menu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px';
    menu.style.right = 'auto';
    groupSwitchDocClick = function (e) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) closeGroupSwitcher();
    };
    // Escape goes through the shared LIFO stack so only the topmost overlay
    // closes; a raw document listener here also closed whatever panel was
    // open behind this menu.
    groupSwitchEsc = window.UNSYNTH && window.UNSYNTH.pushPanel
      ? window.UNSYNTH.pushPanel(closeGroupSwitcher)
      : null;
    groupSwitchKey = groupSwitchEsc ? null : function (e) {
      if (e.key === 'Escape') closeGroupSwitcher();
    };
    setTimeout(function () {
      document.addEventListener('click', groupSwitchDocClick, true);
      if (groupSwitchKey) document.addEventListener('keydown', groupSwitchKey, true);
    }, 0);
  }

  function applyFilter() {
    if (defaultFeedOn()) {
      if (!filterPeekCleared) {
        clearFilter();
        filterPeekCleared = true;
      }
      return;
    }
    filterPeekCleared = false;
    var groups = activeGroupList(active);
    if (!onFilterFeed() || (!groups.length && !typeFilters.size)) {
      clearFilter();
      return;
    }
    document.body.classList.add('un-sub-filter-on');
    ensureFilterBanner();
    
    var nameSetMap = {};
    groups.forEach(function (g) {
      if (SG.groupNameSet) nameSetMap[g] = SG.groupNameSet(store, g);
    });

    var total = 0;
    var matched = 0;
    var shown = 0;
    filterEachTile(function (tile) {
      total++;
      tile.dataset.unsub = '1';
      var inGroup = groups.length === 0;
      if (!inGroup) {
        for (var i = 0; i < groups.length; i++) {
          if (tileInGroup(groups[i], tile, nameSetMap[groups[i]])) {
            inGroup = true;
            break;
          }
        }
      }
      var matchesSort = inGroup && tileMatchesTypes(tile, typeFilters);
      if (matchesSort) {
        tile.classList.remove('un-sub-hidden');
        matched++;
        // "Shown" used to mean "this group wants it", which is not the same as
        // the user being able to see it. Turn on Hide-watched next to a group
        // and the readout kept counting tiles that were display:none — it
        // claimed "40 of 200" over a page showing twelve.
        if (!hiddenByAnotherFilter(tile)) shown++;
      } else {
        tile.classList.add('un-sub-hidden');
      }
    });

    // GROUP_TARGET_MATCHES is documented as "this many videos ON SCREEN", so
    // the visible count is also the right thing to load against: a group whose
    // matches are mostly watched-and-hidden should keep fetching, not stop at
    // 120 invisible ones. Still bounded by GROUP_MAX_SCAN.
    // Two ways to be done, and the second one matters now that `shown`
    // excludes tiles other filters hid. A group that is mostly watched-and-
    // hidden can never reach 120 VISIBLE, so loading against `shown` alone
    // kept nudging YouTube's infinite scroll every 1.2s all the way to
    // GROUP_MAX_SCAN (4000 tiles) -- a lot of unrequested fetching to end up
    // showing a handful of rows. Stopping once the group has been found in
    // quantity, whether or not those matches survive the other filters, bounds
    // that at something proportional to the group instead.
    var enough = shown >= GROUP_TARGET_MATCHES || matched >= GROUP_MATCHED_CEILING;
    var exhausted = total >= GROUP_MAX_SCAN;
    document.body.classList.toggle('un-sub-feed-capped', enough || exhausted);
    updateFilterProgress(shown, total, enough || exhausted, matched - shown);
    if (!enough && !exhausted) requestMoreFeed();
    ensureLiveBar();
  }

  // Keep loading until the group has this many videos on screen...
  var GROUP_TARGET_MATCHES = 120;
  // ...but never scan more than this many total tiles, so an empty/stale group
  // can't drive an unbounded infinite scroll.
  var GROUP_MAX_SCAN = 4000;
  // ...and stop once this many tiles have MATCHED the group, even if other
  // filters mean few of them are visible, so a mostly-watched group does not
  // scroll to the scan cap chasing 120 visible rows that do not exist.
  var GROUP_MATCHED_CEILING = 400;

  var moreFeedPending = false;
  var lastFeedNudge = 0;
  // YouTube loads its next batch when the continuation sentinel approaches the
  // viewport. When a group hides most tiles the filtered page can be shorter
  // than the window, so that sentinel is never approached and loading simply
  // stalls — which is why a sparse group looked like it had almost nothing in
  // it.
  //
  // Deliberately does NOT call scrollIntoView(): that would yank the page
  // under the user while they are reading, which is a worse bug than the one
  // being fixed. Instead it dispatches the scroll/resize events YouTube's own
  // observer listens for, letting YouTube decide to fetch. If YouTube ignores
  // them the feed just stays where it is — no harm, and the visible progress
  // count (see updateFilterProgress) tells the user what actually loaded
  // rather than pretending.
  function requestMoreFeed() {
    var now = Date.now();
    if (moreFeedPending || now - lastFeedNudge < 1200) return;
    var cont = document.querySelector(YD ? YD.CONTINUATION_SEL : '#continuations');
    if (!cont) return; // nothing left to load — the feed really is exhausted
    moreFeedPending = true;
    lastFeedNudge = now;
    setTimeout(function () {
      moreFeedPending = false;
      try {
        window.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      } catch (e) {
        /* ignore — the next scan retries */
      }
    }, 350);
  }

  // Show what the group actually found, and whether more is still coming. A
  // filtered feed that is still loading looks identical to one that found
  // nothing, so without this the user can't tell "empty group" from "wait a
  // second" — the difference between a bug and normal behaviour.
  function updateFilterProgress(shown, total, done, hiddenElsewhere) {
    var chip = document.getElementById('un-sub-filter-banner');
    if (!chip) return;
    var el = chip.querySelector('.un-sub-filter-progress');
    if (!el) {
      el = document.createElement('span');
      el.className = 'un-sub-filter-progress';
      chip.appendChild(el);
    }
    var txt = shown + (done ? '' : '…') + ' of ' + total;
    if (el.textContent !== txt) el.textContent = txt;
    // A number that dropped because ANOTHER filter is also on reads like this
    // group is empty. Naming the other filter is the difference between "your
    // group found nothing" and "your group found plenty, you are hiding it".
    var extra = hiddenElsewhere > 0
      ? ' · ' + hiddenElsewhere + ' more match' + (hiddenElsewhere === 1 ? 'es' : '') +
        ' this group but ' + (hiddenElsewhere === 1 ? 'is' : 'are') + ' hidden by another filter'
      : '';
    el.title = shown + ' video' + (shown === 1 ? '' : 's') +
      ' from this group visible out of ' + total + ' loaded' +
      (done ? '' : ' — still loading') + extra;
    el.classList.toggle('has-foreign-hidden', hiddenElsewhere > 0);
  }

  // Three modules hide feed tiles independently and none of them knows about
  // the others: this one (group/type), watch-history (watch status), and
  // ai-filter (AI-slop). pl-folder-manager does the same on library pages.
  // All four are display:none, so a tile carrying any of them is gone
  // regardless of what this filter decided about it.
  //
  // Read off classList rather than measuring layout: this runs per tile across
  // up to GROUP_MAX_SCAN tiles inside a loop that also writes classes, so an
  // offsetParent/getClientRects read here would force a reflow per tile.
  var FOREIGN_HIDE_CLASSES = ['un-watched-hide', 'unsynth-hidden', 'un-plf-hidden'];

  function hiddenByAnotherFilter(tile) {
    if (!tile || !tile.classList) return false;
    for (var i = 0; i < FOREIGN_HIDE_CLASSES.length; i++) {
      if (tile.classList.contains(FOREIGN_HIDE_CLASSES[i])) return true;
    }
    return false;
  }

  // True when a feed tile belongs to the active group — by channel key (handle/
  // id, alias-aware) OR, as a fallback, by resolved channel name.
  function tileInGroup(group, tile, nameSet) {
    var key = tileChannelKey(tile);
    if (key && SG.inGroup(store, group, key)) return true;
    if (nameSet) {
      var nm = SG.normName(tileChannelName(tile));
      if (nm && nameSet[nm]) return true;
    }
    return false;
  }

  function tileChannelName(tile) {
    if (!tile || !tile.querySelector) return '';
    var a =
      tile.querySelector(YD ? YD.TILE_CHANNEL_LINK_COMPACT_SEL : '#channel-name a[href]') ||
      tile.querySelector('a[href*="/@"]');
    return a && (a.getAttribute('href') || '').indexOf('/watch') !== 0 ? (a.textContent || '').trim() : '';
  }

  var filterRetryTimer = null;
  function scheduleFilterRetry() {
    if (!active || !onFilterFeed()) return;
    if (filterRetryTimer) clearTimeout(filterRetryTimer);
    filterRetryTimer = setTimeout(function () {
      filterRetryTimer = null;
      applyFilter();
    }, 500);
  }

  function scrapeFeedThumbs() {
    if (!location.pathname.startsWith('/feed/subscriptions')) return;
    var SCT = window.UNSubChannelThumbs;
    if (!SCT) return;
    chrome.storage.local.get({ subChannelThumbs: {} }, function (d) {
      var thumbs = d.subChannelThumbs || {};
      var touched = false;
      forEachFeedTile(function (tile) {
        var key = tileChannelKey(tile);
        if (!key) return;
        var url = SCT.thumbFromFeedTile(tile);
        if (url && SCT.remember(thumbs, key, url)) touched = true;
      });
      if (touched) chrome.storage.local.set({ subChannelThumbs: thumbs });
    });
  }

  // ---- channel-page "add to group" button ----
  function currentChannelKey() {
    return SG.channelKey(location.pathname);
  }
  // YouTube's channel header markup has moved to yt-page-header-view-model
  // (the same "view-model" web-component rewrite as the subscribe button —
  // see findSubscribeAnchor below); none of the older selectors match it, so
  // this silently fell back to the raw URL path as the "name" — a group got
  // created/labelled "@Top5s" instead of "Top5s". Try the current markup
  // first, old selectors as fallback for accounts still on legacy markup.
  function currentChannelName() {
    var el = document.querySelector(YD ? YD.CHANNEL_PAGE_HEADER_SEL : '#channel-header #text');
    return el ? el.textContent.trim() : location.pathname.replace(/^\//, '');
  }
  // Finds the REAL, currently-rendered subscribe button, not just a node that
  // matches one of the historical selectors below. Reported live as the
  // "+Group" button permanently vanishing/the page reading as "refreshed":
  // YouTube's SPA navigation leaves old pages' skeleton/placeholder DOM
  // around (never fully torn down between route changes), so a bare
  // querySelector('#subscribe-button, ytd-subscribe-button-renderer') could
  // match a hidden leftover from the PREVIOUS /watch page instead of the
  // current channel page's real button — confirmed live: both matches had
  // closest('ytd-watch-flexy') true and a 0×0 rect, while the actual visible
  // button on the same page was a <yt-subscribe-button-view-model> (YouTube's
  // newer web-component markup for this control, not covered by the old
  // selectors at all). Every candidate is checked for a real rendered size;
  // the old selectors are kept as a fallback for accounts/AB-tests still on
  // the legacy markup, but only if they're actually visible.
  function findSubscribeAnchor() {
    var candidates = document.querySelectorAll(YD ? YD.SUBSCRIBE_BUTTON_SEL : '#subscribe-button');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  function ensureChannelButton() {
    var p = location.pathname;
    var isChannel = p.startsWith('/@') || p.startsWith('/channel/') || p.startsWith('/c/') || p.startsWith('/user/');
    if (!isChannel) return;
    var existing = document.getElementById('un-sub-addbtn');
    if (existing) {
      var r = existing.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return;
      existing.remove();
    }
    var anchor = findSubscribeAnchor();
    if (!anchor) return;
    var btn = document.createElement('button');
    btn.id = 'un-sub-addbtn';
    btn.className = 'un-sub-addbtn';
    btn.textContent = '＋ Group';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleGroupMenu(btn);
    });
    anchor.parentElement.insertBefore(btn, anchor.nextSibling);
  }

  function ensureBlockChannelButton() {
    var p = location.pathname;
    var isChannel = p.startsWith('/@') || p.startsWith('/channel/') || p.startsWith('/c/') || p.startsWith('/user/');
    if (!isChannel) return;
    var existingBlock = document.getElementById('un-sub-blockbtn');
    if (existingBlock) {
      var br = existingBlock.getBoundingClientRect();
      if (br.width > 0 && br.height > 0) return;
      existingBlock.remove();
    }
    var anchor = findSubscribeAnchor();
    if (!anchor || !anchor.parentElement) return;
    var parent = anchor.parentElement;
    var btn = document.createElement('button');
    btn.id = 'un-sub-blockbtn';
    btn.className = 'un-sub-addbtn un-sub-blockbtn';
    btn.textContent = '⊘ Block channel';
    btn.title = 'Block this channel — bad AI narration/voices you do not want recommended again';
    var name = currentChannelName();
    chrome.storage.sync.get({ channels: [] }, function (d) {
      var channels = d.channels || [];
      if (name && channels.some(function (c) { return String(c).toLowerCase() === name.toLowerCase(); })) {
        btn.textContent = '⊘ Blocked';
        btn.disabled = true;
      }
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var channel = currentChannelName();
      if (!channel) return;
      chrome.storage.sync.get({ channels: [] }, function (d) {
        var channels = d.channels || [];
        var low = channel.toLowerCase();
        if (!channels.some(function (x) { return String(x).toLowerCase() === low; })) channels.push(channel);
        chrome.storage.sync.set({ channels: channels }, function () {
          // Only claim "Blocked" when the write actually landed — the block list
          // can outgrow chrome.storage.sync's 8 KB per-item quota.
          if (chrome.runtime.lastError) {
            btn.textContent = '⊘ Not saved';
            btn.title = 'Block list could not be saved — it may have hit the browser sync size limit.';
            setTimeout(function () {
              btn.textContent = '⊘ Block channel';
              btn.title = 'Block this channel — bad AI narration/voices you do not want recommended again';
            }, 4000);
            return;
          }
          btn.textContent = '⊘ Blocked';
          btn.disabled = true;
        });
      });
    });
    parent.appendChild(btn);
  }
  var groupMenuDocClick = null;
  var groupMenuKey = null;
  function closeGroupMenu() {
    var m = document.getElementById('un-sub-menu');
    if (m) m.remove();
    // Clear whichever control is currently claiming the menu is open. Two
    // elements carry .un-sub-filter-chip (the masthead banner and the home
    // chip), so a querySelector would pick one by document order and could
    // leave the other stuck reporting expanded.
    document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')
      .forEach(function (el) { el.setAttribute('aria-expanded', 'false'); });
    if (groupMenuDocClick) {
      document.removeEventListener('click', groupMenuDocClick, true);
      groupMenuDocClick = null;
    }
    if (groupMenuEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(groupMenuEsc);
      groupMenuEsc = null;
    }
    if (groupMenuKey) {
      document.removeEventListener('keydown', groupMenuKey, true);
      groupMenuKey = null;
    }
  }
  // Renders the checkbox rows for every existing group into `menu`, checked
  // state reflecting whether the current channel is already in each one.
  // Pulled out of toggleGroupMenu so "create a new group" can re-render just
  // this part after adding one, instead of tearing down and rebuilding the
  // whole popover (which would also lose focus on the new-group input).
  function renderGroupRows(menu, key, name) {
    var rowsWrap = menu.querySelector('.un-sub-menu-rows');
    if (!rowsWrap) {
      rowsWrap = document.createElement('div');
      rowsWrap.className = 'un-sub-menu-rows';
      menu.insertBefore(rowsWrap, menu.firstChild);
    }
    rowsWrap.textContent = '';
    var groupNames = Object.keys(store.groups || {});
    if (!groupNames.length) {
      var hint = document.createElement('div');
      hint.className = 'un-sub-menu-hint';
      hint.textContent = 'No groups yet — create one below.';
      rowsWrap.appendChild(hint);
    }
    groupNames.forEach(function (gname) {
      var row = document.createElement('label');
      row.className = 'un-sub-menu-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      var forms = SG.keyForms(store, key);
      cb.checked = (store.groups[gname] || []).some(function (k) {
        return forms.indexOf(k) !== -1;
      });
      cb.addEventListener('change', function () {
        if (cb.checked) SG.addToGroup(store, gname, key, name);
        else
          SG.keyForms(store, key).forEach(function (k) {
            SG.removeFromGroup(store, gname, k);
          });
        saveStore();
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + gname));
      rowsWrap.appendChild(row);
    });
  }

  function toggleGroupMenu(btn) {
    if (document.getElementById('un-sub-menu')) {
      closeGroupMenu();
      return;
    }
    var key = currentChannelKey();
    var name = currentChannelName();
    var menu = document.createElement('div');
    menu.id = 'un-sub-menu';
    if (btn) btn.setAttribute('aria-expanded', 'true');
    renderGroupRows(menu, key, name);

    // Inline "create a new group" — this used to be a dead end ("Create a
    // group in the dashboard first."/no way to add one when groups already
    // existed either), forcing a trip out to the dashboard just to make a
    // group. Creating one here immediately checks the current channel into
    // it, since that's the only reason anyone opens this popover.
    var newRow = document.createElement('div');
    newRow.className = 'un-sub-menu-newgroup';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'New group name…';
    input.maxLength = 60;
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+ Create';
    addBtn.disabled = true;
    input.addEventListener('input', function () {
      addBtn.disabled = !input.value.trim();
    });
    var createGroupFromInput = function () {
      var gname = input.value.trim();
      if (!gname) return;
      if (store.groups && store.groups[gname]) {
        // Already exists — just check the current channel into it instead of
        // silently no-oping, since a duplicate name is a plausible mis-type
        // of an existing group the user meant to add to.
        SG.addToGroup(store, gname, key, name);
      } else {
        SG.createGroup(store, gname);
        SG.addToGroup(store, gname, key, name);
      }
      saveStore();
      input.value = '';
      addBtn.disabled = true;
      renderGroupRows(menu, key, name);
    };
    addBtn.addEventListener('click', createGroupFromInput);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        createGroupFromInput();
      }
    });
    newRow.append(input, addBtn);
    menu.appendChild(newRow);

    btn.parentElement.appendChild(menu);
    setTimeout(function () {
      input.focus();
    }, 0);

    groupMenuDocClick = function (e) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeGroupMenu();
    };
    // Escape goes through the shared LIFO stack so only the topmost overlay
    // closes; a raw document listener here also closed whatever panel was
    // open behind this menu.
    groupMenuEsc = window.UNSYNTH && window.UNSYNTH.pushPanel
      ? window.UNSYNTH.pushPanel(closeGroupMenu)
      : null;
    groupMenuKey = groupMenuEsc ? null : function (e) {
      if (e.key === 'Escape') closeGroupMenu();
    };
    setTimeout(function () {
      document.addEventListener('click', groupMenuDocClick, true);
      if (groupMenuKey) document.addEventListener('keydown', groupMenuKey, true);
    }, 0);
  }

  // ===== home-page group surfacing (filter + shelf) =====
  function onHome() {
    return location.pathname === '/' || location.pathname === '';
  }
  function homeTiles(cb) {
    var nodes = document.querySelectorAll(YD ? YD.SUB_GRID_ITEM_SEL : 'a[href*="/watch"]');
    if (!nodes.length && YD && YD.FEED_TILES) {
      nodes = document.querySelectorAll(YD.FEED_TILES[0]);
    }
    nodes.forEach(cb);
  }
  // Only write textContent when it actually changes. The core MutationObserver
  // watches childList+subtree, and setting textContent replaces text nodes (a
  // childList mutation) — doing it every scan would retrigger scan → refreshHome
  // forever (the "constant refresh" loop). Guarding makes refreshHome a no-op at
  // steady state so the observer goes quiet.
  function setText(elx, txt) {
    if (elx && elx.textContent !== txt) elx.textContent = txt;
  }
  function videoIdFromTile(tile) {
    var a = tile.querySelector('a#thumbnail[href*="/watch"], a#video-title-link[href*="/watch"], a[href*="/watch"]');
    if (!a) return null;
    var m = (a.getAttribute('href') || '').match(/[?&]v=([^&]+)/);
    return m ? m[1] : null;
  }
  function titleFromTile(tile) {
    var t = tile.querySelector(YD ? YD.TITLE_SEL : '#video-title');
    return t ? t.textContent.trim() : '';
  }
  function metaFromTile(tile) {
    var m = tile.querySelector(YD ? YD.TILE_META_SEL : '#metadata-line');
    return m ? m.textContent.trim().replace(/\s+/g, ' ') : '';
  }

  function clearHomeFilter() {
    document.body.classList.remove('un-home-filter-on');
    document.querySelectorAll('[data-unhome]').forEach(function (el) {
      delete el.dataset.unhome;
      el.classList.remove('un-sub-hidden');
    });
  }
  function applyHomeFilter() {
    if (defaultFeedOn()) {
      if (!homePeekCleared) {
        clearHomeFilter();
        homePeekCleared = true;
      }
      return;
    }
    homePeekCleared = false;
    var filtering = homeGroup && (homeMode === 'filter' || homeMode === 'both');
    if (!filtering) {
      clearHomeFilter();
      return;
    }
    document.body.classList.add('un-home-filter-on');
    var nameSet = SG.groupNameSet ? SG.groupNameSet(store, homeGroup) : null;
    homeTiles(function (tile) {
      tile.dataset.unhome = '1';
      if (tileInGroup(homeGroup, tile, nameSet)) tile.classList.remove('un-sub-hidden');
      else tile.classList.add('un-sub-hidden');
    });
  }

  function buildShelfCard(vid, title, key, meta) {
    var a = document.createElement('a');
    a.className = 'un-home-card';
    a.href = '/watch?v=' + vid;
    var thumb = document.createElement('div');
    thumb.className = 'un-home-card-thumb';
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.src = 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg';
    img.alt = '';
    thumb.appendChild(img);
    var body = document.createElement('div');
    body.className = 'un-home-card-body';
    var t = document.createElement('div');
    t.className = 'un-home-card-title';
    t.textContent = title || '(untitled)';
    var c = document.createElement('div');
    c.className = 'un-home-card-sub';
    c.textContent = SG.channelDisplayLabel(store, key) || '';
    body.appendChild(t);
    body.appendChild(c);
    if (meta) {
      var mEl = document.createElement('div');
      mEl.className = 'un-home-card-meta';
      mEl.textContent = meta;
      body.appendChild(mEl);
    }
    a.appendChild(thumb);
    a.appendChild(body);
    return a;
  }
  function removeHomeShelf() {
    var s = document.getElementById('un-home-shelf');
    if (s) s.remove();
  }
  function ensureHomeShelf() {
    var wantShelf = homeGroup && (homeMode === 'shelf' || homeMode === 'both');
    if (!wantShelf) {
      removeHomeShelf();
      return;
    }
    // Insert as a sibling ABOVE the grid renderer, not inside its #contents —
    // YouTube's Polymer reclaims foreign children of #contents, which would make
    // us re-insert every scan (an insert/remove refresh loop).
    var gridRenderer = document.querySelector(YD ? YD.RICH_GRID_RENDERER_SEL : '#contents');
    if (!gridRenderer || !gridRenderer.parentElement) return;
    var shelf = document.getElementById('un-home-shelf');
    if (shelf && shelf._group !== homeGroup) {
      // group changed — rebuild from scratch so old-group cards don't linger
      shelf.remove();
      shelf = null;
    }
    if (!shelf) {
      shelf = document.createElement('section');
      shelf.id = 'un-home-shelf';
      shelf.className = 'un-home-shelf';
      shelf._seen = new Set();
      shelf._group = homeGroup;

      var head = document.createElement('div');
      head.className = 'un-home-shelf-head';

      var headLeft = document.createElement('div');
      headLeft.className = 'un-home-shelf-head-left';

      var ico = document.createElement('span');
      ico.className = 'un-home-shelf-ico';
      ico.textContent = '📁';
      headLeft.appendChild(ico);

      var label = document.createElement('span');
      label.className = 'un-home-shelf-label';
      headLeft.appendChild(label);

      var count = document.createElement('span');
      count.className = 'un-home-shelf-count';
      headLeft.appendChild(count);

      head.appendChild(headLeft);

      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'un-home-shelf-more';
      more.addEventListener('click', function () {
        loadMoreHome(more);
      });
      head.appendChild(more);

      var strip = document.createElement('div');
      strip.className = 'un-home-shelf-strip';

      shelf.appendChild(head);
      shelf.appendChild(strip);
      gridRenderer.parentElement.insertBefore(shelf, gridRenderer);
    }
    setText(shelf.querySelector('.un-home-shelf-label'), 'From ' + homeGroup);
    var moreBtn = shelf.querySelector('.un-home-shelf-more');
    if (moreBtn && !loadMoreHome._busy) setText(moreBtn, 'Load more');
    var strip = shelf.querySelector('.un-home-shelf-strip');
    var shelfNameSet = SG.groupNameSet ? SG.groupNameSet(store, homeGroup) : null;
    homeTiles(function (tile) {
      if (!tileInGroup(homeGroup, tile, shelfNameSet)) return;
      var vid = videoIdFromTile(tile);
      if (!vid || shelf._seen.has(vid)) return;
      shelf._seen.add(vid);
      strip.appendChild(buildShelfCard(vid, titleFromTile(tile), tileChannelKey(tile), metaFromTile(tile)));
    });
    var n = shelf._seen.size;
    setText(shelf.querySelector('.un-home-shelf-count'), n ? n + ' loaded' : '');
    var hint = shelf.querySelector('.un-home-shelf-empty');
    if (!n) {
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'un-home-shelf-empty';
        hint.textContent = 'Scroll your home feed to populate — nothing from “' + homeGroup + '” has loaded yet.';
        shelf.appendChild(hint);
      }
    } else if (hint) {
      hint.remove();
    }
  }

  function homeWait(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  // Actively pull more of the home feed so the shelf fills up, instead of
  // waiting for the user to scroll. Auto-scrolls (bounded), re-scans, then
  // restores the original scroll position — mirrors the playlist select-all.
  async function loadMoreHome(btn) {
    if (loadMoreHome._busy) return;
    loadMoreHome._busy = true;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    var y0 = window.scrollY;
    var lastN = -1;
    var stable = 0;
    for (var i = 0; i < 12; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await homeWait(450);
      applyHomeFilter();
      ensureHomeShelf();
      var shelf = document.getElementById('un-home-shelf');
      var n = shelf && shelf._seen ? shelf._seen.size : 0;
      if (n === lastN) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
        lastN = n;
      }
    }
    window.scrollTo(0, y0);
    loadMoreHome._busy = false;
    btn.disabled = false;
    btn.textContent = 'Load more from ' + homeGroup;
  }

  function ensureHomeChip() {
    // Always available on the home page so the feature is discoverable even when
    // it's currently off (the menu is how you turn it on and pick a group).
    if (!onHome()) {
      var ex = document.getElementById('un-home-chip');
      if (ex) ex.remove();
      return;
    }
    var host = null;
    if (window.UNMastheadSlot && window.UNMastheadSlot.ensureMastheadStructure) {
      var slot = window.UNMastheadSlot.ensureMastheadStructure();
      host = slot && slot.extra;
    }
    if (!host) host = document.getElementById('un-synth-masthead-extra');
    if (!host) return;
    var chip = document.getElementById('un-home-chip');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'un-home-chip';
      chip.type = 'button';
      chip.className = 'un-sub-filter-chip';
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleHomeMenu(chip);
      });
      host.insertBefore(chip, host.firstChild);
    }
    // Rebuild the chip's label only when it (or the peek state) changes —
    // re-running every scan would churn child text nodes and retrigger the
    // MutationObserver (refresh loop).
    var labelText = (homeMode === 'off' || !homeGroup ? 'all' : homeGroup) + (defaultFeedOn() ? ' (preview)' : '');
    var state = labelText + '|' + homeMode;
    if (chip.dataset.state === state) return;
    chip.dataset.state = state;
    chip.textContent = '';
    chip.appendChild(document.createTextNode('Home: '));
    var bold = document.createElement('b');
    bold.textContent = labelText;
    chip.appendChild(bold);
    chip.appendChild(document.createTextNode(' ▾'));
  }
  var homeMenuDocClick = null;
  var homeMenuKey = null;
  function closeHomeMenu() {
    var m = document.getElementById('un-home-menu');
    if (m) m.remove();
    if (homeMenuDocClick) {
      document.removeEventListener('click', homeMenuDocClick, true);
      homeMenuDocClick = null;
    }
    if (homeMenuEsc && window.UNSYNTH && window.UNSYNTH.popPanel) {
      window.UNSYNTH.popPanel(homeMenuEsc);
      homeMenuEsc = null;
    }
    if (homeMenuKey) {
      document.removeEventListener('keydown', homeMenuKey, true);
      homeMenuKey = null;
    }
  }
  function toggleHomeMenu(chip) {
    if (document.getElementById('un-home-menu')) {
      closeHomeMenu();
      return;
    }
    var menu = document.createElement('div');
    menu.id = 'un-home-menu';
    menu.className = 'un-home-menu';

    var groupHead = document.createElement('div');
    groupHead.className = 'un-home-menu-head';
    groupHead.textContent = 'Group';
    menu.appendChild(groupHead);
    var groupNames = Object.keys(store.groups || {});
    if (!groupNames.length) {
      var hint = document.createElement('div');
      hint.className = 'un-sub-menu-hint';
      hint.textContent = 'Create a group first (dashboard or a channel page).';
      menu.appendChild(hint);
    }
    groupNames.forEach(function (gname) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'un-sub-guide-item' + (gname === homeGroup ? ' on' : '');
      row.textContent = gname;
      row.addEventListener('click', function () {
        setHome(homeMode === 'off' ? 'filter' : homeMode, gname);
        closeHomeMenu();
        refreshHome();
        ensureHomeChip();
      });
      menu.appendChild(row);
    });

    var modeHead = document.createElement('div');
    modeHead.className = 'un-home-menu-head';
    modeHead.textContent = 'Show as';
    menu.appendChild(modeHead);
    [
      ['filter', 'Filter home to this group'],
      ['shelf', 'Pin a shelf at the top'],
      ['both', 'Shelf + filter'],
      ['off', 'Off']
    ].forEach(function (pair) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'un-sub-guide-item' + (pair[0] === homeMode ? ' on' : '');
      row.textContent = pair[1];
      row.addEventListener('click', function () {
        setHome(pair[0]);
        closeHomeMenu();
        refreshHome();
        ensureHomeChip();
      });
      menu.appendChild(row);
    });

    // Position fixed under the chip so placement doesn't depend on YouTube's
    // masthead ancestors being positioned. Right-align to the chip edge.
    document.body.appendChild(menu);
    menu.style.position = 'fixed';
    var r = chip.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    var w = menu.offsetWidth || 230;
    menu.style.left = Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))) + 'px';
    menu.style.right = 'auto';

    homeMenuDocClick = function (e) {
    // Not a user dismissal -- see queue-advance.js docClickHandler.
    if (e && e.isTrusted === false) return;
      if (!menu.contains(e.target) && e.target !== chip && !chip.contains(e.target)) closeHomeMenu();
    };
    // Escape goes through the shared LIFO stack so only the topmost overlay
    // closes; a raw document listener here also closed whatever panel was
    // open behind this menu.
    homeMenuEsc = window.UNSYNTH && window.UNSYNTH.pushPanel
      ? window.UNSYNTH.pushPanel(closeHomeMenu)
      : null;
    homeMenuKey = homeMenuEsc ? null : function (e) {
      if (e.key === 'Escape') closeHomeMenu();
    };
    setTimeout(function () {
      document.addEventListener('click', homeMenuDocClick, true);
      if (homeMenuKey) document.addEventListener('keydown', homeMenuKey, true);
    }, 0);
  }

  function clearHome() {
    clearHomeFilter();
    removeHomeShelf();
    closeHomeMenu();
    var chip = document.getElementById('un-home-chip');
    if (chip) chip.remove();
  }
  function refreshHome() {
    if (!onHome()) {
      clearHome();
      return;
    }
    applyHomeFilter();
    ensureHomeShelf();
    ensureHomeChip();
  }

  function refreshAll() {
    if (core && !core.isModuleEnabled(mod)) return;
    ensureChannelButton();
    ensureBlockChannelButton();
    applyFilter();
    ensureFilterBanner(); // group switcher shows even when "All" is active
    scheduleFilterRetry();
    scrapeFeedThumbs();
    refreshHome();
  }

  var onNavStart = null;
  var onFilterApply = null;
  var onStorageChanged = null;
  var onDefaultFeedChanged = null;

  var mod = {
    id: 'subManager',
    moduleKey: 'subManager',
    init: function (c) {
      core = c;
      load(refreshAll);
      // Drop the default-hide classes the instant navigation starts so the
      // destination page never inherits a stale "hide unclassified tiles" rule.
      onNavStart = function () {
        document.body.classList.remove('un-sub-filter-on', 'un-home-filter-on');
      };
      document.addEventListener('yt-navigate-start', onNavStart);
      onFilterApply = function () {
        // applyFilter is idempotent (per-tile show/hide). Do NOT clearFilter
        // first — unhiding everything then re-hiding is what flashes the feed.
        load(refreshAll);
      };
      document.addEventListener('unsynth-sub-filter-apply', onFilterApply);
      // "YT Default" peek toggled in the masthead — reset both clear flags and
      // re-run: applyFilter/applyHomeFilter reveal (clear, once) when on, or
      // re-hide when off. refreshAll covers both subs/history and home in one pass.
      onDefaultFeedChanged = function () {
        filterPeekCleared = false;
        homePeekCleared = false;
        refreshAll();
      };
      document.addEventListener('unsynth-default-feed-changed', onDefaultFeedChanged);
      onStorageChanged = function (changes, area) {
        if (area !== 'local') return;
        if (changes.subStore || changes.subActive || changes.subHomeMode || changes.subHomeGroup) {
          // Re-assert filters without a full clear — applyFilter/refreshHome only
          // toggle the tiles that actually changed, so there's no flash even if
          // subStore is written repeatedly (e.g. background name enrichment).
          load(refreshAll);
        }
      };
      chrome.storage.onChanged.addListener(onStorageChanged);
    },
    scan: function () {
      // Channel-page buttons can appear anywhere; feed filters only on home/subs.
      const p = location.pathname;
      const onWatch = p === '/watch' || p.indexOf('/shorts/') === 0;
      if (onWatch) {
        ensureChannelButton();
        ensureBlockChannelButton();
        return;
      }
      refreshAll();
    },
    onNavigate: function () {
      // Close any open popover first. These attach capture-phase document
      // listeners that only their own close path removes, so navigating away
      // with one open orphaned the DOM and leaked a listener pair per
      // navigation for the life of the tab. teardown() already did this;
      // SPA navigation did not.
      closeGroupMenu();
      closeGroupSwitcher();
      closeHomeMenu();
      clearFilter();
      refreshAll();
    },
    // Module switched off: un-hide filtered tiles and remove injected buttons/menus.
    teardown: function () {
      if (onNavStart) {
        document.removeEventListener('yt-navigate-start', onNavStart);
        onNavStart = null;
      }
      if (onFilterApply) {
        document.removeEventListener('unsynth-sub-filter-apply', onFilterApply);
        onFilterApply = null;
      }
      if (onStorageChanged) {
        chrome.storage.onChanged.removeListener(onStorageChanged);
        onStorageChanged = null;
      }
      if (onDefaultFeedChanged) {
        document.removeEventListener('unsynth-default-feed-changed', onDefaultFeedChanged);
        onDefaultFeedChanged = null;
      }
      if (filterRetryTimer) {
        clearTimeout(filterRetryTimer);
        filterRetryTimer = null;
      }
      filterPeekCleared = false;
      homePeekCleared = false;
      clearFilter();
      clearHome();
      closeGroupMenu();
      closeGroupSwitcher();
      ['un-sub-addbtn', 'un-sub-blockbtn', 'un-sub-filter-banner'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.remove();
      });
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
