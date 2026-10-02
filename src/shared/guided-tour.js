/**
 * Guided tour & feature bubbles.
 * Guides users through key Unsynth features on YouTube.
 */
(function (g) {
  'use strict';

  const STORAGE_KEY = 'unsynth_tour_completed';

  // The step count in each badge comes from STEPS.length (badgeFor), so a new
  // step cannot leave "Step 4 of 4" behind. 2026-10-02: the tour covered none
  // of the audio, watched-marks or AI-filter work; those steps were added.
  const STEPS = [
    {
      id: 'watch-deck',
      label: 'Watch Guide',
      title: 'Unsynth Watch Guide',
      body: 'Everything you need beside the player: real time left at your playback speed, likes and dislikes, skip segments, and the chapter list (click CHAPTERS to fold it away). Choose beside or under the video in the dashboard.',
      selector: '#un-watch-deck, .un-watch-deck'
    },
    {
      id: 'audio',
      label: 'Audio',
      title: 'Sound presets and boost',
      body: 'The bar over the video sets the level up to 600% and picks a sound: Cinema, Smart, Bass, Vocal (clearer voices), Treble, Night (evens out loud and quiet), Mono, or your own Custom EQ. For the ten-band Custom EQ and a live level meter, open the Unsynth toolbar button.',
      selector: '#un-vol-inline'
    },
    {
      id: 'watched',
      label: 'Watched videos',
      title: 'Watched marks on every thumbnail',
      body: 'The eye in a thumbnail\'s top-left corner shows what you have seen; click it to mark or unmark. Dim or hide watched videos from the menu at the top of YouTube, and use "Show the N hidden here" to bring them back on a page.',
      selector: '.un-watched-mark'
    },
    {
      id: 'player-tools',
      label: 'Player Tools',
      title: 'On-Player Actions',
      body: 'Take full-resolution frame screenshots, loop sections with A-B repeat, jump custom skip seconds, or clip short highlights directly from the video controls.',
      selector: '#un-media-tools, #un-screenshot-btn'
    },
    {
      id: 'playlist-folders',
      label: 'Playlists & Folders',
      title: 'Library & Custom Folders',
      body: 'Organize your playlists into custom folders in YouTube\'s sidebar, pin your daily rotation, and use thumbnail checkboxes to batch-manage videos.',
      selector: '#un-pl-folders, #un-sidebar-hub'
    },
    {
      id: 'ai-filter',
      label: 'AI filter',
      title: 'AI content filter',
      body: 'Unsynth can hide, blur or label videos that look AI-made. It reads what YouTube shows: YouTube\'s own "altered or synthetic" label, the community AiSList, and AI-voice wording in titles. It cannot see inside a video. Set it up in the dashboard\'s Filter tab.',
      selector: null // Center presentation
    },
    {
      id: 'quick-switcher',
      label: 'Shortcuts',
      title: 'Fast Navigation & Keys',
      body: 'Press <kbd>Shift</kbd>+<kbd>P</kbd> anywhere on YouTube to jump to any channel or playlist instantly. Use <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> to mark videos watched.',
      selector: null // Center presentation
    }
  ];
  function badgeFor(idx) { return 'Step ' + (idx + 1) + ' of ' + STEPS.length + ' · ' + STEPS[idx].label; }

  let currentStep = 0;
  let bubbleEl = null;
  let overlayEl = null;
  let highlightedEl = null;

  function removeHighlight() {
    if (highlightedEl) {
      highlightedEl.classList.remove('un-tour-highlight');
      highlightedEl = null;
    }
  }

  function highlightElement(el) {
    removeHighlight();
    if (el) {
      el.classList.add('un-tour-highlight');
      highlightedEl = el;
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      } catch (e) {}
    }
  }

  function positionBubble(bubble, targetEl) {
    if (!targetEl) {
      // Center on screen
      bubble.style.top = '50%';
      bubble.style.left = '50%';
      bubble.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const rect = targetEl.getBoundingClientRect();
    const margin = 16;
    const bubbleWidth = Math.min(380, window.innerWidth - 32);
    const bubbleHeight = 220; // approximate estimate

    let top = rect.bottom + margin;
    let left = rect.left;

    // If bottom runs off-screen, place above
    if (top + bubbleHeight > window.innerHeight && rect.top > bubbleHeight + margin) {
      top = rect.top - bubbleHeight - margin;
    }

    // Clamp horizontally
    if (left + bubbleWidth > window.innerWidth - margin) {
      left = window.innerWidth - bubbleWidth - margin;
    }
    if (left < margin) {
      left = margin;
    }

    bubble.style.top = Math.max(margin, Math.min(top, window.innerHeight - bubbleHeight - margin)) + 'px';
    bubble.style.left = Math.max(margin, left) + 'px';
    bubble.style.transform = 'none';
  }

  function markCompleted() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: true });
      }
    } catch (e) {}
  }

  // Merge, never overwrite: watchGuide also holds the guide's placement.
  function hideTourButton() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.sync) return;
      chrome.storage.sync.get({ watchGuide: {} }, (s) => {
        const wg = Object.assign({}, (s && s.watchGuide) || {}, { showTourButton: false });
        chrome.storage.sync.set({ watchGuide: wg });
      });
    } catch (e) {}
  }

  function closeTour() {
    removeHighlight();
    // Capture the element before clearing the variable: the timer used to read
    // the variable after it was nulled, so it removed nothing and every closed
    // tour left an invisible overlay and bubble in the page.
    const overlay = overlayEl;
    const bubble = bubbleEl;
    overlayEl = null;
    bubbleEl = null;
    if (overlay) {
      overlay.classList.remove('is-active');
      setTimeout(() => overlay.remove(), 200);
    }
    if (bubble) {
      bubble.classList.remove('is-visible');
      setTimeout(() => bubble.remove(), 200);
    }
    document.removeEventListener('keydown', onKeyDown);
    markCompleted();
  }

  function renderStep(idx) {
    if (idx < 0 || idx >= STEPS.length) {
      closeTour();
      return;
    }
    currentStep = idx;
    const step = STEPS[idx];

    let targetEl = null;
    if (step.selector) {
      targetEl = document.querySelector(step.selector);
    }

    highlightElement(targetEl);

    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'un-tour-overlay';
      overlayEl.addEventListener('click', closeTour);
      document.body.appendChild(overlayEl);
      requestAnimationFrame(() => overlayEl && overlayEl.classList.add('is-active'));
    }

    if (!bubbleEl) {
      bubbleEl = document.createElement('div');
      bubbleEl.className = 'un-tour-bubble';
      document.body.appendChild(bubbleEl);
      requestAnimationFrame(() => bubbleEl && bubbleEl.classList.add('is-visible'));
    }

    const isLast = idx === STEPS.length - 1;
    const isFirst = idx === 0;

    bubbleEl.innerHTML =
      '<div class="un-tour-head">' +
        '<span class="un-tour-badge">' + badgeFor(idx) + '</span>' +
        '<button class="un-tour-close" type="button" aria-label="Close tour">✕</button>' +
      '</div>' +
      '<h3 class="un-tour-title">' + step.title + '</h3>' +
      '<div class="un-tour-body">' + step.body + '</div>' +
      '<div class="un-tour-foot">' +
        (!isFirst ? '<button class="un-tour-btn un-tour-btn-ghost un-tour-prev" type="button">Back</button>' : '<button class="un-tour-btn un-tour-btn-ghost un-tour-skip" type="button">Skip tour</button>') +
        '<div class="un-tour-actions">' +
          ((isFirst || isLast) ? '<button class="un-tour-btn un-tour-btn-ghost un-tour-hidebtn" type="button" title="Bring it back in Settings, Watch guide">Hide Tour button</button>' : '') +
          '<button class="un-tour-btn un-tour-btn-primary un-tour-next" type="button">' + (isLast ? 'Got it!' : 'Next →') + '</button>' +
        '</div>' +
      '</div>';

    positionBubble(bubbleEl, targetEl);

    bubbleEl.querySelector('.un-tour-close').addEventListener('click', closeTour);
    const skipBtn = bubbleEl.querySelector('.un-tour-skip');
    if (skipBtn) skipBtn.addEventListener('click', closeTour);
    const prevBtn = bubbleEl.querySelector('.un-tour-prev');
    if (prevBtn) prevBtn.addEventListener('click', () => renderStep(currentStep - 1));
    const hideBtn = bubbleEl.querySelector('.un-tour-hidebtn');
    if (hideBtn) hideBtn.addEventListener('click', () => { hideTourButton(); closeTour(); });
    const nextBtn = bubbleEl.querySelector('.un-tour-next');
    if (nextBtn) nextBtn.addEventListener('click', () => renderStep(currentStep + 1));
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      closeTour();
    } else if (e.key === 'ArrowRight' && currentStep < STEPS.length - 1) {
      renderStep(currentStep + 1);
    } else if (e.key === 'ArrowLeft' && currentStep > 0) {
      renderStep(currentStep - 1);
    }
  }

  function startTour(force) {
    document.addEventListener('keydown', onKeyDown);
    renderStep(0);
  }

  function checkFirstRun() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (!res || !res[STORAGE_KEY]) {
          // Delay briefly to allow watch page / sidebar DOM to settle
          setTimeout(() => {
            if (location.pathname === '/watch' || location.pathname.indexOf('/watch') === 0) {
              startTour(false);
            }
          }, 2500);
        }
      });
    } catch (e) {}
  }

  const api = {
    STEPS,
    badgeFor,
    startTour,
    closeTour,
    checkFirstRun
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNGuidedTour = api;

  // Auto-check on idle load if running in browser
  if (typeof window !== 'undefined' && window.document) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(checkFirstRun, 1500);
    } else {
      window.addEventListener('DOMContentLoaded', () => setTimeout(checkFirstRun, 1500));
    }
  }

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'UNSYNTH/TOUR/START') {
          startTour(true);
          if (sendResponse) sendResponse({ ok: true });
        }
      });
    }
  } catch (e) {}
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this);
