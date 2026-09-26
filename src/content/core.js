/**
 * Unsynth suite core — the shared content-script engine.
 *
 * Owns ONE debounced MutationObserver, the YouTube SPA navigation hook, the
 * settings load + live-reload, and a module registry. Feature modules (AI
 * filter, subscription manager, playlist manager, AI assistant, analytics)
 * register themselves against `window.UNSYNTH` and implement any of:
 *   init(core)        once, at start
 *   scan()            on each debounced DOM mutation (only if module enabled)
 *   onNavigate()      on yt-navigate-finish
 *   onSettings(s)     when chrome.storage.sync changes
 *   onMessage(m, res) for chrome.runtime messages (return true if async)
 *
 * Load order in the manifest: defaults.js → core.js → modules/*.js → boot.js.
 * boot.js calls UNSYNTH.start() after every module has registered.
 */
(function () {
  'use strict';

  const DEFAULTS = window.UNSYNTH_DEFAULTS || {};

  const core = {
    settings: Object.assign({}, DEFAULTS),
    host: location.host,
    isMusic: location.host === 'music.youtube.com',
    lc: (s) => (s || '').toLowerCase(),
    modules: [],
    _moduleIds: new Map(),
    _errors: [],
    _selectorMisses: [],
    _scanSamples: [],
    _moduleScanSamples: new Map(),

    /**
     * Record a selector that was expected to match and did not.
     *
     * YouTube markup drift is the top bug source here and its signature is
     * always silence: the selector stops matching, the feature stops acting,
     * and nothing reports it. Every past drift bug was found by a user
     * noticing broken behaviour rather than by the code. 320 hardcoded
     * YouTube selectors live outside shared/yt-dom.js, so recurrence is a
     * matter of when.
     *
     * Aggregated by selector with a count, because the count IS the signal:
     * one miss is a quiet page, fifty is drift. Bounded like _errors so a
     * page that is drifting badly cannot grow this without limit.
     */
    reportSelectorMiss(scope, selector) {
      const sel = String(selector || '').slice(0, 200);
      const sc = String(scope || 'core');
      const key = sc + '::' + sel;
      const now = Date.now();
      const prev = this._selectorMisses.find((e) => e.key === key);
      if (prev) {
        prev.count++;
        prev.lastAt = now;
        return;
      }
      this._selectorMisses.push({ key, scope: sc, selector: sel, count: 1, firstAt: now, lastAt: now });
      if (this._selectorMisses.length > 40) this._selectorMisses.splice(0, this._selectorMisses.length - 40);
    },

    /**
     * querySelectorAll that notices when a selector has gone dead.
     *
     * `expectMatch` is the whole design. A selector matching nothing is
     * usually CORRECT -- there is no miniplayer on a page with no video, no
     * playlist rows outside a playlist. Only a caller that knows the elements
     * should exist right now passes true. Reporting every empty query would
     * bury the real signal in noise, and a noisy signal gets ignored, which is
     * exactly how the CI badge stopped meaning anything.
     *
     * @param {ParentNode} root
     * @param {string} selector
     * @param {string} scope      module id, so a miss names its owner
     * @param {boolean} expectMatch
     * @returns {Array|NodeList}
     */
    queryExpected(root, selector, scope, expectMatch) {
      let out = [];
      try {
        out = (root && root.querySelectorAll) ? root.querySelectorAll(selector) : [];
      } catch (e) {
        this.reportError(scope, e);
        return [];
      }
      if (expectMatch && (!out || out.length === 0)) this.reportSelectorMiss(scope, selector);
      return out;
    },

    /** Keep failures visible without allowing one noisy module to flood logs. */
    reportError(scope, error) {
      const message = String((error && error.message) || error || 'unknown error').slice(0, 500);
      const key = String(scope || 'core') + ':' + message;
      const now = Date.now();
      const prev = this._errors.find((entry) => entry.key === key);
      if (prev && now - prev.lastAt < 30000) {
        prev.count++;
        prev.lastAt = now;
        return;
      }
      const entry = { key, scope: String(scope || 'core'), message, count: 1, firstAt: now, lastAt: now };
      this._errors.push(entry);
      if (this._errors.length > 40) this._errors.splice(0, this._errors.length - 40);
      try { console.warn('[Unsynth][' + entry.scope + ']', error); } catch (e) { /* console unavailable */ }
    },

    /**
     * Run one module's scan outside the shared loop (lazy registration after
     * start()) while keeping the timing samples and the data-unsynth-scans
     * diagnostic in step with a normal scan pass.
     */
    noteModuleScan(mod) {
      if (!mod || !mod.scan) return;
      const startedAt = performance.now();
      try {
        mod.scan();
      } catch (e) {
        this.reportError(mod.id + '.scan', e);
      } finally {
        const values = this._moduleScanSamples.get(mod.id) || [];
        values.push(performance.now() - startedAt);
        if (values.length > 120) values.splice(0, values.length - 120);
        this._moduleScanSamples.set(mod.id, values);
        bumpScanCount();
      }
    },

    diagnostics() {
      const samples = this._scanSamples.slice();
      const sorted = samples.slice().sort((a, b) => a - b);
      const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
      const moduleScans = Array.from(this._moduleScanSamples.entries()).map(([id, values]) => {
        const ordered = values.slice().sort((a, b) => a - b);
        const moduleP95 = ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))] : 0;
        return {
          id,
          totalMs: Math.round(values.reduce((sum, n) => sum + n, 0) * 100) / 100,
          p95Ms: Math.round(moduleP95 * 100) / 100,
          maxMs: ordered.length ? Math.round(ordered[ordered.length - 1] * 100) / 100 : 0
        };
      }).sort((a, b) => b.totalMs - a.totalMs);
      return {
        version: (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '',
        host: this.host,
        modules: this.modules.map((m) => ({ id: m.id, enabled: this.isModuleEnabled(m), initialized: !!m._inited })),
        scans: scanCount,
        scanTotalMs: Math.round(samples.reduce((sum, n) => sum + n, 0) * 100) / 100,
        scanP95Ms: Math.round(p95 * 100) / 100,
        scanMaxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
        moduleScans,
        errors: this._errors.map((e) => Object.assign({}, e)),
        selectorMisses: this._selectorMisses.map((e) => Object.assign({}, e))
      };
    },

    /** Register a feature module. Called by each module file at load. */
    register(mod) {
      if (!mod || !mod.id) return;
      const existing = this._moduleIds.get(mod.id);
      if (existing) return existing;
      this._moduleIds.set(mod.id, mod);
      this.modules.push(mod);
      // Phase 2: lazy content scripts register AFTER start() has already run.
      // Init them on the spot so ordering between the static core block and the
      // dynamically-injected module scripts doesn't matter.
      if (this._started && mod.init && !mod._inited && this.isModuleEnabled(mod)) {
        try {
          mod.init(this);
          mod._inited = true;
          if (mod.scan) {
            // Route through the shared counter rather than calling mod.scan()
            // straight. Every feature module is injected lazily via
            // chrome.scripting and therefore lands here, so a direct call meant
            // data-unsynth-scans could stay null on a page where modules had in
            // fact scanned — destroying the one diagnostic that separates "the
            // filter ran and matched nothing" from "the filter never ran".
            this.noteModuleScan(mod);
          }
        } catch (e) {
          mod._inited = false;
          this.reportError(mod.id + '.init', e);
        }
      }
      return mod;
    },

    /** A module is active if its `moduleKey` is not explicitly disabled. */
    isModuleEnabled(mod) {
      if (!mod.moduleKey) return true;
      const mods = this.settings.modules || {};
      return mods[mod.moduleKey] !== false;
    },

    /** Open the suite dashboard in a tab (Atlas blocks target=_blank chrome-extension links). */
    openDashboard(hash) {
      const h = String(hash || '').replace(/^#/, '');
      try {
        chrome.runtime.sendMessage({
          type: 'UNSYNTH/OPEN_EXT_PAGE',
          path: 'src/dashboard/dashboard.html',
          hash: h
        });
      } catch (e) {
        /* ignore */
      }
    },

    /** Mount injected guide UI near the top of YouTube's sidebar (not the bottom). */
    insertGuideBlock(sections, box) {
      if (!sections || !box) return;
      // The sidebar hub owns subs + playlists; Forge keeps its own guide block.
      const order = ['un-sidebar-hub', 'un-forge-guide'];
      const idx = order.indexOf(box.id);
      let anchor = null;
      if (idx > 0) {
        for (let i = idx - 1; i >= 0; i--) {
          const prev = document.getElementById(order[i]);
          if (prev) {
            anchor = prev;
            break;
          }
        }
      }
      if (!anchor) anchor = sections.querySelector('ytd-guide-section-renderer, tp-yt-paper-section');
      if (anchor) anchor.insertAdjacentElement('afterend', box);
      else sections.prepend(box);
    },

    /**
     * Shared YouTube masthead slot for watched filters, Select, Forge, etc.
     * Sole owner of the masthead DOM — masthead-slot.js delegates here. Always
     * keeps #un-watched-feed-toggle before #un-synth-masthead-extra and fires
     * `unsynth-masthead-ready` when it first builds the shell.
     */
    ensureMastheadShell() {
      const anchor =
        document.querySelector('ytd-masthead #end #buttons') ||
        document.querySelector('ytd-masthead #end') ||
        document.querySelector('#masthead #end');
      if (!anchor) return null;

      let shell = document.getElementById('un-synth-masthead-bar');
      let created = false;
      // getElementById searches the WHOLE document, so a shell YouTube tore out
      // with its old #buttons container is still found here -- present in the
      // tree, absent from the live anchor. Without this check the `!shell`
      // branch is false, nothing re-attaches it, and the masthead bar silently
      // vanishes until a full reload. That is the reported disappearing-bar
      // bug. The same guard already existed one variable down for `extra`.
      if (shell && !anchor.contains(shell)) {
        anchor.insertBefore(shell, anchor.firstChild);
      } else if (!shell) {
        shell = document.createElement('div');
        shell.id = 'un-synth-masthead-bar';
        shell.className = 'un-synth-masthead-bar';
        anchor.insertBefore(shell, anchor.firstChild);
        created = true;
      }

      let extra = document.getElementById('un-synth-masthead-extra');
      let bar = document.getElementById('un-watched-feed-toggle');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'un-watched-feed-toggle';
        bar.className = 'un-watched-feed-toggle';
        if (extra && extra.parentElement === shell) shell.insertBefore(bar, extra);
        else shell.insertBefore(bar, shell.firstChild);
      }
      if (!extra) {
        extra = document.createElement('div');
        extra.id = 'un-synth-masthead-extra';
        extra.className = 'un-synth-masthead-extra';
        shell.appendChild(extra);
      } else if (extra.parentElement !== shell) {
        shell.appendChild(extra);
      }
      // Watched bar must sit before the extra-actions container.
      if (bar.nextElementSibling !== extra) shell.insertBefore(bar, extra);

      if (created) {
        this._watchMastheadOverflow(shell);
        try {
          document.dispatchEvent(new CustomEvent('unsynth-masthead-ready', { detail: { shell, bar, extra } }));
        } catch (e) {
          /* ignore */
        }
      }
      return { shell, bar, extra };
    },

    /**
     * The masthead bar is capped at calc(100vw - 860px) with overflow-x: auto
     * and the scrollbar suppressed, so on a narrow window chips scroll out of
     * sight with nothing on screen saying so — the bar just looks like it has
     * fewer filters than it has, and the ones past the edge are undiscoverable.
     *
     * Toggles edge classes so CSS can fade whichever side has content past it.
     * Class writes are guarded on change: this fires on every scroll frame, and
     * an unconditional write invalidates style on each one.
     *
     * @param {HTMLElement} shell The masthead shell element.
     * @returns {void}
     */
    _watchMastheadOverflow(shell) {
      if (!shell || shell._unOverflowWatched) return;
      shell._unOverflowWatched = true;
      const sync = () => {
        // 1px of slack: sub-pixel layout leaves scrollWidth a hair over
        // clientWidth on bars that are not actually overflowing, which would
        // paint a permanent fade over the last chip.
        const overflowing = shell.scrollWidth - shell.clientWidth > 1;
        const atStart = shell.scrollLeft <= 1;
        const atEnd = shell.scrollLeft >= shell.scrollWidth - shell.clientWidth - 1;
        const start = overflowing && !atStart;
        const end = overflowing && !atEnd;
        if (shell.classList.contains('un-mb-fade-start') !== start) {
          shell.classList.toggle('un-mb-fade-start', start);
        }
        if (shell.classList.contains('un-mb-fade-end') !== end) {
          shell.classList.toggle('un-mb-fade-end', end);
        }
      };
      let queued = false;
      const schedule = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          sync();
        });
      };
      shell.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
      // Chips are added and removed by four different modules as the user
      // navigates, so width changes without a scroll or a resize.
      if (typeof ResizeObserver === 'function') {
        try {
          new ResizeObserver(schedule).observe(shell);
        } catch (e) {
          /* ignore — scroll/resize still cover the common cases */
        }
      }
      if (typeof MutationObserver === 'function') {
        try {
          new MutationObserver(schedule).observe(shell, { childList: true, subtree: true });
        } catch (e) {
          /* ignore */
        }
      }
      schedule();
    },

    /** True when the extension context is still valid (not orphaned after reload). */
    isContextValid() {
      try {
        return !!chrome.runtime?.id;
      } catch (e) {
        return false;
      }
    },

    /** Show a fixed banner when content scripts are orphaned after an extension update. */
    showStaleBanner() {
      if (this._staleShown || document.getElementById('unsynth-stale-banner')) return;
      this._staleShown = true;
      try {
        document.documentElement.dataset.unsynthStale = '1';
        const b = document.createElement('div');
        b.id = 'unsynth-stale-banner';
        b.className = 'unsynth-stale-banner';
        const msg = document.createElement('span');
        msg.textContent = 'Unsynth updated — reload this tab to resume tracking.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Reload tab';
        btn.addEventListener('click', () => location.reload());
        b.appendChild(msg);
        b.appendChild(btn);
        document.documentElement.appendChild(b);
      } catch (e) {
        /* ignore */
      }
    },

    /**
     * Send a chrome.runtime message and return a Promise that resolves with the
     * response. Resolves null when the extension context is invalid (orphaned
     * content script) or when chrome.runtime.lastError is set, rather than
     * throwing — callers can treat null as a safe no-op.
     *
     * @param {string} type   The message `type` field.
     * @param {Object} [extra] Additional fields merged into the message object.
     * @returns {Promise<Object|null>}
     */
    send(type, extra) {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            Object.assign({ type: type }, extra || {}),
            (r) => {
              if (chrome.runtime.lastError) { resolve(null); return; }
              resolve(r || null);
            }
          );
        } catch (e) {
          resolve(null);
        }
      });
    },

    /** Tiny DOM builder — one shared copy instead of one per module. */
    el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },

    /** True on a watch or Shorts page (Shorts count as watch contexts). */
    isWatch() {
      // Channel live URLs (/@x/live) are watch pages too; yt-dom owns the rule.
      if (window.UNYtDom && window.UNYtDom.isWatchPage) return window.UNYtDom.isWatchPage(location.pathname);
      return location.pathname === '/watch' || location.pathname.indexOf('/shorts/') === 0;
    },

    /** Current video id from /watch?v= or /shorts/<id>, or null. */
    videoId() {
      const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
      if (m) return m[1];
      const q = new URLSearchParams(location.search).get('v');
      if (q && /^[\w-]{11}$/.test(q)) return q;
      // A channel live URL has no ?v=; the watch element carries the id.
      const live = window.UNYtDom && window.UNYtDom.liveChannelVideoId ? window.UNYtDom.liveChannelVideoId() : '';
      return live || null;
    },

    /**
     * Shared toast/OSD so every module's notifications look identical.
     * opts: { duration (ms, 0 = sticky), id, buttons: [{label, onClick}] }.
     * Returns the toast element (callers may remove() it early).
     */
    showToast(message, opts) {
      opts = opts || {};
      const id = opts.id || 'un-core-toast';
      const old = document.getElementById(id);
      if (old) old.remove();
      const t = this.el('div', 'un-toast');
      t.id = id;
      t.setAttribute('role', 'status');
      (opts.buttons || []).forEach((b) => {
        const btn = this.el('button', 'un-toast-btn', b.label);
        btn.type = 'button';
        btn.addEventListener('click', () => {
          try {
            if (b.onClick) b.onClick();
          } finally {
            t.remove();
          }
        });
        t.appendChild(btn);
      });
      // Attach inside the fullscreen element when active, else the toast is invisible.
      (document.fullscreenElement || document.body).appendChild(t);
      // The message goes in AFTER the region is in the document, not before.
      // role="status" is a live region, and a live region that is inserted with
      // its text already present is commonly not announced at all — the screen
      // reader has nothing to observe changing. Demonstrated in a browser: the
      // old ordering had textContent "Added to queue" at the moment of
      // insertion; this ordering inserts empty and mutates on the next frame.
      // (The DOM sequence is measured; the announcement itself needs real
      // assistive tech to confirm and has not been.)
      const msg = this.el('span', 'un-toast-msg', '');
      t.insertBefore(msg, t.firstChild);
      requestAnimationFrame(() => {
        msg.textContent = message;
        t.classList.add('un-toast-show');
      });
      const dur = opts.duration == null ? 2200 : opts.duration;
      if (dur > 0) {
        setTimeout(() => {
          t.classList.remove('un-toast-show');
          setTimeout(() => t.remove(), 220);
        }, dur);
      }
      return t;
    },

    /**
     * Register a button in YouTube's player right-controls with stable ordering
     * (lower `priority` = further left). Safe to call repeatedly from scan():
     * it no-ops when the buttons are already present and in order.
     * spec: { id, svg, title, ariaLabel, onClick, cls, priority }
     */
    addPlayerButton(spec) {
      if (!spec || !spec.id) return null;
      if (!this._playerBtns) this._playerBtns = new Map();
      this._playerBtns.set(spec.id, spec);
      return this._flushPlayerButtons(spec.id);
    },

    /** Remove a registered player button (module teardown). */
    removePlayerButton(id) {
      if (this._playerBtns) this._playerBtns.delete(id);
      const btn = document.getElementById(id);
      if (btn) btn.remove();
      // If this button was currently collapsed into the overflow menu (see
      // _collapseOverflowingButtons), drop its shadow menu entry too —
      // otherwise it lingers in the "Unsynth tools" menu pointing at a
      // module that already tore itself down.
      if (this._collapsedBtnIds && this._collapsedBtnIds.has(id)) {
        this._collapsedBtnIds.delete(id);
        this.removeMenuItem('overflow:' + id);
      }
    },

    /** Build (but don't insert) a `.ytp-button` element from an addPlayerButton spec. */
    _buildPlayerButtonEl(spec) {
      const btn = document.createElement('button');
      btn.id = spec.id;
      btn.className = 'ytp-button' + (spec.cls ? ' ' + spec.cls : '');
      btn.title = spec.title || '';
      btn.setAttribute('aria-label', spec.ariaLabel || spec.title || '');
      // Module-authored static SVG markup only — never user/remote content.
      btn.innerHTML = spec.svg || '';
      if (spec.onClick) btn.addEventListener('click', spec.onClick);
      return btn;
    },

    _flushPlayerButtons(returnId) {
      // Re-entrancy guard — _collapseOverflowingButtons() below can call
      // addMenuItem(), which calls _ensureMenuButton() -> addPlayerButton()
      // -> back into this same function. Without the guard that's a nested
      // re-entrant call mid-layout-measurement; with it, the nested call is
      // a harmless no-op (it still registers the spec in _playerBtns — the
      // actual DOM insertion for it is handled explicitly inside
      // _collapseOverflowingButtons instead, synchronously, in the same pass).
      if (this._flushingPlayerButtons) return returnId ? document.getElementById(returnId) : null;
      const host =
        (window.UNYtDom && typeof UNYtDom.playerControlsHost === 'function' && UNYtDom.playerControlsHost()) ||
        document.querySelector('#movie_player .ytp-right-controls') ||
        document.querySelector('.ytp-right-controls');
      if (!host || !this._playerBtns || !this._playerBtns.size) return null;
      this._flushingPlayerButtons = true;
      try {
        // Restore anything previously collapsed into the overflow menu due
        // to a narrow player, so every flush re-measures against the FULL
        // desired set — widening the player (resize, exiting theater, etc.)
        // should bring buttons back out of the menu, not strand them there.
        // Deliberately NOT routed through removeMenuItem() here: that
        // cascades into removing the menu launcher button itself the moment
        // the menu empties out mid-restore, which would then need
        // recreating a few lines later if collapsing turns out still
        // necessary — churn with no benefit. A single "is the menu now
        // empty" check happens once, after collapsing, at the end instead.
        if (this._collapsedBtnIds && this._collapsedBtnIds.size) {
          if (this._menuItems) {
            for (const id of this._collapsedBtnIds) this._menuItems.delete('overflow:' + id);
          }
          this._collapsedBtnIds.clear();
          this._renderMenu();
        }
        // Ascending priority = desired left-to-right order at the head of the bar.
        const specs = Array.from(this._playerBtns.values()).sort((a, b) => (a.priority || 50) - (b.priority || 50));
        const inOrder = specs.every((spec, i) => host.children[i] && host.children[i].id === spec.id);
        if (!inOrder) {
          // Insert in reverse so each insertBefore(firstChild) lands ascending.
          for (let i = specs.length - 1; i >= 0; i--) {
            const spec = specs[i];
            const btn = document.getElementById(spec.id) || this._buildPlayerButtonEl(spec);
            host.insertBefore(btn, host.firstChild);
          }
        }
        this._collapseOverflowingButtons(host, specs);
        // If collapsing emptied the menu back out (nothing left to show —
        // e.g. this page never overflowed and no module has its own
        // deliberate addMenuItem() entry), drop the launcher too rather
        // than leaving a button that opens an empty menu.
        if (this._menuItems && !this._menuItems.size && document.getElementById('un-menu-btn')) {
          this._removeMenuButton();
        }
        // Same diagnostic-attribute convention as data-unsynth-scans /
        // data-unsynth-scan-ms below — a live/e2e check (or a human in
        // DevTools) can read exactly which buttons are currently collapsed
        // into the overflow menu via plain DOM, no isolated-world access
        // to this object needed.
        try {
          const collapsedIds = this._collapsedBtnIds ? Array.from(this._collapsedBtnIds) : [];
          document.documentElement.setAttribute('data-unsynth-player-btns-collapsed', collapsedIds.join(','));
        } catch (e) { /* diagnostics are best effort */ }
      } finally {
        this._flushingPlayerButtons = false;
      }
      return returnId ? document.getElementById(returnId) : null;
    },

    /**
     * With every player-button module on by default (see defaults.js), a
     * fresh install can register 6-7 Unsynth buttons at once on top of
     * YouTube's own ~5 native ones — confirmed live to visibly overrun the
     * control bar (icons crushed together, the rightmost ones clipped past
     * the player's edge) at realistic player widths, not just extreme ones.
     * Rather than hand-picking which modules "deserve" a permanent slot
     * (fragile — the right answer depends on the player's actual width,
     * which this can't know statically), collapse the lowest-priority
     * (rightmost) Unsynth buttons into the existing overflow menu, one at a
     * time, until the bar actually fits. Never collapses the menu launcher
     * itself or a module's OWN deliberate addMenuItem() placement.
     */
    _collapseOverflowingButtons(host, specs) {
      if (!host.isConnected) return;
      if (!this._collapsedBtnIds) this._collapsedBtnIds = new Set();
      // Whether `host` itself clips overflowing content (scrollWidth check)
      // or is unconstrained-width and instead pushes the whole control bar
      // past the player's own edge (bounding-rect check) depends on
      // YouTube's current CSS, which changes across layout versions — check
      // both rather than betting on one. #movie_player is the outermost
      // element scroll-miniplayer.js already treats as the player's true
      // boundary; reuse that same anchor here.
      const boundary = document.getElementById('movie_player');
      const overflowing = () => {
        if (host.scrollWidth > host.clientWidth + 1) return true;
        if (!boundary) return false;
        const hostRect = host.getBoundingClientRect();
        const boundaryRect = boundary.getBoundingClientRect();
        return hostRect.right > boundaryRect.right + 1 || hostRect.left < boundaryRect.left - 1;
      };
      let guard = 0;
      while (guard++ < specs.length && overflowing()) {
        let victim = null;
        for (let i = specs.length - 1; i >= 0; i--) {
          const spec = specs[i];
          if (spec.id === 'un-menu-btn' || this._collapsedBtnIds.has(spec.id)) continue;
          victim = spec;
          break;
        }
        if (!victim) break;
        const btn = document.getElementById(victim.id);
        if (btn) btn.remove();
        this._collapsedBtnIds.add(victim.id);
        this.addMenuItem({
          id: 'overflow:' + victim.id,
          svg: victim.svg,
          label: victim.title || victim.ariaLabel || victim.id,
          onClick: victim.onClick,
          priority: victim.priority
        });
        // addMenuItem() above may have registered 'un-menu-btn' in
        // _playerBtns for the first time this pass (via _ensureMenuButton),
        // but the re-entrant addPlayerButton -> _flushPlayerButtons call it
        // triggers is a guarded no-op (see _flushPlayerButtons) and never
        // actually inserts it. Do that insertion here, synchronously, so
        // the NEXT width measurement in this same loop correctly accounts
        // for the launcher's own space instead of converging one scan late.
        if (this._playerBtns.has('un-menu-btn') && !document.getElementById('un-menu-btn')) {
          host.appendChild(this._buildPlayerButtonEl(this._playerBtns.get('un-menu-btn')));
        }
      }
    },

    /**
     * Overflow menu — a single "Unsynth" player button that opens a small
     * dropdown listing less-frequently-used actions, instead of every
     * module claiming its own permanent icon in the player bar. Reach for
     * this for occasional actions (export, submit, capture-to-file); keep
     * addPlayerButton() for the few genuinely high-frequency, single-tap
     * controls (seek, screenshot, view-mode toggles).
     * spec: { id, svg, label, onClick, priority }
     */
    addMenuItem(spec) {
      if (!spec || !spec.id) return;
      if (!this._menuItems) this._menuItems = new Map();
      this._menuItems.set(spec.id, spec);
      this._ensureMenuButton();
      this._renderMenu();
    },

    /** Remove a registered menu item (module teardown). */
    removeMenuItem(id) {
      if (this._menuItems) this._menuItems.delete(id);
      this._renderMenu();
      if (this._menuItems && !this._menuItems.size) this._removeMenuButton();
    },

    _ensureMenuButton() {
      const MENU_SVG =
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
        '<circle cx="5" cy="12" r="2" fill="currentColor"/>' +
        '<circle cx="12" cy="12" r="2" fill="currentColor"/>' +
        '<circle cx="19" cy="12" r="2" fill="currentColor"/>' +
        '</svg>';
      this.addPlayerButton({
        id: 'un-menu-btn',
        svg: MENU_SVG,
        title: 'Unsynth tools',
        ariaLabel: 'Open Unsynth tools menu',
        onClick: () => this._toggleMenu(),
        cls: 'un-menu-btn',
        priority: 60
      });
    },

    _removeMenuButton() {
      this._closeMenu();
      this.removePlayerButton('un-menu-btn');
    },

    _toggleMenu() {
      if (document.getElementById('un-menu-dropdown')) this._closeMenu();
      else this._openMenu();
    },

    _openMenu() {
      const btn = document.getElementById('un-menu-btn');
      if (!btn) return;
      const dropdown = document.createElement('div');
      dropdown.id = 'un-menu-dropdown';
      dropdown.className = 'un-menu-dropdown';
      this._renderMenuInto(dropdown);
      document.body.appendChild(dropdown);
      this._positionMenu(dropdown, btn);
      const onDocClick = (e) => {
      // Not a user dismissal -- see queue-advance.js docClickHandler.
      if (e && e.isTrusted === false) return;
        if (!dropdown.contains(e.target) && e.target !== btn) this._closeMenu();
      };
      const onResize = () => this._positionMenu(dropdown, btn);
      this._menuDocClick = onDocClick;
      this._menuResize = onResize;
      // Deferred one tick so the click that OPENED the menu doesn't also
      // immediately close it via this same document-level listener.
      setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
      window.addEventListener('resize', onResize);
      this._menuPanelHandle = this.pushPanel(() => this._closeMenu());
    },

    _closeMenu() {
      const dropdown = document.getElementById('un-menu-dropdown');
      if (dropdown) dropdown.remove();
      if (this._menuDocClick) {
        document.removeEventListener('click', this._menuDocClick, true);
        this._menuDocClick = null;
      }
      if (this._menuResize) {
        window.removeEventListener('resize', this._menuResize);
        this._menuResize = null;
      }
      if (this._menuPanelHandle) {
        this.popPanel(this._menuPanelHandle);
        this._menuPanelHandle = null;
      }
    },

    _positionMenu(dropdown, btn) {
      const r = btn.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.bottom = window.innerHeight - r.top + 8 + 'px';
      dropdown.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    },

    _renderMenu() {
      const dropdown = document.getElementById('un-menu-dropdown');
      if (dropdown) this._renderMenuInto(dropdown);
    },

    _renderMenuInto(dropdown) {
      dropdown.innerHTML = '';
      if (!this._menuItems || !this._menuItems.size) return;
      const items = Array.from(this._menuItems.values()).sort((a, b) => (a.priority || 50) - (b.priority || 50));
      items.forEach((spec) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.id = 'un-menu-item-' + spec.id;
        row.className = 'un-menu-item';
        // Icon: module-authored static SVG only, same trust boundary as
        // addPlayerButton's svg field — never user/remote content. Label:
        // always textContent, never innerHTML, so this stays safe even if a
        // future caller ever passes something other than a hardcoded
        // string literal (unlike svg, a label has no established
        // static-only convention to lean on).
        const icon = document.createElement('span');
        icon.className = 'un-menu-item-icon';
        icon.innerHTML = spec.svg || '';
        const label = document.createElement('span');
        label.textContent = spec.label || '';
        row.appendChild(icon);
        row.appendChild(label);
        row.addEventListener('click', (e) => {
          this._closeMenu();
          if (spec.onClick) spec.onClick(e);
        });
        dropdown.appendChild(row);
      });
    },

    /**
     * LIFO Escape stack — when several injected panels are open, Esc closes the
     * most recently opened one only (instead of every panel's own keydown
     * listener firing at once). pushPanel returns a handle for popPanel.
     */
    pushPanel(onEscape) {
      if (!this._escStack) this._escStack = [];
      const handle = { fn: onEscape };
      this._escStack.push(handle);
      if (!this._escBound) {
        this._escBound = true;
        document.addEventListener(
          'keydown',
          (e) => {
            if (e.key !== 'Escape' || !this._escStack.length) return;
            if (document.fullscreenElement) return; // let YouTube exit fullscreen first
            const top = this._escStack[this._escStack.length - 1];
            e.preventDefault();
            e.stopPropagation();
            try {
              top.fn();
            } catch (err) {
              /* isolate */
            }
          },
          true
        );
      }
      return handle;
    },

    popPanel(handle) {
      if (!this._escStack) return;
      const i = this._escStack.indexOf(handle);
      if (i !== -1) this._escStack.splice(i, 1);
    },

    /** Run fn; show stale banner if extension context was invalidated. */
    guardExtension(fn) {
      if (!this.isContextValid()) {
        this.showStaleBanner();
        return false;
      }
      try {
        fn();
        return true;
      } catch (e) {
        if (String(e).indexOf('Extension context invalidated') !== -1 || String(e).indexOf('context invalidated') !== -1) {
          this.showStaleBanner();
        }
        return false;
      }
    }
  };
  window.UNSYNTH = core;

  // ---- shared debounced scan ----
  let scanTimer = null;
  let scanCount = 0;
  let pendingScanWhileHidden = false;
  // Backstop for a scan deferred because the page was hidden. Cheap (one
  // visibility check per tick) and self-cancelling the moment a scan lands.
  let hiddenScanTimer = null;
  // Starts at 1s so a page revealed almost immediately converges fast, then
  // backs off to a 30s ceiling. A flat 1s poll on a tab left hidden for hours
  // is thousands of pointless wake-ups, each one a timer the browser has to
  // service on a page the user is not looking at.
  const HIDDEN_SCAN_RETRY_MS = 1000;
  const HIDDEN_SCAN_RETRY_MAX_MS = 30000;
  let hiddenScanDelay = HIDDEN_SCAN_RETRY_MS;
  /** Single writer for the scan diagnostic, shared by runScan and noteModuleScan. */
  function bumpScanCount() {
    scanCount++;
    try {
      document.documentElement.setAttribute('data-unsynth-scans', String(scanCount));
    } catch (e) {
      /* diagnostics are best effort */
    }
  }
  function clearHiddenScanRetry() {
    hiddenScanDelay = HIDDEN_SCAN_RETRY_MS;
    if (hiddenScanTimer) {
      clearTimeout(hiddenScanTimer);
      hiddenScanTimer = null;
    }
  }
  function armHiddenScanRetry() {
    if (hiddenScanTimer) return;
    hiddenScanTimer = setTimeout(function retry() {
      hiddenScanTimer = null;
      if (!pendingScanWhileHidden) return;
      if (document.hidden) {
        hiddenScanDelay = Math.min(hiddenScanDelay * 2, HIDDEN_SCAN_RETRY_MAX_MS);
        armHiddenScanRetry();
        return;
      }
      runScan();
    }, hiddenScanDelay);
  }
  // Watch/shorts pages mutate constantly (progress, ads, related). Prefer a
  // longer coalesce window there so module scans don't compete with decode.
  function scanDelayMs() {
    const p = location.pathname || '';
    if (p === '/watch' || p.indexOf('/shorts/') === 0) return 700;
    return 300;
  }
  /**
   * True when `node` sits inside a subtree Unsynth itself injected (a toast,
   * a panel, a button, an overlay) — used to stop the shared scan from
   * re-triggering on its own DOM writes. Several modules (ui-tune.js,
   * scroll-miniplayer.js, sidebar-hub.js, watch-history.js, playlist-bulk.js,
   * sub-manager.js, ai-assistant.js) also toggle plain `un-*` FEATURE-FLAG
   * classes directly on <html>/<body> for page-wide CSS state — those are
   * not injected UI and must not count here. Since every element on the
   * page is a descendant of <html>, letting closest() walk that far turns
   * "this page has ANY un-* class on <html> or <body>" into "every mutation
   * everywhere is inside an Unsynth node", which silently disables the scan
   * for the rest of the page's life the moment any such class is set —
   * confirmed live: ui-tune.js's un-hide-shorts class on <html> made
   * hasRelevantMutation() return false for a plain, unrelated <div> append
   * elsewhere in the document. Stop one level short of the document root so
   * only genuine injected subtrees (which are never <html> or <body>
   * itself) match.
   */
  function isUnsynthNode(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return false;
    const match = el.closest('[id^="un-"], #unsynth-scan, [class^="un-"], [class*=" un-"]');
    return !!match && match !== document.documentElement && match !== document.body;
  }
  function hasRelevantMutation(records) {
    if (!records || !records.length) return true;
    return records.some((record) => {
      if (!isUnsynthNode(record.target)) return true;
      return Array.prototype.some.call(record.addedNodes || [], (node) => !isUnsynthNode(node));
    });
  }
  function scheduleScan(records) {
    if (!hasRelevantMutation(records)) return;
    // Fullscreen playback covers the whole page with the player: no feed tile,
    // sidebar row or masthead control is on screen, so every module's scan is
    // decorating DOM nobody can see. The player itself keeps mutating
    // throughout (progress bar, time readout, controls fading in and out), and
    // each of those passes hasRelevantMutation because they are not our nodes.
    //
    // Deferred rather than dropped, exactly like the hidden-tab path above:
    // exiting fullscreen fires no mutation of its own on a paused video, so
    // without the pending flag the feed could stay undecorated until something
    // else happened to change. `fullscreenchange` re-runs it (see below).
    //
    // Honest note: this was investigated for a report of lag on a large TV in
    // fullscreen, and it is NOT confirmed to be that cause — measured headless,
    // fullscreen actually scanned LESS than windowed (1 vs 2 in 12s) and no
    // Unsynth layer was found painting or blurring on screen. It is kept
    // because doing feed work while the feed is invisible is wasted work
    // regardless of whether it is the reported symptom.
    if (document.fullscreenElement) {
      pendingScanWhileHidden = true;
      return;
    }
    if (document.hidden) {
      pendingScanWhileHidden = true;
      armHiddenScanRetry();
      return;
    }
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      runScan();
    }, scanDelayMs());
  }
  function runScan() {
    // Same reasoning as scheduleScan: nothing we decorate is on screen while
    // the player owns the whole viewport. Guarded here too because runScan is
    // also reached from the timer that scheduleScan already armed and from
    // core.runModuleScan, not only through that one gate.
    if (document.fullscreenElement) {
      pendingScanWhileHidden = true;
      return;
    }
    if (document.hidden) {
      // Deferred, not dropped. The only wake-ups are a visibilitychange event
      // and the next relevant mutation, and neither is guaranteed: a prerender
      // activation or bfcache restore can reveal the page without dispatching
      // visibilitychange to this document, and a feed that finished rendering
      // while the tab was still hidden produces no further mutations. Poll the
      // deferred scan so a page that booted hidden always converges instead of
      // sitting there with data-unsynth-ready=1 and no scan ever recorded.
      pendingScanWhileHidden = true;
      armHiddenScanRetry();
      return;
    }
    pendingScanWhileHidden = false;
    clearHiddenScanRetry();
    if (observer) observer.disconnect();
    const startedAt = performance.now();
    try {
      for (const mod of core.modules) {
        if (mod.scan && core.isModuleEnabled(mod)) {
          const moduleStartedAt = performance.now();
          try {
            mod.scan();
          } catch (e) {
            core.reportError(mod.id + '.scan', e);
          } finally {
            const values = core._moduleScanSamples.get(mod.id) || [];
            values.push(performance.now() - moduleStartedAt);
            if (values.length > 120) values.splice(0, values.length - 120);
            core._moduleScanSamples.set(mod.id, values);
          }
        }
      }
      bumpScanCount();
      // Player chrome mounts late on SPA navigations — retry registered buttons each scan.
      if (core._playerBtns && core._playerBtns.size) {
        try {
          core._flushPlayerButtons();
        } catch (e) {
          /* ignore */
        }
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      core._scanSamples.push(elapsed);
      if (core._scanSamples.length > 120) core._scanSamples.splice(0, core._scanSamples.length - 120);
      try {
        document.documentElement.setAttribute('data-unsynth-scan-ms', elapsed.toFixed(2));
        if (elapsed > 50) core.reportError('core.slow-scan', new Error('scan took ' + elapsed.toFixed(1) + 'ms'));
      } catch (e) { /* diagnostics are best effort */ }
      if (observer) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: false,
          characterData: false
        });
      }
    }
  }
  const observer = new MutationObserver(scheduleScan);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pendingScanWhileHidden) scheduleScan();
  });
  // Leaving fullscreen reveals the whole page at once. On a paused video that
  // produces no mutation of its own, so without this the feed would stay
  // undecorated until something unrelated changed.
  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement && pendingScanWhileHidden) scheduleScan();
  });

  // ---- SPA navigation ----
  function onNav() {
    for (const mod of core.modules) {
      if (mod.onNavigate && core.isModuleEnabled(mod)) {
        try {
          mod.onNavigate();
        } catch (e) {
          /* isolate */
        }
      }
    }
    scheduleScan();
  }

  // ---- lifecycle ----
  function isPlainObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  function deepMerge(target, source) {
    for (const key in source) {
      if (isPlainObject(source[key])) {
        if (!isPlainObject(target[key])) target[key] = {};
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  function loadSettings(cb) {
    chrome.storage.sync.get(DEFAULTS, (s) => {
      if (chrome.runtime.lastError) {
        core.reportError('core.settings', chrome.runtime.lastError);
        s = DEFAULTS;
      }
      core.settings = deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), s || {});
      if (window.UNModules) {
        core.settings.modules = UNModules.normalizeModules(core.settings.modules, DEFAULTS);
      }
      cb && cb();
    });
  }

  core.start = function start() {
    // Readiness marker on <html> — lets tests/pages detect the suite booted.
    try {
      document.documentElement.setAttribute('data-unsynth-suite', '1');
    } catch (e) {
      /* ignore */
    }
    loadSettings(() => {
      for (const mod of core.modules) {
        if (mod.init && !mod._inited && core.isModuleEnabled(mod)) {
          try {
            mod.init(core);
            mod._inited = true;
          } catch (e) {
            mod._inited = false;
            core.reportError(mod.id + '.init', e);
          }
        }
      }
      // Suite is live: any module registered from here on (lazy content scripts
      // injected via chrome.scripting) is initialised on the spot by register().
      core._started = true;
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false
      });
      runScan();
      onNav();
      try {
        document.documentElement.setAttribute('data-unsynth-ready', '1');
      } catch (e) {
        /* ignore */
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const keys = Object.keys(changes);
      if (keys.length === 1 && keys[0] === 'stats') return; // ignore stat-only writes
      // Snapshot which modules were active BEFORE the settings reload so we can
      // tear down any that were just switched off (otherwise their injected UI
      // lingers — scan/onSettings are skipped for disabled modules below).
      const wasEnabled = new Map();
      for (const mod of core.modules) wasEnabled.set(mod, core.isModuleEnabled(mod));
      loadSettings(() => {
        for (const mod of core.modules) {
          const nowOn = core.isModuleEnabled(mod);
          if (nowOn) {
            if (!mod._inited && mod.init) {
              // First time this module is enabled (it defaulted off, so init
              // never ran at startup) — lazily init it so its `core` is set.
              try {
                mod.init(core);
                mod._inited = true;
              } catch (e) {
                mod._inited = false;
                core.reportError(mod.id + '.init', e);
              }
            } else if (mod.onSettings) {
              try {
                mod.onSettings(core.settings);
              } catch (e) {
                core.reportError(mod.id + '.settings', e);
              }
            }
          } else if (wasEnabled.get(mod)) {
            // enabled -> disabled this change: let the module remove its UI.
            try {
              if (typeof mod.teardown === 'function') mod.teardown();
            } catch (e) {
              core.reportError(mod.id + '.teardown', e);
            }
            // A disabled module remains in the current isolated world even
            // after chrome.scripting unregisters it. Re-enable by running its
            // symmetric init path again instead of leaving listeners detached.
            mod._inited = false;
          }
        }
        runScan();
      });
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'unsynth-get-diagnostics') {
        sendResponse(core.diagnostics());
        return false;
      }
      // The worker skips reloading background video tabs on update, because a
      // reload would autoplay them. Show the in-page banner instead so the user
      // reloads on their own terms when they come back to the tab.
      if (msg && msg.type === 'unsynth-mark-stale') {
        core.showStaleBanner();
        sendResponse({ ok: true });
        return false;
      }
      let keepOpen = false;
      for (const mod of core.modules) {
        // Don't route messages to disabled modules (matches scan/onNavigate gating).
        if (mod.onMessage && core.isModuleEnabled(mod)) {
          try {
            if (mod.onMessage(msg, sendResponse) === true) keepOpen = true;
          } catch (e) {
            core.reportError(mod.id + '.message', e);
          }
        }
      }
      return keepOpen;
    });

    // YouTube fires yt-navigate-finish on document — bind only once here.
    document.addEventListener('yt-navigate-finish', onNav);
  };
})();
