/**
 * UNSidePanel — the one place depth opens on a watch page.
 *
 * THE RULE (decided with the owner, 2026-09-21): the deck under the video is the
 * at-a-glance strip — runtime hero, a one-line stats summary, fact-check
 * status, chapters and links. Anything with depth — the full stats grid,
 * compare, SEO, fact-check results, the AI assistant, Forge — opens HERE,
 * beside the video, so the video stays on screen while it is read.
 *
 * Before this, the same things lived in two or three places: a Stats card at
 * the top of the related column AND a Stats slot in the deck; two fixed
 * slide-outs (AI, Forge) that painted over that card; the date printed three
 * times. Each surface had its own shell, its own open state, its own escape
 * handling, its own pop-out (analytics cloned itself with every control
 * disabled). This is one shell, one open state, one escape, one pop-out that
 * moves the LIVE body rather than a dead copy.
 *
 * PLACEMENT
 *   docked   on /watch: first child of #secondary-inner, in document flow,
 *            sticky under the masthead so it stays beside the video while the
 *            page scrolls. Pushes related videos down — the user opened it.
 *   drawer   everywhere else (Forge works on any page): a fixed right-edge
 *            drawer with a backdrop, the shell Forge used to own by itself.
 *
 * A closed host renders nothing. It is opened from the deck's slot headers and
 * the masthead chips; a permanent tab strip over the related videos would be
 * a row spent saying that panels exist (DESIGN-STANDARD §1).
 *
 * API — modules call these; nothing here knows what a module renders.
 *   register({ id, label, order, onShow, onHide })   idempotent by id
 *   body(id)      the tab's body element, created on demand; null off-page
 *   open(id) · close() · toggle(id) · isOpen() · active() · placement()
 *   popOut(id) · popIn()
 * Fires 'unsynth-side-panel' on document with { open, id } after any change.
 */
