/**
 * Watch-page description digest for the video currently playing.
 * Cinema / theater / a collapsed "...more" bury YouTube's own description.
 * This card sits under the title stats and shows THIS video's blurb, links,
 * and timestamp jumps — never a generic Unsynth about-blurb, never another
 * video's text.
 */
(function () {
  'use strict';

  // Visible chip cap for timestamps. Measured at the 1179px watch column: 7
  // sit on one line with room left, and the overflow chip reveals the rest in
  // place. Links are no longer capped: all of them are listed, grouped by
  // purpose (2026-09-24).
  const STAMP_CAP = 7;

  let core = null;
  let lastVid = '';
  // Video we deliberately rendered no card for (no timestamps, no links).
  let suppressedVid = '';
  let staleVid = '';
  let staleTries = 0;
  let fetchGen = 0;
  let lastParsed = null;

  // Chapters and links are precisely what collapsing this row hides, so they are
  // what the collapsed row should report.
  function deckSummary() {
    var root = document.querySelector('.un-desc-digest');
    if (!root) return '';
    var stamps = root.querySelectorAll('.un-desc-stamp').length;
    var links = root.querySelectorAll('.un-desc-link').length;
    var bits = [];
    if (stamps) bits.push(stamps + (stamps === 1 ? ' chapter' : ' chapters'));
    if (links) bits.push(links + (links === 1 ? ' link' : ' links'));
    return bits.join(' · ');
  }

  /**
   * The deck header's PRIMARY VALUE: the actual timestamps and hosts, not a
   * count of them.
   *
   * DESIGN-STANDARD.md rule A and its Weak/Strong table name this surface
   * directly — "13 chapters >" is the Weak example, "0:00 1:07 2:42 ... +8" is
   * the Strong one. This module was rendering the Weak row while already
   * holding the parsed, clickable stamps: deckSummary() counted
   * `.un-desc-stamp` nodes that seek the video on click. The value was one
   * property access away the whole time; the deck simply had no primitive that
   * could carry a list, so a count was the only expressible thing.
   *
   * Reuses the SAME live DOM nodes' data the body renders, so the header and
   * the expanded body can never disagree about what the video contains.
   */
  function deckPreview() {
    var root = document.querySelector('.un-desc-digest');
    var items = [];

    function cleanChapterTitle(label, title) {
      var digest = DD();
      return digest && digest.cleanChapterTitle
        ? digest.cleanChapterTitle(label, title)
        : String(title || '').trim();
    }

    function addChapter(label, title, sec, onClick, tooltip) {
      var clean = cleanChapterTitle(label, title);
      items.push({
        label: label,
        sub: clean,
        sec: typeof sec === 'number' ? sec : null,
        group: 'Chapters',
        title: tooltip || (clean ? (label + ' · ' + clean) : ('Jump to ' + label)),
        onClick: onClick
      });
    }

    // 1. Direct parsed timestamps: captures ALL chapters in the video without
    // any DOM cap or element-read delay.
    var stampList = (lastParsed && lastParsed.stamps && lastParsed.stamps.length)
      ? lastParsed.stamps
      : [];
    if (stampList.length) {
      for (var s = 0; s < stampList.length; s++) {
        (function (st) {
          addChapter(st.label, st.title, st.sec, function () { seekTo(st.sec); });
        })(stampList[s]);
      }
    } else if (root) {
      var stamps = root.querySelectorAll('.un-desc-stamp');
      for (var i = 0; i < stamps.length; i++) {
        (function (btn) {
          var label = (btn.textContent || '').trim();
          if (!label) return;
          var sec = DD() && DD().secondsFromTs ? DD().secondsFromTs(label) : null;
          addChapter(label, (btn.dataset && btn.dataset.sub) || '', sec, function () { btn.click(); }, btn.title || '');
        })(stamps[i]);
      }
    }

    // 2. Native YouTube chapters from the page when description had none
    if (!items.some(function (it) { return it.group === 'Chapters'; })) {
      var yd = YD();
      var nativeChaps = (yd && yd.nativeChapters) ? yd.nativeChapters(document) : [];
      if (nativeChaps && nativeChaps.length) {
        for (var nc = 0; nc < nativeChaps.length; nc++) {
          (function (c) {
            var sec = DD() && DD().secondsFromTs ? DD().secondsFromTs(c.label) : null;
            addChapter(c.label, c.title, sec, function () {
                if (c.el && c.el.click) { c.el.click(); }
                else if (sec != null) { seekTo(sec); }
              });
          })(nativeChaps[nc]);
        }
      }
    }

    // 3. Ranked list items (Top 10, N Biggest Changes)
    if (!items.some(function (it) { return it.group === 'Chapters'; })) {
      var rankedList = (lastParsed && lastParsed.ranked && lastParsed.ranked.length)
        ? lastParsed.ranked
        : [];
      if (rankedList.length) {
        for (var rk = 0; rk < rankedList.length; rk++) {
          (function (item) {
            var fmtTs = DD() && DD().tsLabel ? DD().tsLabel : function (sec) {
              var m = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
              return m + ':' + ss;
            };
            var label = item.sec != null ? fmtTs(item.sec) : '#' + item.num;
            var sub = item.sec != null ? ('#' + item.num + ' ' + item.title) : item.title;
            addChapter(label, sub, item.sec, item.sec != null ? function () { seekTo(item.sec); } : null,
              '#' + item.num + ' ' + item.title + (item.sec != null ? ' (' + label + ')' : ''));
          })(rankedList[rk]);
        }
      } else if (root) {
        var rankedRows = root.querySelectorAll('.un-desc-ranked-row');
        for (var r = 0; r < rankedRows.length; r++) {
          (function (row) {
            var numEl = row.querySelector('.un-desc-ranked-n');
            var nameEl = row.querySelector('.un-desc-ranked-name');
            var tsEl = row.querySelector('.un-desc-ranked-ts');
            var num = numEl ? numEl.textContent.trim() : '';
            var name = nameEl ? nameEl.textContent.trim() : '';
            var ts = tsEl ? tsEl.textContent.trim() : '';
            var isClick = row.classList.contains('is-clickable');
            var label = ts || num;
            var sub = ts ? (num ? num + ' ' + name : name) : name;
            var sec = DD() && DD().secondsFromTs && ts ? DD().secondsFromTs(ts) : null;
            addChapter(label, sub, sec, isClick ? function () { row.click(); } : null,
              (num ? num + ' ' : '') + name + (ts ? ' (' + ts + ')' : ''));
          })(rankedRows[r]);
        }
      }
    }

    // 4. Outbound link hosts
    var seenHost = {};
    if (root) {
      var links = root.querySelectorAll('.un-desc-link > a');
      for (var j = 0; j < links.length; j++) {
        var a = links[j];
        var host = '';
        try { host = new URL(a.href).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
        if (!host || seenHost[host]) continue;
        seenHost[host] = true;
        items.push({ label: host, group: 'Links', title: a.title || a.href, href: a.href });
      }
    } else if (lastParsed && lastParsed.links) {
      for (var l = 0; l < lastParsed.links.length; l++) {
        var lnk = lastParsed.links[l];
        if (!lnk.host || seenHost[lnk.host]) continue;
        seenHost[lnk.host] = true;
        items.push({ label: lnk.host, group: 'Links', title: lnk.label || lnk.url, href: lnk.url });
      }
    }

    return items.length ? items : null;
  }

  /**
   * Show the value when there is value to show; fall back to the count only
   * when the preview cannot be built (no parsed body yet). The fallback is
   * deliberately kept: an empty header would be worse than a count.
   */
  function applyDeckHeader() {
    if (!window.UNWatchDeck) return;
    var items = deckPreview();
    if (items && window.UNWatchDeck.setPreview) {
      // SIDE MODE: ALL CHAPTERS AND LINKS VISIBLE (2026-09-30). In side mode
      // the desc slot is a scrollable full-height column — show every chapter
      // and every link host so the user can click straight to any section or
      // destination without a "+N" step. Caps are kept for the under-video /
      // compact chip-row layout where wrapping costs vertical space.
      var inSide = window.UNWatchDeck.isSide && window.UNWatchDeck.isSide();
      var chapCap = inSide ? Infinity : 6;
      var linkCap = inSide ? Infinity : 5;
      window.UNWatchDeck.setPreview('desc', items, { caps: { Chapters: chapCap, Links: linkCap } });
      return;
    }
    if (window.UNWatchDeck.setSummary) window.UNWatchDeck.setSummary('desc', deckSummary());
  }

  function DD() {
    return window.UNDescDigest;
  }

  function el(tag, cls, text) {
    return window.UNSYNTH.el(tag, cls, text);
  }

  function currentVideoId() {
    return window.UNSYNTH && window.UNSYNTH.videoId ? window.UNSYNTH.videoId() : '';
  }

  function isWatch() {
    return window.UNSYNTH && window.UNSYNTH.isWatch && window.UNSYNTH.isWatch();
  }

  function pageTitle() {
    const h = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, #title h1 yt-formatted-string, #title h1'
    );
    return h ? h.textContent.trim() : '';
  }

  function pageChannel() {
    const ch = document.querySelector('#owner #channel-name a, ytd-channel-name a');
    return ch ? ch.textContent.trim() : '';
  }

  function domDescription() {
    const nodes = document.querySelectorAll(
      '#description-inline-expander yt-attributed-string, #description-inline-expander yt-formatted-string, #description yt-formatted-string, ytd-text-inline-expander yt-attributed-string'
    );
    let best = '';
    nodes.forEach(function (n) {
      const t = (n.textContent || '').trim();
      if (t.length > best.length) best = t;
    });
    return best;
  }

  function requestPlayerDescription(vid) {
    return new Promise(function (resolve) {
      const reqId = 'desc' + Date.now();
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.type !== 'UN_STATS' || e.data.reqId !== reqId) return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'UN_STATS_REQ', reqId: reqId }, '*');
      setTimeout(function () {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 2500);
    }).then(function (data) {
      // The player still describing the PREVIOUS video is "not yet", not
      // "empty": the caller retries instead of falling back to page text that
      // cannot be proven to belong to this video (DESIGN-STANDARD section 8).
      if (data && data.videoId && data.videoId !== vid) return { description: '', title: '', author: '', stale: true };
      if (!data || data.videoId !== vid) return { description: '', title: '', author: '' };
      return {
        description: String(data.description || ''),
        title: String(data.title || ''),
        author: String(data.author || '')
      };
    });
  }

  function seekTo(sec) {
    const video =
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video');
    if (!video || !isFinite(sec)) return;
    video.currentTime = sec;
  }

  function YD() {
    return window.UNYtDom || null;
  }

  // Watches the expander's is-expanded attribute so clicking YouTube's own
  // "...more" / "Show less" relabels our button too, instead of leaving it
  // claiming "Open" on an already-open description.
  let descObserver = null;
  let descObserved = null;
  function watchNativeDescription() {
    const yd = YD();
    const expander = document.querySelector(
      (yd && yd.WATCH_DESC_EXPANDER_SEL) || 'ytd-text-inline-expander, #description-inline-expander'
    );
    if (!expander || expander === descObserved) return;
    if (descObserver) descObserver.disconnect();
    descObserved = expander;
    // Wrapped, not passed directly: a MutationObserver hands its callback a
    // MutationRecord array, which would land in syncMoreButton's element
    // parameter and be treated as the button.
    descObserver = new MutationObserver(function () {
      syncMoreButton();
    });
    descObserver.observe(expander, { attributes: true, attributeFilter: ['is-expanded'] });
  }

  /**
   * Point the card's button at whatever the description is actually doing.
   *
   * Takes the button when the caller already has it: on first render this runs
   * BEFORE insertPanel(), so a document query finds nothing, returns early,
   * and the button ships without aria-expanded or a collapse label until some
   * later repaint happens to fix it. Caught by asserting on the rendered
   * attribute rather than trusting the source read.
   */
  function syncMoreButton(el) {
    const btn =
      el && el.nodeType === 1 ? el : document.querySelector('#un-desc-digest .un-desc-more');
    if (!btn) return;
    // Beside the video the button opens the description IN the guide, so its
    // state is ours, not YouTube's expander's.
    const panel = btn.closest ? btn.closest('.un-desc-digest') : null;
    if (inGuideSide(panel)) {
      const open = !!(panel && panel.classList.contains('is-full-open'));
      btn.textContent = open ? 'Hide full description' : 'Open full description';
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-controls', 'un-desc-full');
      return;
    }
    btn.removeAttribute('aria-controls');
    const expanded = nativeDescriptionExpanded();
    btn.textContent = expanded ? 'Collapse full description' : 'Open full description';
    btn.setAttribute('aria-expanded', String(expanded));
  }

  /** Is this digest showing in the guide beside the video (not compact)? */
  function inGuideSide(panel) {
    return !!(panel && panel.closest && panel.closest('.un-watch-deck.is-side:not(.is-compact)'));
  }

  /**
   * OPEN THE FULL DESCRIPTION WHERE YOU ARE (2026-09-24).
   *
   * User report: "if they choose to open the full description is there a way it can
   * open it there? or at least jump to a fully expanded description". Beside
   * the video, YouTube's own description is under the player, a scroll away,
   * so the button used to send you down the page. It now opens the whole text
   * inside the guide, right under the quick description: line breaks kept,
   * links clickable, timestamps seeking the video. Built from text nodes only;
   * the description is never parsed as HTML. "Show on YouTube" still expands
   * YouTube's own and scrolls to it.
   */
  function buildFullDescription(text) {
    const box = el('div', 'un-desc-full');
    box.id = 'un-desc-full';
    const body = el('div', 'un-desc-full-text');
    const tokenRe = /(\bhttps?:\/\/[^\s<>"']+)|((?:^|(?<=[\s(\[]))\d{1,2}:\d{2}(?::\d{2})?(?=[\s)\].,:]|$))/gm;
    String(text || '').split('\n').forEach(function (line, i) {
      if (i) body.appendChild(document.createElement('br'));
      let last = 0;
      let m;
      tokenRe.lastIndex = 0;
      while ((m = tokenRe.exec(line)) !== null) {
        if (m.index > last) body.appendChild(document.createTextNode(line.slice(last, m.index)));
        if (m[1]) {
          const url = m[1].replace(/[.,;:!?]+$/, '');
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = url;
          body.appendChild(a);
          last = m.index + url.length;
          tokenRe.lastIndex = last;
          continue;
        }
        const sec = DD() && DD().secondsFromTs ? DD().secondsFromTs(m[2]) : null;
        if (sec == null) {
          body.appendChild(document.createTextNode(m[2]));
        } else {
          const b = el('button', 'un-desc-full-ts', m[2]);
          b.type = 'button';
          b.title = 'Jump to ' + m[2];
          b.addEventListener('click', function () { seekTo(sec); });
          body.appendChild(b);
        }
        last = m.index + m[0].length;
      }
      if (last < line.length) body.appendChild(document.createTextNode(line.slice(last)));
    });
    box.appendChild(body);
    // A way to close it where you finish reading, not only at the top: the
    // open text is long and the button that opened it has scrolled away.
    const hide = el('button', 'un-desc-full-yt un-desc-full-hide', 'Hide full description');
    hide.type = 'button';
    hide.addEventListener('click', function () {
      const panel = box.closest('.un-desc-digest');
      const btn = panel && panel.querySelector('.un-desc-more');
      if (btn) {
        btn.click();
        if (btn.scrollIntoView) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    box.appendChild(hide);
    const onYt = el('button', 'un-desc-full-yt', 'Show on YouTube');
    onYt.type = 'button';
    onYt.addEventListener('click', function () {
      if (!nativeDescriptionExpanded()) toggleNativeDescription();
      else {
        const desc = document.querySelector('#description, #description-inline-expander');
        if (desc && desc.scrollIntoView) desc.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    });
    box.appendChild(onYt);
    return box;
  }

  function onMoreClick(ev) {
    const btn = ev && ev.currentTarget;
    const panel = btn && btn.closest ? btn.closest('.un-desc-digest') : null;
    if (!inGuideSide(panel)) {
      toggleNativeDescription();
      return;
    }
    const open = !panel.classList.contains('is-full-open');
    panel.classList.toggle('is-full-open', open);
    let full = panel.querySelector('#un-desc-full');
    if (open && !full) {
      full = buildFullDescription(panel.__unFullText || '');
      btn.insertAdjacentElement('afterend', full);
    }
    if (full) full.hidden = !open;
    syncMoreButton(btn);
    if (open && full && full.scrollIntoView) full.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Is YouTube's description currently expanded?
   *
   * Both #expand and #collapse stay in the DOM permanently and YouTube swaps
   * which one is visible, so presence proves nothing — visibility does.
   * Prefer the expander's own is-expanded attribute and fall back to the
   * collapse control being on screen. Verified live on a watch page: the
   * attribute appears on expand and is gone again after collapse.
   */
  function nativeDescriptionExpanded() {
    const yd = YD();
    const expander = document.querySelector(
      (yd && yd.WATCH_DESC_EXPANDER_SEL) || 'ytd-text-inline-expander, #description-inline-expander'
    );
    if (expander && expander.hasAttribute('is-expanded')) return true;
    const collapse = document.querySelector(
      (yd && yd.WATCH_DESC_COLLAPSE_SEL) ||
        'tp-yt-paper-button#collapse, #description #collapse, ytd-text-inline-expander #collapse, #description-inline-expander #collapse'
    );
    return !!(collapse && collapse.offsetParent);
  }

  /**
   * Toggle YouTube's own description open/closed.
   *
   * This used to only ever expand, so once the description was open the
   * button was a dead control — clicking it again did nothing and there was
   * no way back to the collapsed view from our card.
   */
  function toggleNativeDescription() {
    const yd = YD();
    const expanded = nativeDescriptionExpanded();
    const sel = expanded
      ? (yd && yd.WATCH_DESC_COLLAPSE_SEL) ||
        'tp-yt-paper-button#collapse, #description #collapse, ytd-text-inline-expander #collapse, #description-inline-expander #collapse'
      : (yd && yd.WATCH_DESC_EXPAND_SEL) ||
        'tp-yt-paper-button#expand, #description #expand, ytd-text-inline-expander #expand, #description-inline-expander #expand';
    const btn = document.querySelector(sel);
    if (btn) {
      try {
        btn.click();
      } catch (e) {
        /* ignore */
      }
    }
    // Only chase the description on the way OPEN. Scrolling to it while
    // collapsing yanks the page around for no reason.
    if (!expanded) {
      const desc = document.querySelector('#description, #description-inline-expander');
      if (desc && desc.scrollIntoView) desc.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    syncMoreButton();
  }

  function insertPanel(panel) {
    const existing = document.getElementById('un-desc-digest');
    if (existing && existing !== panel) existing.remove();
    // Shared deck first: this panel, the stats strip and fact-check used to
    // insert three separate cards, which read as three unrelated blocks
    // stacked above the channel row. In the deck they are slots divided by
    // hairlines. Own anchor below stays as the fallback.
    if (window.UNWatchDeck) {
      const s = window.UNWatchDeck.slot('desc');
      if (s) {
        if (panel.parentElement !== s) s.appendChild(panel);
        window.UNWatchDeck.syncEmpty(); if (window.UNWatchDeck.syncCollapse) window.UNWatchDeck.syncCollapse();
        applyDeckHeader();
        return;
      }
    }
    const stats = document.getElementById('un-vid-stats');
    if (stats) {
      stats.insertAdjacentElement('afterend', panel);
      return;
    }
    const actions =
      document.querySelector('ytd-watch-metadata #actions') || document.querySelector('#actions');
    if (actions) {
      actions.insertAdjacentElement('afterend', panel);
      return;
    }
    const below = document.querySelector('#below, ytd-watch-metadata');
    if (below) below.insertAdjacentElement('afterbegin', panel);
  }

  function render(vid, title, channel, parsed) {
    let panel = document.getElementById('un-desc-digest');
    if (!panel) {
      panel = el('div', 'un-desc-digest');
      panel.id = 'un-desc-digest';
      panel.setAttribute('role', 'region');
    }
    panel.setAttribute('data-video-id', vid);
    panel.setAttribute('aria-label', 'Description of the video you are watching');
    panel.textContent = '';

    // No title, channel or blurb here any more. This card sits directly under
    // YouTube's own H1, owner row and description box, and measured on three
    // real watch pages it was repeating all three: the title matched the H1 and
    // the channel matched the owner row on 3/3, and the blurb was already inside
    // YouTube's description on 2/3. Reported from a screenshot where the same
    // sentence appeared twice within about 200px of itself.
    //
    // What YouTube does NOT surface without expanding the description is the
    // timestamps as jump buttons and the links pulled out as a list — so that is
    // all this card is now. The kicker stays as the only label, since with the
    // title gone the card still needs to say what it is.
    // No kicker. The deck slot header above already reads "In this video", and
    // a second label saying "In this description" under it is the same thing
    // twice — the digest IS the description, so naming it again spends a row
    // on nothing.

    if (parsed.empty) {
      panel.appendChild(el('p', 'un-desc-empty', 'No description on this video.'));
    } else {
      // WHAT IS THIS VIDEO ABOUT.
      //
      // Chapters and links are navigation. They tell you where to go inside a
      // video you have already decided to watch; they do not answer the
      // question the slot header asks. parseWatchDescription has produced this
      // blurb all along — URLs stripped, clipped to 320 — and nothing rendered
      // it, so the digest was a jump bar wearing the name of a summary.
      //
      // Sourced from requestPlayerDescription(vid) for THIS video id, with the
      // three currentVideoId() !== vid guards in refresh() above standing
      // between it and a stale flash under the next video.
      if (parsed.blurb) {
        var blurbEl = el('p', 'un-desc-blurb', parsed.blurb);
        // Clamped to one line visually; the full text stays readable on hover
        // and to assistive tech rather than being truncated away.
        blurbEl.title = parsed.blurb;
        panel.appendChild(blurbEl);
      }
      if (parsed.stamps.length) {
        const row = el('div', 'un-desc-stamps');
        const addStamp = function (st) {
          const b = el('button', 'un-desc-stamp', st.label);
          b.type = 'button';
          b.title = 'Jump to ' + st.label + (st.title ? ' · ' + st.title : '');
          if (st.title) b.dataset.sub = st.title;
          b.addEventListener('click', function () {
            seekTo(st.sec);
          });
          row.appendChild(b);
        };
        parsed.stamps.slice(0, STAMP_CAP).forEach(addStamp);
        if (parsed.stamps.length > STAMP_CAP) {
          const rest = parsed.stamps.slice(STAMP_CAP);
          const more = el('button', 'un-desc-more-chip', '+' + rest.length);
          more.type = 'button';
          more.title = 'Show ' + rest.length + ' more chapter' + (rest.length === 1 ? '' : 's');
          more.setAttribute('aria-label', more.title);
          more.addEventListener('click', function () {
            more.remove();
            rest.forEach(addStamp);
          });
          row.appendChild(more);
        }
        panel.appendChild(row);
      }

      // WORTH KNOWING (2026-09-24). User report: "any thing important as a summary".
      // The description's own words for a sponsor and its code, a paid or
      // affiliate disclosure, a disclaimer, a correction, the credits.
      if (parsed.highlights && parsed.highlights.length) {
        const box = el('div', 'un-desc-know');
        box.appendChild(el('h4', 'un-desc-h', 'Worth knowing'));
        const ul = el('ul', 'un-desc-know-list');
        parsed.highlights.forEach(function (h) {
          const li = el('li', 'un-desc-know-row is-' + h.kind);
          li.appendChild(el('span', 'un-desc-know-k', h.label));
          li.appendChild(el('span', 'un-desc-know-t', h.text));
          ul.appendChild(li);
        });
        box.appendChild(ul);
        panel.appendChild(box);
      }

      // EVERY LINK, AND WHAT IT IS FOR (2026-09-24). User report: "should include all
      // links they have and what they are for". Grouped by purpose, each named
      // by the description's own words, with the site beside it. No cap: the
      // old one showed four hostnames and hid the rest behind "+N".
      const groups = parsed.linkGroups && parsed.linkGroups.length
        ? parsed.linkGroups
        : (parsed.links.length ? [{ id: 'other', label: 'Links', links: parsed.links }] : []);
      if (groups.length) {
        const wrap = el('div', 'un-desc-linkgroups');
        groups.forEach(function (grp) {
          const sec = el('section', 'un-desc-lgroup is-' + grp.id);
          sec.appendChild(el('h4', 'un-desc-h', grp.label));
          const list = el('ul', 'un-desc-links');
          grp.links.forEach(function (lnk) {
            const li = el('li', 'un-desc-link');
            const a = document.createElement('a');
            a.href = lnk.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = lnk.url;
            a.appendChild(el('span', 'un-desc-link-t', lnk.context || lnk.label || lnk.host));
            if (lnk.context) a.appendChild(el('span', 'un-desc-link-h', lnk.host));
            li.appendChild(a);
            list.appendChild(li);
          });
          sec.appendChild(list);
          wrap.appendChild(sec);
        });
        panel.appendChild(wrap);
      }
    }

      // RANKED LIST (2026-09-30). "Top 10 / Best X / N BIGGEST Changes" type
      // videos. When the parser detected a numbered list the items are the
      // primary navigation value — more useful than bare timestamps. Show them
      // as a table-of-contents with number, title, optional timestamp, and a
      // one-sentence context snippet from the following text.
      // Only when it adds to the chapter list (see rankedAddsToChapters).
      const rankedAdds = parsed.ranked && parsed.ranked.length &&
        (!DD() || !DD().rankedAddsToChapters || DD().rankedAddsToChapters(parsed.ranked, parsed.stamps));
      if (rankedAdds) {
        const fmtTs = DD() && DD().tsLabel ? DD().tsLabel : function (s) {
          var m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
          return m + ':' + ss;
        };
        const box = el('div', 'un-desc-ranked');
        box.setAttribute('aria-label', 'Video list');
        parsed.ranked.forEach(function (item) {
          const row = el('div', 'un-desc-ranked-row');
          if (item.sec != null) {
            row.classList.add('is-clickable');
            row.addEventListener('click', function () { seekTo(item.sec); });
            row.setAttribute('role', 'button');
            row.setAttribute('tabindex', '0');
            row.title = 'Jump to ' + fmtTs(item.sec);
            row.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); seekTo(item.sec); }
            });
          }
          const num = el('span', 'un-desc-ranked-n', '#' + item.num);
          const body = el('div', 'un-desc-ranked-body');
          const titleLine = el('div', 'un-desc-ranked-t');
          titleLine.appendChild(el('span', 'un-desc-ranked-name', item.title));
          if (item.sec != null) {
            titleLine.appendChild(el('span', 'un-desc-ranked-ts', fmtTs(item.sec)));
          }
          body.appendChild(titleLine);
          if (item.context) body.appendChild(el('p', 'un-desc-ranked-ctx', item.context));
          row.appendChild(num);
          row.appendChild(body);
          box.appendChild(row);
        });
        panel.appendChild(box);
      }
    const hasSubstance = !parsed.empty && (parsed.stamps.length > 0 || parsed.links.length > 0 ||
      (parsed.highlights && parsed.highlights.length > 0) ||
      (parsed.ranked && parsed.ranked.length > 0) || !!parsed.blurb);
    if (!hasSubstance) {
      // Drop the node directly rather than via removePanel(): that also clears
      // lastVid, and ensure() re-runs refresh() whenever the panel is absent —
      // so on a video with nothing to show the pair would refetch the player
      // description on every scan, forever. lastVid stays set so this video is
      // treated as handled.
      const stale = document.getElementById('un-desc-digest');
      if (stale) stale.remove();
      // ONLY suppress if we actually received text and verified there is nothing to show.
      // If text was empty, the description hasn't arrived yet — don't suppress!
      if (parsed.text && parsed.text.length > 0) {
        suppressedVid = vid;
      }
      return null;
    }

    const more = el('button', 'un-desc-more', 'Open full description');
    more.type = 'button';
    more.addEventListener('click', onMoreClick);
    // Under the quick description, where "the rest of it" is looked for
    // (2026-09-24): beside the video it opens the full text right there. With
    // no quick description it closes the section. The full text is kept on
    // the panel for onMoreClick, which builds it only when asked.
    panel.__unFullText = parsed.text || '';
    const blurbNode = panel.querySelector(':scope > .un-desc-blurb');
    if (blurbNode) blurbNode.insertAdjacentElement('afterend', more);
    else panel.appendChild(more);
    panel.classList.remove('is-full-open');
    // The description can also be expanded or collapsed by YouTube's own
    // "...more" / "Show less", so the label has to follow the real state
    // rather than only what our button last did.
    watchNativeDescription();
    syncMoreButton(more);

    if (!panel.isConnected) {
      insertPanel(panel);
    } else {
      applyDeckHeader();
      if (window.UNWatchDeck && window.UNWatchDeck.syncEmpty) window.UNWatchDeck.syncEmpty();
    }
    return panel;
  }

  function removePanel() {
    const panel = document.getElementById('un-desc-digest');
    if (panel) panel.remove();
    // The chapter rows live in the deck's preview, not in the panel: without
    // this the previous video's chapters stayed listed and clickable under
    // the next video for ~1.4 s (measured 2026-10-01).
    if (window.UNWatchDeck && window.UNWatchDeck.setPreview) window.UNWatchDeck.setPreview('desc', []);
    lastVid = '';
    lastParsed = null;
    // Clear the suppression marker with lastVid, so leaving and returning to a
    // watch page re-evaluates rather than staying silent on a stale decision.
    suppressedVid = '';
    try {
      document.documentElement.removeAttribute('data-unsynth-desc-id');
    } catch (e) {
      /* ignore */
    }
  }

  async function refresh() {
    if (!isWatch()) {
      removePanel();
      return;
    }
    const vid = currentVideoId();
    if (!vid) return;
    const gen = ++fetchGen;
    const title = pageTitle();
    const channel = pageChannel();

    let payload = { description: '', title: '', author: '' };
    try {
      payload = await requestPlayerDescription(vid);
    } catch (e) {
      payload = { description: '', title: '', author: '' };
    }
    if (gen !== fetchGen) return;
    if (currentVideoId() !== vid) return;
    if (payload.stale) {
      // Retry while the player catches up (measured: under a second); after
      // ~3 s give up, release the guide and let the next scan try again.
      staleTries = (staleVid === vid ? staleTries : 0) + 1;
      staleVid = vid;
      if (staleTries <= 12) {
        setTimeout(function () { if (gen === fetchGen && currentVideoId() === vid) refresh(); }, 250);
      } else if (window.UNWatchDeck && window.UNWatchDeck.contentReady) {
        window.UNWatchDeck.contentReady();
      }
      return;
    }
    let raw = payload.description || '';
    if (!raw) raw = domDescription();
    if (currentVideoId() !== vid) return;

    const parsed = DD() && DD().parseWatchDescription ? DD().parseWatchDescription(raw) : { empty: !raw, blurb: raw.slice(0, 280), links: [], stamps: [] };
    lastParsed = parsed;
    lastVid = vid;
    render(vid, payload.title || title, payload.author || channel, parsed);
    if (window.UNWatchDeck && window.UNWatchDeck.contentReady) window.UNWatchDeck.contentReady();
    try {
      document.documentElement.setAttribute('data-unsynth-desc-id', vid);
    } catch (e) {
      /* ignore */
    }
  }

  function ensure() {
    if (!isWatch()) {
      removePanel();
      return;
    }
    const vid = currentVideoId();
    if (!vid) return;
    // `suppressedVid` is the video we deliberately rendered nothing for. Without
    // it the missing-panel clause below re-runs refresh() on every scan for any
    // description with no timestamps and no links — an endless refetch of the
    // player response for a card that is never going to appear.
    if (vid === suppressedVid) return;
    if (vid !== lastVid || !document.getElementById('un-desc-digest')) refresh();
  }

  const mod = {
    id: 'descDigest',
    moduleKey: 'descDigest',
    init: function (c) {
      core = c;
      ensure();
    },
    scan: ensure,
    onNavigate: function () {
      fetchGen += 1;
      lastVid = '';
      removePanel();
      // Straight away: a stale player answer now retries on its own, so the
      // fixed 400 ms head start only delayed every navigation.
      setTimeout(ensure, 0);
    },
    teardown: function () {
      fetchGen += 1;
      removePanel();
    }
  };

  if (typeof window !== 'undefined' && window.UNSYNTH) {
    window.UNSYNTH.register(mod);
    // Re-render chip caps when the deck moves between side and under-video
    // (e.g. page loads in 1-column mode then expands to 2-column). The event
    // bubbles from the deck; we listen on document to avoid needing a reference.
    document.addEventListener('un-placement-change', function () {
      applyDeckHeader();
    });
  }
})();
