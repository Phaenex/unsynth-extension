/**
 * Pure volume-level math — no DOM, no audio nodes. Shared by volume-master (the
 * boost engine) and ui-tune (the scroll-to-volume HUD) so the two always agree.
 * Unit-tested in test/volume-level.test.js — this is where the "HUD bar scaled to
 * the 600% ceiling so it barely moved" class of bug is caught instead of shipping.
 *
 *   clampGain(pct, max)   clamp a level to 0..max (the boost ceiling, default 600)
 *   nativeForPct(pct)     the 0-100 part of the level → element .volume (0..1); >100 pins at 1
 *   osdFillPercent(pct)   HUD bar width 0..100 across the NATIVE range (full at 100 and above)
 *   osdState(pct)         { muted, over, icon } classes/glyph for the HUD
 */
(function (g) {
  'use strict';

  function clampGain(pct, max) {
    max = typeof max === 'number' ? max : 600;
    pct = Math.round(Number(pct) || 0);
    return Math.max(0, Math.min(max, pct));
  }

  function nativeForPct(pct) {
    return Math.min(100, Math.max(0, Number(pct) || 0)) / 100;
  }

  function osdFillPercent(pct) {
    return Math.max(0, Math.min(100, Number(pct) || 0));
  }

  function osdState(pct) {
    pct = Number(pct) || 0;
    return {
      muted: pct === 0,
      over: pct > 100,
      // An icon NAME for the shared line-icon set (.un-ico[data-ico]), not an emoji.
      icon: pct === 0 ? 'vol-mute' : pct < 50 ? 'vol-low' : 'vol-high'
    };
  }

  // Web Audio boost multiplier for the gain node: native volume carries 0–100%,
  // so the boost node stays at 1.0 there and only multiplies above 100%.
  function computeBoostGain(pct) {
    pct = Number(pct) || 0;
    return pct > 100 ? pct / 100 : 1;
  }

  // Reverse sync: should a native-volume change be mirrored back into our level?
  // false = it's our own write (within the dead-band), or an active boost while
  // native is still pinned full. Anything else (incl. mute) warrants a sync.
  function shouldSyncFromNative(gainPct, actual, muted) {
    actual = Number(actual) || 0;
    const expected = nativeForPct(gainPct);
    if (!muted && Math.abs(actual - expected) < 0.006) return false;
    if (gainPct > 100 && !muted && actual >= 0.994) return false;
    return true;
  }

  // Whether to adopt the element's native volume as our level on first sight.
  // A freshly-loaded or autoplay-muted element reads 0 before YouTube applies its
  // saved volume; adopting that 0 locks us to mute, so only adopt a real level.
  function shouldAdoptNative(volume, muted) {
    return typeof volume === 'number' && volume > 0 && !muted;
  }

  // The level to adopt from a native volumechange. Mute is SEPARATE state from
  // level, so a muted element keeps reporting the level it is muting rather
  // than collapsing to 0.
  //
  // This is the "button reads 0% at a real 6%" bug, measured live: video.volume
  // was 0.06 and movie_player.getVolume() returned 6, while the button showed
  // "0%". The arithmetic was never the problem — Math.round(0.06 * 100) is 6.
  // The caller short-circuited on `video.muted` and wrote 0, then PERSISTED it,
  // so a muted-at-6% player came back as a genuine 0% next load. The level was
  // destroyed, not merely mis-displayed.
  //
  // `current` is the level already held, needed for the boost case: above 100%
  // native sits pinned at 1.0, so reading it back naively would demote a 300%
  // boost to 100 and silently drop it.
  function levelFromNative(volume, muted, current) {
    const cur = Number(current) || 0;
    const actual = Number(volume) || 0;
    if (muted) return cur;
    if (cur > 100 && actual >= 0.994) return cur;
    return Math.round(Math.max(0, Math.min(1, actual)) * 100);
  }

  const api = { clampGain, nativeForPct, osdFillPercent, osdState, computeBoostGain, shouldSyncFromNative, shouldAdoptNative, levelFromNative };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNVolumeLevel = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
