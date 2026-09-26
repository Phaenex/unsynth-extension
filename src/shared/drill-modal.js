/**
 * Lightweight drill-down modal for stats / dashboard pages.
 */
(function (root) {
  'use strict';

  let backdrop = null;
  let lastFocus = null; // element to restore focus to when the modal closes
  let pendingResolve = null; // confirm()/prompt() resolver — settled on any close

  function ensure() {
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'un-drill';
    backdrop.innerHTML =
      '<div class="un-drill-box" role="dialog" aria-modal="true">' +
      '<button type="button" class="un-drill-x" aria-label="Close">×</button>' +
      '<h3 class="un-drill-title"></h3>' +
      '<div class="un-drill-body"></div></div>';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('.un-drill-x').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function row(label, value, hint) {
    const d = document.createElement('div');
    d.className = 'un-drill-row';
    const l = document.createElement('span');
    l.className = 'un-drill-k';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'un-drill-v';
    v.textContent = value;
    d.appendChild(l);
    d.appendChild(v);
    if (hint) {
      const h = document.createElement('p');
      h.className = 'un-drill-hint';
      h.textContent = hint;
      d.appendChild(h);
    }
    return d;
  }

  function para(text) {
    const p = document.createElement('p');
    p.className = 'un-drill-p';
    p.textContent = text;
    return p;
  }

  function list(items) {
    const ul = document.createElement('ul');
    ul.className = 'un-drill-list';
    items.forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    return ul;
  }

  function open(title, nodes) {
    const el = ensure();
    lastFocus = document.activeElement;
    el.querySelector('.un-drill-title').textContent = title || '';
    const body = el.querySelector('.un-drill-body');
    body.textContent = '';
    const arr = Array.isArray(nodes) ? nodes : [nodes];
    arr.forEach((n) => {
      if (!n) return;
      if (typeof n === 'string') body.appendChild(para(n));
      else body.appendChild(n);
    });
    el.classList.add('open');
  }

  function close() {
    if (backdrop) backdrop.classList.remove('open');
    // A dismissal (Esc / backdrop / ×) counts as "cancel" for confirm()/prompt().
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(null);
    }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try {
        lastFocus.focus();
      } catch (e) {
        /* element gone */
      }
    }
    lastFocus = null;
  }

  function actionRow(buttons) {
    const row = document.createElement('div');
    row.className = 'un-drill-actions';
    buttons.forEach((b) => row.appendChild(b));
    return row;
  }

  function mkBtn(label, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    return b;
  }

  /**
   * Styled replacement for window.confirm(). Resolves true on OK, false on
   * Cancel or any dismissal (Esc, backdrop click, ×).
   */
  function confirmDialog(title, message, opts) {
    return new Promise((resolve) => {
      const ok = mkBtn((opts && opts.okLabel) || 'OK', true);
      const cancel = mkBtn((opts && opts.cancelLabel) || 'Cancel', false);
      pendingResolve = (v) => resolve(v === true);
      ok.addEventListener('click', () => {
        pendingResolve = null;
        close();
        resolve(true);
      });
      cancel.addEventListener('click', () => close());
      const paras = message ? String(message).split(/\n+/).map(para) : [];
      open(title, paras.concat([actionRow([cancel, ok])]));
      ok.focus();
    });
  }

  /**
   * Styled replacement for window.prompt(). Resolves the entered string on OK
   * (Enter submits) or null on Cancel / dismissal.
   */
  function promptDialog(title, message, defaultValue) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'un-drill-input';
      input.value = defaultValue == null ? '' : String(defaultValue);
      const ok = mkBtn('OK', true);
      const cancel = mkBtn('Cancel', false);
      pendingResolve = () => resolve(null);
      const submit = () => {
        pendingResolve = null;
        const v = input.value;
        close();
        resolve(v);
      };
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
      });
      cancel.addEventListener('click', () => close());
      const paras = message ? String(message).split(/\n+/).map(para) : [];
      open(title, paras.concat([input, actionRow([cancel, ok])]));
      input.focus();
      input.select();
    });
  }

  function clickable(el, fn) {
    if (!el) return;
    el.classList.add('clickable');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    const run = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      fn(e);
    };
    el.addEventListener('click', run);
    el.addEventListener('keydown', run);
  }

  root.UNDrill = { open, close, row, para, list, clickable, confirm: confirmDialog, prompt: promptDialog };
})(typeof window !== 'undefined' ? window : self);
