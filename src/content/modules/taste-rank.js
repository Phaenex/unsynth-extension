/**
 * Taste ranking — scores the watch-page suggestion rail against what you
 * actually watch, badges the strong matches, and can float them to the top.
 *
 * The scoring itself lives in src/shared/taste-profile.js (pure, unit-tested).
 * This module is only the DOM layer: read tiles, ask for scores, mark up the
 * results.
 *
 * WHY IT REORDERS RATHER THAN FILTERS
 * Hiding suggestions YouTube made would shrink an already-short rail and could
 * bury something genuinely wanted. Reordering keeps every option available
 * while putting the likely-relevant ones where they'll be seen, and the badge
 * explains WHY each one was promoted so the ranking is auditable instead of
 * another opaque algorithm.
 *
 * DOM SAFETY
 * Tiles are moved within their existing parent via insertBefore on the SAME
 * container YouTube already put them in — no reparenting into a wrapper of our
 * own. Reparenting YouTube-managed nodes is exactly the class of change that
 * broke the scroll miniplayer (see docs/LESSONS.md); the rail is Polymer-
 * managed and will happily reclaim foreign structure.
 */
(function () {
  'use strict';

  var core = null;
  var YD = window.UNYtDom;
  var TP = window.UNTasteProfile;
  var profile = null;
  var profileLoaded = false;
  var storageListener = null;
  var reorderedFor = ''; // video id whose rail we've already ordered

  function prefs() {
    var d = (core && core.settings && core.settings.tasteRank) || {};
    return {
      enabled: d.enabled !== false,
      badges: d.badges !== false,
      reorder: d.reorder !== false,
      minScore: typeof d.minScore === 'number' ? d.minScore : 35
    };
  }

  function isWatch() {
    return (window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch');
  }

  function currentVideoId() {
    var m = location.search.match(/[?&]v=([\w-]{11})/);
    // Channel live URLs carry no ?v= (2026-09-23).
    return m ? m[1] : (window.UNYtDom && window.UNYtDom.liveChannelVideoId ? window.UNYtDom.liveChannelVideoId() : '');
  }

  function loadProfile(cb) {
    if (!TP) return;
    try {
      chrome.storage.local.get(TP.STORAGE_KEY, function (d) {
        if (chrome.runtime.lastError) return;
        profile = TP.normalize(d && d[TP.STORAGE_KEY]);
        profileLoaded = true;
        if (cb) cb();
      });
    } catch (e) {
      /* context gone — nothing to rank against */
    }
  }

  /** The rail's tiles, in document order, with the data needed to score them. */
  function railTiles() {
    var root = YD && YD.watchRelatedRoot ? YD.watchRelatedRoot() : null;
    if (!root) return [];
    var nodes = root.querySelectorAll('ytd-compact-video-renderer, yt-lockup-view-model');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var tile = nodes[i];
      var title = YD.tileTitle ? YD.tileTitle(tile) : '';
      if (!title) continue;
      out.push({
        el: tile,
        title: title,
        channelKey: YD.tileChannelKey ? YD.tileChannelKey(tile) : '',
        channelName: YD.tileChannel ? YD.tileChannel(tile) : ''
      });
    }
    return out;
  }

  function removeBadge(tile) {
    var b = tile.querySelector('.un-taste-badge');
    if (b) b.remove();
    delete tile.dataset.unTaste;
  }

  function badgeTile(tile, result) {
    var want = String(result.score);
    if (tile.dataset.unTaste === want) {
      // Score unchanged, so the badge itself is correct — but playlist-bulk
      // decorates tiles on its own schedule and the checkbox may have arrived
      // since the last paint. Returning early without this left the badge at
      // left:6px underneath a checkbox that appeared afterwards.
      syncSelectOffset(tile, tile.querySelector('.un-taste-badge'));
      return; // already correct — don't churn the DOM
    }
    removeBadge(tile);
    tile.dataset.unTaste = want;
    var badge = document.createElement('span');
    badge.className = 'un-taste-badge lvl-' + result.level;
    badge.textContent = '★ ' + result.score + '%';
    badge.title = 'Unsynth match: ' + result.reasons.join('; ');
    badge.setAttribute('aria-label', 'Match for your taste: ' + result.score + ' percent. ' + result.reasons.join('. '));
    // Anchor to the thumbnail so it sits over the image. Which corner is
    // decided in core.css (bottom-left) — the other three are taken by the AI
    // badge, the quick-action buttons and YouTube's duration chip.
    var thumb =
      tile.querySelector('ytd-thumbnail, a#thumbnail, .yt-lockup-view-model-wiz__content-image, yt-thumbnail-view-model') ||
      tile;
    try {
      if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';
    } catch (e) {
      /* detached */
    }
    thumb.appendChild(badge);
    syncSelectOffset(tile, badge);
  }

  /**
   * The bulk-select checkbox claims the same bottom-left corner at a higher
   * z-index, so without this it renders on top of the badge and hides all but
   * its tail — "★ 65%" read as a stray "5%". Measured: the badge spans 48px and
   * the 28px checkbox covered the first 28 of them.
   *
   * It has to be a class rather than a CSS ancestor rule: the badge hangs off
   * ytd-thumbnail while the checkbox lives in a sibling .un-plm-overlay, so no
   * selector joins the two. Re-checked on every badge paint because
   * playlist-bulk decorates tiles independently and may arrive after this.
   */
  function syncSelectOffset(tile, badge) {
    if (!tile || !badge) return;
    badge.classList.toggle('has-select-btn', !!tile.querySelector('.un-plm-selectbtn'));
    // The three head-strip segments (eye, this badge, checkbox) are rendered by
    // three different modules into three different parents, so they cannot be
    // laid out by one flexbox. The checkbox needs to start where this badge
    // ends, and this badge's width depends on its own text ("★ 7%" vs
    // "★ 100%"). Publish the measured width so playlist-bulk.css can offset by
    // it. Measured after paint, because the badge sizes to its content.
    // Set on the TILE, not the badge's own parent: the badge hangs off
    // ytd-thumbnail while the checkbox lives in a sibling .un-plm-overlay, so
    // the tile is the nearest element both can inherit from.
    const w = Math.round(badge.getBoundingClientRect().width);
    if (w > 0) tile.style.setProperty('--un-taste-w', w + 'px');
  }

  function apply() {
    if (!TP || !profileLoaded) return;
    var p = prefs();
    if (!p.enabled || !isWatch()) {
      clearAll();
      return;
    }
    var tiles = railTiles();
    if (!tiles.length) return;

    var ranked = TP.rankCandidates(profile, tiles, {});
    var vid = currentVideoId();

    ranked.forEach(function (r) {
      var tile = r.candidate.el;
      if (!tile || !tile.isConnected) return;
      if (p.badges && r.score >= p.minScore) badgeTile(tile, r);
      else removeBadge(tile);
    });

    // Reorder once per video. Doing it on every scan would fight YouTube's own
    // continuous re-render and make the rail visibly jump while being read.
    if (p.reorder && vid && reorderedFor !== vid) {
      var strong = ranked.filter(function (r) {
        return r.score >= p.minScore && r.candidate.el && r.candidate.el.isConnected;
      });
      // Only bother when reordering would actually change something AND there
      // is a real signal — promoting 1 of 20 tiles is churn, not value.
      if (strong.length >= 2) {
        var parent = strong[0].candidate.el.parentElement;
        var sameParent = strong.every(function (r) {
          return r.candidate.el.parentElement === parent;
        });
        if (parent && sameParent) {
          // Walk the ranked list from WORST to BEST, inserting each at the
          // very top. The best one is inserted last and therefore ends up
          // first — a single pass that leaves the final order descending.
          // (Iterating best-first would reverse them.) Every node stays inside
          // the container YouTube already owns; no wrapper is introduced.
          for (var i = strong.length - 1; i >= 0; i--) {
            parent.insertBefore(strong[i].candidate.el, parent.firstElementChild);
          }
          reorderedFor = vid;
        }
      } else {
        reorderedFor = vid; // nothing worth promoting; don't retry all page
      }
    }
  }

  function clearAll() {
    document.querySelectorAll('[data-un-taste]').forEach(function (t) {
      removeBadge(t);
    });
  }

  var mod = {
    id: 'tasteRank',
    moduleKey: 'tasteRank',
    init: function (c) {
      core = c;
      TP = window.UNTasteProfile;
      YD = window.UNYtDom;
      loadProfile(apply);
      // The profile changes as you watch; re-rank when it does so the rail
      // reflects current taste rather than whatever it was at page load.
      storageListener = function (changes, area) {
        if (area !== 'local' || !TP || !changes[TP.STORAGE_KEY]) return;
        profile = TP.normalize(changes[TP.STORAGE_KEY].newValue);
        profileLoaded = true;
        apply();
      };
      try {
        chrome.storage.onChanged.addListener(storageListener);
      } catch (e) {
        /* ignore */
      }
    },
    scan: function () {
      apply();
    },
    onNavigate: function () {
      reorderedFor = '';
      clearAll();
      loadProfile(apply);
    },
    onSettings: function (s) {
      core.settings = s;
      apply();
    },
    teardown: function () {
      if (storageListener) {
        try {
          chrome.storage.onChanged.removeListener(storageListener);
        } catch (e) {
          /* ignore */
        }
        storageListener = null;
      }
      clearAll();
      reorderedFor = '';
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
