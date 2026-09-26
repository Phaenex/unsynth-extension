/**
 * Live Now — pins any currently-loaded home-feed tile that is a live
 * broadcast into a shelf at the top of the home page, so live streams from
 * channels you follow don't get lost in the scroll. Pure DOM scrape (same
 * "no API on the page itself" approach as sub-manager.js's home shelf) —
 * only sees tiles YouTube has already rendered/loaded, and grows as you
 * scroll because scan() re-runs on every DOM mutation.
 */
(function () {
  'use strict';

  var YD = window.UNYtDom;
  var core = null;

  // Every route that renders the home feed, not just the bare "/". YouTube
  // reaches the same grid via several paths — clicking the logo, the Home
  // guide entry, /feed/recommended, a trailing-slash variant, or the
  // ?bp=/persist_gl style query links — and the shelf must appear on all of
  // them ("needs to be there whenever I go to the home page no matter how").
  // Matching only "/" meant arriving any other way silently produced no bar.
  function onHome() {
    var p = location.pathname || '';
    if (p === '' || p === '/' || p === '/index' || p === '/home') return true;
    if (p.indexOf('/feed/recommended') === 0) return true;
    // Trailing-slash / duplicated-slash variants of the same route.
    if (/^\/+$/.test(p)) return true;
    return false;
  }

  // The subscriptions feed (and the extension's own sub-group views, which
  // render inside that same route) is the other place a followed channel going
  // live must surface. It was never included, so "the live bar isn't there" was
  // simply always true on /feed/subscriptions — the module returned early
  // before ever scraping a tile.
  function onSubs() {
    return (location.pathname || '').indexOf('/feed/subscriptions') === 0;
  }

  // Every surface the shelf is allowed to appear on.
  function onSupportedFeed() {
    return onHome() || onSubs();
  }

  // "YT Default" masthead peek — same flag ai-filter.js/sub-manager.js read
  // to bypass their own home-page customizations while previewing stock
  // YouTube. A live shelf is exactly that kind of customization, so it hides
  // while peeking, consistent with sub-manager.js's home shelf.
  function defaultFeedOn() {
    return document.documentElement.classList.contains('un-default-feed');
  }

  // Every tile shape on the page, in one pass.
  //
  // This used to try the home grid first and only fall back when it found
  // nothing, which meant a page rendering BOTH shapes (the subscriptions feed
  // mixes rich items and lockups) was scraped only for the first kind — live
  // streams in the other kind were invisible. It also scoped to the grid, so
  // a live stream in any shelf outside it was missed.
  //
  // Deliberately queries the whole document and ignores whether a tile is
  // currently VISIBLE: sub-group filtering hides non-matching tiles with
  // `.un-sub-hidden { display:none }` rather than removing them, so scraping
  // the document still sees every live channel regardless of which group is
  // selected. That is the requirement — "show everyone I follow who is live no
  // matter what sub group I have going on".
  var TILE_SEL = YD && YD.feedTileSelector ? YD.feedTileSelector() : 'none';

  var LIVE_MARK_SEL = (YD && YD.LIVE_MARK_SEL) || 'none';

  function homeTiles(cb) {
    var marks = document.querySelectorAll(LIVE_MARK_SEL);
    if (!marks.length) return;
    var seen = [];
    marks.forEach(function (mark) {
      var tile = mark.closest ? mark.closest(TILE_SEL) : null;
      if (!tile || seen.indexOf(tile) !== -1) return;
      seen.push(tile);
      cb(tile);
    });
  }

  // Where the shelf gets inserted. The home grid is the preferred anchor, but
  // it doesn't exist on /feed/subscriptions and isn't always present on a
  // slow/cold home load — returning null there meant the shelf silently never
  // appeared. Falling back through the feed containers YouTube actually uses
  // makes placement work on both routes instead of only the lucky one.
  function shelfAnchor() {
    var sel = (YD && YD.LIVE_SHELF_ANCHOR_SEL) ? YD.LIVE_SHELF_ANCHOR_SEL.split(', ') : ['none'];
    for (var i = 0; i < sel.length; i++) {
      var node = document.querySelector(sel[i]);
      if (node && node.parentElement) return node;
    }
    return null;
  }

  function setText(el, txt) {
    if (el && el.textContent !== txt) el.textContent = txt;
  }

  function buildLiveCard(vid, title, channel) {
    var a = document.createElement('a');
    a.className = 'un-live-card';
    a.href = '/watch?v=' + vid;
    var thumb = document.createElement('div');
    thumb.className = 'un-live-card-thumb';
    var img = document.createElement('img');
    img.loading = 'lazy';
    img.src = 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg';
    img.alt = '';
    thumb.appendChild(img);
    var badge = document.createElement('span');
    badge.className = 'un-live-card-badge';
    badge.textContent = 'LIVE';
    thumb.appendChild(badge);
    var body = document.createElement('div');
    body.className = 'un-live-card-body';
    var t = document.createElement('div');
    t.className = 'un-live-card-title';
    t.textContent = title || '(untitled)';
    var c = document.createElement('div');
    c.className = 'un-live-card-sub';
    c.textContent = channel || '';
    body.appendChild(t);
    body.appendChild(c);
    a.appendChild(thumb);
    a.appendChild(body);
    return a;
  }

  function removeShelf() {
    var s = document.getElementById('un-live-shelf');
    if (s) s.remove();
  }

  function ensureShelf() {
    if (!onSupportedFeed() || defaultFeedOn()) {
      removeShelf();
      return;
    }
    var gridRenderer = shelfAnchor();
    if (!gridRenderer || !gridRenderer.parentElement) return;
    var live = [];
    homeTiles(function (tile) {
      if (!YD.tileIsLive(tile)) return;
      var vid = YD.tileVideoId(tile);
      if (!vid) return;
      live.push({ vid: vid, title: YD.tileTitle(tile), channel: YD.tileChannel(tile) });
    });
    // NOTE: an empty result no longer removes the shelf. It used to, which is
    // why the bar "isn't there" much of the time — the moment nobody was live
    // (or the feed hadn't hydrated yet) the whole strip vanished, and it read
    // as the feature being broken rather than as "nobody is streaming". The
    // shelf now stays put and says so, so its absence always means something
    // real: either an unsupported page or the module being switched off.
    var shelf = document.getElementById('un-live-shelf');
    var strip = null;
    if (!shelf) {
      shelf = document.createElement('section');
      shelf.id = 'un-live-shelf';
      shelf.className = 'un-live-shelf';
      var head = document.createElement('div');
      head.className = 'un-live-shelf-head';
      var dot = document.createElement('span');
      dot.className = 'un-live-shelf-dot';
      head.appendChild(dot);
      var label = document.createElement('span');
      label.className = 'un-live-shelf-label';
      label.textContent = 'Live now';
      head.appendChild(label);
      var count = document.createElement('span');
      count.className = 'un-live-shelf-count';
      head.appendChild(count);
      shelf.appendChild(head);
      strip = document.createElement('div');
      strip.className = 'un-live-shelf-strip';
      shelf.appendChild(strip);
      // Insert above sub-manager.js's group shelf too, if present — live
      // relevance outranks a static pinned group, and without this both
      // shelves race to sit directly above the grid renderer.
      // AFTER YouTube's filter-chip bar, not before the grid.
      //
      // The chip bar ("All / Podcasts / Gaming / Live …") is itself sticky and
      // lives INSIDE the grid renderer, so inserting above the grid put our
      // shelf earlier in DOM order — and a later sticky element paints over an
      // earlier one regardless of offsets. Raising z-index only made our bar
      // cover the chips, which is what was reported ("live bar now blocksd
      // youtubes custom feed thing"), and lowering it hid our bar under theirs.
      // Neither is a fix: the two must not occupy the same band at all.
      //
      // Placing the shelf immediately after the chip bar puts it below in both
      // DOM order and on screen, so each sticks to its own row and nothing
      // overlaps. Falls back to the old position when no chip bar exists (the
      // subscriptions feed has none).
      var chipBar = YD && YD.feedChipBar ? YD.feedChipBar() : null;
      var groupShelf = document.getElementById('un-home-shelf');
      if (chipBar && chipBar.parentElement) {
        chipBar.parentElement.insertBefore(shelf, chipBar.nextSibling);
      } else {
        gridRenderer.parentElement.insertBefore(shelf, groupShelf || gridRenderer);
      }
    }
    strip = shelf.querySelector('.un-live-shelf-strip');
    var seen = {};
    live.forEach(function (item) {
      seen[item.vid] = true;
    });
    // Drop cards for streams that ended/scrolled out of the loaded set. Scoped
    // to .un-live-card so the empty-state message (also a child of the strip)
    // isn't treated as a stale card and removed on the next pass.
    Array.from(strip.querySelectorAll('.un-live-card')).forEach(function (card) {
      if (!seen[card.dataset.vid]) card.remove();
    });
    var present = {};
    Array.from(strip.querySelectorAll('.un-live-card')).forEach(function (card) {
      present[card.dataset.vid] = true;
    });
    live.forEach(function (item) {
      if (present[item.vid]) return;
      // Mark it present IMMEDIATELY, not just by appending the card. The
      // `present` map used to be built once before this loop, so a stream
      // appearing twice in the same scrape pass produced two identical cards
      // — reported as "sometimes it will show me the same stream twice".
      // YouTube really does render one stream in more than one home shelf,
      // so the scraped list legitimately contains duplicates.
      present[item.vid] = true;
      var card = buildLiveCard(item.vid, item.title, item.channel);
      card.dataset.vid = item.vid;
      // Before the empty-state message if it's still mounted, so a card never
      // renders after "nobody is live" during the same pass.
      var msg = strip.querySelector('.un-live-shelf-empty');
      if (msg) strip.insertBefore(card, msg);
      else strip.appendChild(card);
    });
    // Count the DEDUPED cards actually on screen, not the raw scrape length,
    // or the header reads "3 streams" above two cards.
    var shown = strip.querySelectorAll('.un-live-card').length;
    setText(shelf.querySelector('.un-live-shelf-count'), shown === 1 ? '1 stream' : shown + ' streams');

    // Empty state. The shelf stays mounted with nothing live so its presence is
    // constant and its emptiness is informative — the previous behaviour
    // (remove the whole thing) was indistinguishable from the feature failing.
    var empty = strip.querySelector('.un-live-shelf-empty');
    if (!shown) {
      if (!empty) {
        empty = document.createElement('span');
        empty.className = 'un-live-shelf-empty';
        empty.textContent = 'Nobody you follow is live right now.';
        strip.appendChild(empty);
      }
      shelf.classList.add('is-empty');
    } else {
      if (empty) empty.remove();
      shelf.classList.remove('is-empty');
    }
  }

  function refresh() {
    if (core && !core.isModuleEnabled(mod)) return;
    ensureShelf();
  }

  // Re-check repeatedly after a navigation while YouTube finishes building the
  // feed. Every timer is tracked so teardown() can cancel them — an orphaned
  // timer would keep calling into a torn-down module.
  //
  // The window used to stop at 3s. Feeds that hydrate slowly (cold cache, slow
  // connection, or the subscriptions feed which fetches after first paint)
  // routinely finish after that, and with no further mutation to trigger scan()
  // the shelf simply never appeared — a large part of "tons of times the live
  // bar isn't there". The tail retries cost one cheap DOM query each.
  var settleTimers = [];
  function clearSettleRetries() {
    settleTimers.forEach(clearTimeout);
    settleTimers = [];
  }
  function scheduleSettleRetries() {
    clearSettleRetries();
    [250, 700, 1500, 3000, 5000, 8000].forEach(function (ms) {
      settleTimers.push(setTimeout(refresh, ms));
    });
  }

  var onNavStart = null;
  var onDefaultFeedChanged = null;

  var mod = {
    id: 'liveNow',
    moduleKey: 'liveNow',
    init: function (c) {
      core = c;
      onNavStart = function () {
        removeShelf();
      };
      document.addEventListener('yt-navigate-start', onNavStart);
      onDefaultFeedChanged = refresh;
      document.addEventListener('unsynth-default-feed-changed', onDefaultFeedChanged);
      refresh();
      // A cold load lands here before the grid exists, same as a navigation.
      scheduleSettleRetries();
    },
    scan: function () {
      // Do NOT early-return when off-home: ensureShelf() is what removes a
      // stale shelf, so bailing here left one stranded on a non-home page
      // after a SPA navigation until some unrelated event happened to fire.
      refresh();
    },
    onNavigate: function () {
      // Rebuild in place rather than tearing down first. removeShelf() here
      // guaranteed a visible flicker on every navigation, and if the new page's
      // feed hadn't hydrated yet the shelf was gone with nothing to bring it
      // back until some later mutation happened to fire. ensureShelf() already
      // removes the shelf itself when the destination isn't a supported feed.
      refresh();
      // The home grid is built asynchronously AFTER yt-navigate-finish, so a
      // single rebuild here usually runs against a grid that doesn't exist
      // yet and finds nothing. scan() re-runs on DOM mutations and normally
      // covers it, but on a quiet feed (or when the grid settles between
      // mutation batches) there may be no further trigger — which showed up
      // as the bar simply not appearing on some navigations. A few cheap
      // retries make arrival deterministic instead of luck.
      scheduleSettleRetries();
    },
    teardown: function () {
      clearSettleRetries();
      if (onNavStart) {
        document.removeEventListener('yt-navigate-start', onNavStart);
        onNavStart = null;
      }
      if (onDefaultFeedChanged) {
        document.removeEventListener('unsynth-default-feed-changed', onDefaultFeedChanged);
        onDefaultFeedChanged = null;
      }
      removeShelf();
    }
  };

  if (window.UNSYNTH) window.UNSYNTH.register(mod);
})();
