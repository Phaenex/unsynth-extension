/** Donation / support links — Phaenex (Unsynth is free; tips optional). */
(function (g) {
  'use strict';

  const DONATION = {
    businessName: 'Phaenex',
    productName: 'Unsynth',
    pitch: 'If Unsynth helps you, $1 tells me it was worth making this.',
    subtext: 'Unsynth stays free. Tips are optional and go to Phaenex — never required for any feature.',
    kofiUrl: 'https://ko-fi.com/phaenex',
    kofiLabel: 'Buy me a coffee on Ko-fi',
  };

  function openKofi() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: DONATION.kofiUrl });
      return;
    }
    window.open(DONATION.kofiUrl, '_blank', 'noopener');
  }

  const api = { DONATION, openKofi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNDONATION = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
