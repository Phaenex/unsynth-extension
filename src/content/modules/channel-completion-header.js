/**
 * "21% of what you start here, you finish" — on the channel page itself.
 *
 * WHY THIS NUMBER IS WORTH RENDERING
 * Google Takeout history carries no duration and no completion, so every history
 * tool is structurally blind to whether you actually liked anything: a four-second
 * bail and a finished 40-minute deep dive look identical. Unsynth records
 * progress per video, so it can say something none of them can — and the honest
 * form of it is a rate over videos you STARTED, not over videos you saved.
 *
 * WHERE THE DATA COMES FROM
 * watch-history writes videoChannel { videoId: channelKey } as you watch, which
 * is why this works without a Takeout import. The alternative source,
 * watchStats.channelVideos, is built only by the dashboard importer — verified
 * empty on a fresh live profile — so anything built on it renders nothing for
 * everyone who has not imported.
 *
 * WHAT IT REFUSES TO SAY
 * Below three started videos it renders nothing at all rather than a confident
 * "0%" from one data point. It also never shows a saved-vs-finished count here:
 * that needs playlist membership, and from watch history saved === played by
 * construction, which would make the ratio 1 and the claim a lie.
 */
(function () {
  'use strict';

  const MOUNTED = 'un-cc-header';
  let core = null;
  let YT = null;

  function enabled() {
    const s = (core && core.settings) || {};
    return s.channelCompletion !== false;
  }

  function teardown() {
    document.querySelectorAll('.' + MOUNTED).forEach((n) => n.remove());
  }

  /**
   * The channel page's own header row, which is where a claim about this
   * channel belongs. The selector lives in yt-dom with every other renderer
   * name; returning null just means no header this frame, and scan() retries.
   */
  function headerAnchor() {
    return YT && YT.channelHeaderInfo ? YT.channelHeaderInfo() : null;
  }

  function render(label) {
    const anchor = headerAnchor();
    if (!anchor) return false;
    if (anchor.querySelector('.' + MOUNTED)) return true;

    const el = document.createElement('div');
    el.className = MOUNTED;
    el.textContent = label;
    // The sentence already reads as prose, so the accessible name is the same
    // text; a role would announce a decoration that isn't one.
    el.setAttribute('title', 'Counts videos you watched past 10%. Finished means 90% or more.');
    anchor.appendChild(el);
    return true;
  }

  function compute(cb) {
    const page = YT && YT.pageChannel ? YT.pageChannel() : null;
    if (!page || !page.key) return cb(null);

    chrome.storage.local.get(['videoChannel', 'watchProgress', 'watchedVideos'], (d) => {
      if (chrome.runtime.lastError) return cb(null);
      const map = (d && d.videoChannel) || {};
      const ids = Object.keys(map).filter((id) => map[id] === page.key);
      if (!ids.length) return cb(null);

      const CC = window.UNChannelCompletion;
      if (!CC) return cb(null);
      const stats = CC.channelCompletion({
        videoIds: ids,
        progress: (d && d.watchProgress) || {},
        // watch-history stores a PERCENTAGE, not seconds. Passing these as
        // seconds would read 30% as 30 seconds and call almost nothing started.
        percentProgress: true,
        watched: (d && d.watchedVideos) || []
      });
      cb(CC.completionLabel(stats));
    });
  }

  function scan() {
    if (!enabled()) {
      teardown();
      return;
    }
    if (!(YT && YT.pageChannel && YT.pageChannel())) {
      teardown();
      return;
    }
    compute((label) => {
      if (!label) {
        teardown();
        return;
      }
      render(label);
    });
  }

  const mod = {
    id: 'channelCompletionHeader',
    moduleKey: 'channelCompletion',
    init: function (c) {
      core = c;
      YT = window.UNYtDom || null;
      scan();
    },
    scan: scan,
    onNavigate: function () {
      teardown();
      scan();
    },
    onSettings: function (s) {
      core.settings = s;
      scan();
    },
    teardown: teardown
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { headerAnchor };
  } else if (window.UNSYNTH) {
    window.UNSYNTH.register(mod);
  }
})();