(function (g) {
  'use strict';
  var HOST_ID = 'un-side-panel';
  var FLOAT_ID = 'un-side-panel-float';
  var tabs = {};          // id -> { id, label, order, onShow, onHide }
  var order = [];         // ids in display order
  var open = false;
  var activeId = null;
  var escHandle = null;
  var float = null;       // { el, id }
  var rebuildQueued = false;

  function doc() { return typeof document !== 'undefined' ? document : null; }
  function el(tag, cls, text) {
    var e = doc().createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  /**
   * 20px line icons at YouTube's own stroke weight, instead of the text
   * glyphs "⤢" and "×", which rendered at different optical sizes and
   * baselines depending on the font that happened to carry them.
   */
  var ICONS = {
    pop: 'M14 4h6v6M20 4l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5',
    close: 'M6 6l12 12M18 6L6 18',
    dock: 'M4 5h16v14H4zM14 5v14'
  };
  function icon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = doc().createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = doc().createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name]);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function onWatch() {
    return typeof location !== 'undefined' && ((window.UNYtDom && window.UNYtDom.isWatchLayout ? window.UNYtDom.isWatchLayout(location.pathname) : location.pathname === '/watch') || location.pathname.indexOf('/shorts/') === 0);
  }
  function placement() { return onWatch() ? 'docked' : 'drawer'; }

  function dockMount() {
    var d = doc();
    // Watch layout only: other pages keep a hidden #secondary in the DOM.
    var yd = typeof window !== 'undefined' ? window.UNYtDom : null;
    if (!yd || !yd.WATCH_SIDE_COLUMN_SEL) return null;
    return d.querySelector(yd.WATCH_SIDE_COLUMN_SEL) || d.querySelector(yd.WATCH_SIDE_OUTER_SEL) || null;
  }

  /**
   * The host element, built once and re-homed when YouTube rebuilds #secondary.
   *
   * KEPT AS A REFERENCE, not looked up by id: the first version built the
   * <aside> and then had place() and renderTabs() find it with
   * getElementById — before it was attached — so both returned early and
   * body() handed every module null (probed 2026-09-21). A detached element
   * is still ours; YouTube tearing #secondary down must not lose it either.
   */
  var hostEl = null;
  function host(create) {
    var d = doc();
    if (!d) return null;
    if (hostEl) return hostEl;
    var h = d.getElementById(HOST_ID);
    if (h) { hostEl = h; return h; }
    if (!create) return null;
    h = el('aside', 'un-sp');
    h.id = HOST_ID;
    h.setAttribute('role', 'region');
    h.setAttribute('aria-label', 'Unsynth panel');
    var bar = el('div', 'un-sp-bar');
    var list = el('div', 'un-sp-tabs');
    list.setAttribute('role', 'tablist');
    bar.appendChild(list);
    // The open tab's name, shown only when the doors above are the tabs.
    bar.appendChild(el('span', 'un-sp-title'));
    var acts = el('div', 'un-sp-acts');
    var pop = el('button', 'un-sp-pop');
    pop.appendChild(icon('pop'));
    pop.type = 'button';
    pop.title = 'Pop out';
    pop.setAttribute('aria-label', 'Pop the panel out into a floating window');
    pop.addEventListener('click', function () { popOut(activeId); });
    var close = el('button', 'un-sp-close');
    close.appendChild(icon('close'));
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the panel');
    close.addEventListener('click', function () { setOpen(false); });
    acts.appendChild(pop);
    acts.appendChild(close);
    bar.appendChild(acts);
    h.appendChild(bar);
    h.appendChild(el('div', 'un-sp-bodies'));
    var backdrop = el('div', 'un-sp-backdrop');
    backdrop.addEventListener('click', function () { setOpen(false); });
    h.appendChild(backdrop);
    // Tab key moves between tabs with the arrow keys, as a tablist should.
    list.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var i = order.indexOf(activeId);
      if (i === -1) return;
      var n = e.key === 'ArrowRight' ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
      e.preventDefault();
      select(order[n]);
      var b = list.querySelector('[data-tab="' + order[n] + '"]');
      if (b) b.focus();
    });
    hostEl = h;
    // Other modules read this to step back: the deck's Compare/Expand row is
    // the Stats tab now, so it hides when a host exists.
    try { d.documentElement.classList.add('un-sp-present'); } catch (e) { /* no document */ }
    return h;
  }

  /** Put the host where its placement says, if it is not already there. */
  function place() {
    var h = host(false);
    if (!h) return;
    var p = placement();
    h.classList.toggle('un-sp--docked', p === 'docked');
    h.classList.toggle('un-sp--drawer', p === 'drawer');
    // IN THE GUIDE when the guide is beside the video (2026-09-22): the doors
    // are the tabs, and the tab body opens right under them, in the same card,
    // in place of the chapters. One system instead of a strip, a second tab
    // bar and a stack of cards in the column.
    var guide = p === 'docked' ? doc().getElementById('un-watch-deck') : null;
    var inGuide = !!(guide && guide.classList.contains('is-side'));
    h.classList.toggle('un-sp--inguide', inGuide);
    if (inGuide) {
      var before = guide.querySelector(':scope > .un-deck-desc');
      if (h.parentElement !== guide || h.nextElementSibling !== before) guide.insertBefore(h, before);
    } else if (p === 'docked') {
      var m = dockMount();
      if (m && h.parentElement !== m) m.insertBefore(h, m.firstChild);
      else if (!m && h.parentElement !== doc().body) doc().body.appendChild(h);
    } else if (h.parentElement !== doc().body) {
      doc().body.appendChild(h);
    }
    syncRoles(h);
  }

  /**
   * In the guide the tab bar is hidden and the doors (aria-expanded buttons)
   * are the way in, so a body announced as "tab panel" would point at tabs
   * nobody can reach (a11y review D1, 2026-09-23). There each body is a
   * labelled region and the hidden tablist is out of the tree; elsewhere the
   * real tab pattern stands. aria-labelledby keeps naming the body from its
   * tab button: a hidden element still supplies an accessible name.
   */
  function syncRoles(h) {
    var inGuide = h.classList.contains('un-sp--inguide');
    var list = h.querySelector('.un-sp-tabs');
    if (list) {
      if (inGuide) list.setAttribute('aria-hidden', 'true');
      else list.removeAttribute('aria-hidden');
    }
    var bodies = h.querySelectorAll('.un-sp-bodies > .un-sp-body');
    for (var i = 0; i < bodies.length; i++) bodies[i].setAttribute('role', inGuide ? 'region' : 'tabpanel');
  }

  function renderTabs() {
    var h = host(false);
    if (!h) return;
    var list = h.querySelector('.un-sp-tabs');
    var bodies = h.querySelector('.un-sp-bodies');
    order.forEach(function (id) {
      var t = tabs[id];
      var b = list.querySelector('[data-tab="' + id + '"]');
      if (!b) {
        b = el('button', 'un-sp-tab', t.label);
        b.type = 'button';
        b.dataset.tab = id;
        b.setAttribute('role', 'tab');
        b.id = HOST_ID + '-tab-' + id;
        b.setAttribute('aria-controls', HOST_ID + '-body-' + id);
        b.addEventListener('click', function () { select(id); });
        list.appendChild(b);
      } else {
        list.appendChild(b); // keep display order after late registrations
      }
      var body = bodies.querySelector('[data-tab="' + id + '"]');
      if (!body) {
        body = el('div', 'un-sp-body');
        body.dataset.tab = id;
        body.id = HOST_ID + '-body-' + id;
        body.setAttribute('role', 'tabpanel');
        body.setAttribute('aria-labelledby', b.id);
        body.hidden = true;
        bodies.appendChild(body);
      }
    });
    if (!activeId || !tabs[activeId]) activeId = order[0] || null;
    var title = h.querySelector('.un-sp-title');
    if (title) title.textContent = activeId && tabs[activeId] ? tabs[activeId].label : '';
    order.forEach(function (id) {
      var on = id === activeId;
      var b = list.querySelector('[data-tab="' + id + '"]');
      var body = bodies.querySelector('[data-tab="' + id + '"]');
      if (b) { b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; b.classList.toggle('is-on', on); }
      if (body) body.hidden = !on || !!(float && float.id === id);
    });
    syncRoles(h);
  }

  function notify() {
    try { doc().dispatchEvent(new CustomEvent('unsynth-side-panel', { detail: { open: open, id: activeId } })); } catch (e) { /* no listeners */ }
    // Any launcher that reflects our state (masthead chips, deck headers).
    var launchers = doc().querySelectorAll('[data-un-sp-launch]');
    for (var i = 0; i < launchers.length; i++) {
      var id = launchers[i].getAttribute('data-un-sp-launch');
      launchers[i].setAttribute('aria-expanded', open && activeId === id ? 'true' : 'false');
    }
  }

  function select(id) {
    if (!tabs[id]) return;
    // Asking for another tab while one is popped out docks the float first;
    // otherwise the request would land in a host that has stepped aside.
    if (float && float.id !== id) popIn();
    var prev = activeId;
    activeId = id;
    renderTabs();
    if (open) {
      if (prev && prev !== id && tabs[prev] && tabs[prev].onHide) { try { tabs[prev].onHide(); } catch (e) { /* module's problem */ } }
      if (tabs[id].onShow) { try { tabs[id].onShow(); } catch (e) { /* module's problem */ } }
    }
    notify();
  }

  function setOpen(on) {
    on = !!on;
    var h = host(on);
    if (!h) { open = false; return; }
    place();
    if (on === open) { renderTabs(); notify(); return; }
    open = on;
    h.classList.toggle('is-open', open);
    // Inside the guide the open panel is sized to end within the window
    // (watch-deck fitOpenPanel); closed, it carries no size of its own.
    if (!open) h.style.maxHeight = '';
    else if (g.UNWatchDeck && g.UNWatchDeck.fitView) { try { g.UNWatchDeck.fitView(); } catch (e) { /* no guide on this page */ } }
    renderTabs();
    if (open) {
      if (g.UNSYNTH && g.UNSYNTH.pushPanel && !escHandle) escHandle = g.UNSYNTH.pushPanel(function () { setOpen(false); });
      if (activeId && tabs[activeId] && tabs[activeId].onShow) { try { tabs[activeId].onShow(); } catch (e) { /* module's problem */ } }
      var first = h.querySelector('.un-sp-tab.is-on');
      if (first) setTimeout(function () { first.focus(); }, 40);
    } else {
      if (escHandle && g.UNSYNTH && g.UNSYNTH.popPanel) { g.UNSYNTH.popPanel(escHandle); }
      escHandle = null;
      if (activeId && tabs[activeId] && tabs[activeId].onHide) { try { tabs[activeId].onHide(); } catch (e) { /* module's problem */ } }
      if (float) popIn();
    }
    notify();
  }

  /**
   * Pop-out moves the LIVE tab body into a floating window and puts it back on
   * close. Analytics used to cloneNode() and disable every control in the copy
   * ("read-only preview") — a picture of a panel, not the panel.
   */
  function popOut(id) {
    id = id || activeId;
    if (!tabs[id] || float) return;
    var h = host(false);
    var body = h && h.querySelector('.un-sp-body[data-tab="' + id + '"]');
    if (!body) return;
    var f = el('div', 'un-sp-float');
    f.id = FLOAT_ID;
    f.setAttribute('role', 'dialog');
    f.setAttribute('aria-label', tabs[id].label);
    var head = el('div', 'un-sp-float-head');
    head.appendChild(el('span', 'un-sp-float-title', tabs[id].label));
    var dock = el('button', 'un-sp-float-dock');
    dock.appendChild(icon('dock'));
    dock.appendChild(doc().createTextNode('Dock'));
    dock.type = 'button';
    dock.title = 'Put it back beside the video';
    dock.addEventListener('click', popIn);
    head.appendChild(dock);
    var fclose = el('button', 'un-sp-close');
    fclose.type = 'button';
    fclose.title = 'Close';
    fclose.setAttribute('aria-label', 'Close the panel');
    fclose.appendChild(icon('close'));
    fclose.addEventListener('click', function () { setOpen(false); });
    head.appendChild(fclose);
    f.appendChild(head);
    // The float body IS a tab body: same classes and data-tab, so every
    // rule that turns a hosted module into a tab (side-panel.css) applies
    // here too. It did not: those rules were scoped to #un-side-panel, so a
    // popped-out Stats card fell back to its standalone collapsed state and
    // the "pop-out" showed one header row (captured 2026-09-22).
    var slot = el('div', 'un-sp-float-body un-sp-body');
    slot.dataset.tab = id;
    while (body.firstChild) slot.appendChild(body.firstChild);
    f.appendChild(slot);
    // Start where the docked panel was — over the related column — rather
    // than at a fixed right:24px, which at 1440 put the float across the
    // deck's own doors and the Description toggle (captured 2026-09-22).
    // Measured before the host steps aside; the user can drag it anywhere.
    var from = h && h.classList.contains('un-sp--docked') ? h.getBoundingClientRect() : null;
    doc().body.appendChild(f);
    if (from && from.width > 200) {
      // The docked host is sticky at masthead + 12, so its own top already
      // clears the masthead; 64 only guards a host scrolled partly away.
      f.style.left = Math.round(from.left) + 'px';
      f.style.right = 'auto';
      f.style.top = Math.round(Math.max(64, from.top)) + 'px';
      f.style.width = Math.round(from.width) + 'px';
    }
    // One panel at a time. The docked host stayed open with an empty body
    // under the float — two frames for one thing. It steps aside until Dock.
    if (h) h.classList.add('is-popped');
    // Drag by the head. Position is remembered for the session only.
    var drag = null;
    head.addEventListener('pointerdown', function (e) {
      if (e.target === dock) return;
      drag = { x: e.clientX - f.offsetLeft, y: e.clientY - f.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!drag) return;
      f.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.x)) + 'px';
      f.style.top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.y)) + 'px';
      f.style.right = 'auto';
    });
    head.addEventListener('pointerup', function () { drag = null; });
    float = { el: f, id: id };
    renderTabs();
  }

  function popIn() {
    if (!float) return;
    var h = host(false);
    var body = h && h.querySelector('.un-sp-body[data-tab="' + float.id + '"]');
    var slot = float.el.querySelector('.un-sp-float-body');
    if (body && slot) { while (slot.firstChild) body.appendChild(slot.firstChild); }
    float.el.remove();
    float = null;
    if (h) h.classList.remove('is-popped');
    renderTabs();
  }

  function register(t) {
    if (!t || !t.id) return;
    var fresh = !tabs[t.id];
    tabs[t.id] = { id: t.id, label: t.label || t.id, order: t.order || 50, onShow: t.onShow || null, onHide: t.onHide || null };
    if (fresh) order.push(t.id);
    order.sort(function (a, b) { return tabs[a].order - tabs[b].order; });
    if (host(false)) renderTabs();
  }

  /** The body a module renders into. Creates the host (closed) if needed. */
  function body(id) {
    if (!tabs[id]) return null;
    var h = host(true);
    if (!h) return null;
    place();
    renderTabs();
    if (float && float.id === id) return float.el.querySelector('.un-sp-float-body');
    return h.querySelector('.un-sp-body[data-tab="' + id + '"]');
  }

  /**
   * YouTube rebuilds #secondary on navigation, which detaches a docked host.
   * The host keeps its state in JS, so re-placing it is enough; modules that
   * mount into body() on their own scan find their content still inside it.
   */
  function sync() {
    if (rebuildQueued) return;
    rebuildQueued = true;
    setTimeout(function () {
      rebuildQueued = false;
      var h = host(false);
      if (!h) return;
      place();
      renderTabs();
    }, 0);
  }

  g.UNSidePanel = {
    HOST_ID: HOST_ID,
    register: register,
    body: body,
    // Already open: select(), which hides the previous tab before showing this
    // one. Setting activeId first (as this used to) made select() see
    // prev === id, so the outgoing tab never got onHide — AI kept believing it
    // was open, persisted aiPanelOpen=true, and the next watch page opened
    // the panel on AI by itself (captured 2026-09-22; DDR: closed at rest).
    open: function (id) {
      if (open) { if (id) select(id); else setOpen(true); return; }
      if (id && tabs[id]) activeId = id;
      setOpen(true);
    },
    close: function () { setOpen(false); },
    toggle: function (id) { if (open && (!id || id === activeId)) setOpen(false); else g.UNSidePanel.open(id); },
    isOpen: function () { return open; },
    active: function () { return activeId; },
    placement: placement,
    popOut: popOut,
    popIn: popIn,
    sync: sync,
    hosts: function (id) { var b = host(false) && host(false).querySelector('.un-sp-body[data-tab="' + id + '"]'); return !!(b && b.children.length); }
  };
})(typeof self !== 'undefined' ? self : window);
