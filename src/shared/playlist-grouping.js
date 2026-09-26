'use strict';

/**
 * Which channels is a playlist actually made of?
 *
 * WHY A LIST OF 418 ROWS HIDES THIS
 * A long playlist reads as undifferentiated. Scrolling it tells you nothing
 * about whether it is forty creators or mostly three, and "mostly three" is the
 * fact that decides whether it is worth keeping, splitting, or pruning. The page
 * already carries every row's channel; nobody aggregates it.
 *
 * WHAT IT REFUSES TO SAY
 *   - No concentration claim from a handful of rows. A playlist of four videos
 *     is "all from one channel" in a way that means nothing, so a floor applies.
 *   - No claim about rows it could not read. YouTube renders playlists lazily,
 *     so the counts describe what is LOADED, and the caller is told how many
 *     rows had no readable channel rather than having them silently dropped.
 *
 * Pure: no DOM, no chrome APIs. The caller supplies { key, name } pairs.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.UNPlaylistGrouping = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null, function () {

  /** Below this many readable rows, any concentration figure is noise. */
  var MIN_ROWS = 8;

  /**
   * A key made presentable when no display name was available.
   *
   * Playlist rows often carry the channel link but no visible channel name, so
   * the key is the only thing to fall back on. Showing the raw internal form
   * ("@google", "channel:UCxxx") leaks a storage detail into a sentence a person
   * reads; stripping the prefix gives something that at least reads as a name.
   * Prefer a real name whenever a row supplies one.
   */
  function readableKey(key) {
    var k = String(key || '');
    if (k.indexOf('@') === 0) return k.slice(1);
    if (k.indexOf('channel:') === 0) return k.slice(8);
    if (k.indexOf('c:') === 0) return k.slice(2);
    return k;
  }

  /**
   * @param entries [{ key, name }] one per row, in page order. A null/empty key
   *                counts as unreadable rather than as its own channel.
   * @returns {{ channels: [{key,name,count,share}], readable, unreadable,
   *             total, top, topShare, confident }}
   */
  function groupByChannel(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var byKey = Object.create(null);
    var readable = 0;
    var unreadable = 0;

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var key = e && e.key;
      if (!key) { unreadable++; continue; }
      readable++;
      if (!byKey[key]) byKey[key] = { key: key, name: (e && e.name) || readableKey(key), count: 0 };
      byKey[key].count++;
      // Prefer a real name over a key echo if a later row carries one.
      // Compare against readableKey(key), not key: the fallback stores the
      // stripped form, so comparing to the raw key would never match and a real
      // name arriving on a later row would be silently ignored.
      if (e && e.name && byKey[key].name === readableKey(key)) byKey[key].name = e.name;
    }

    var channels = Object.keys(byKey).map(function (k) { return byKey[k]; });
    channels.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      // Stable, human order for ties so the label does not reshuffle per scan.
      return a.name.localeCompare(b.name);
    });
    channels.forEach(function (c) { c.share = readable ? c.count / readable : 0; });

    return {
      channels: channels,
      readable: readable,
      unreadable: unreadable,
      total: list.length,
      top: channels[0] || null,
      topShare: channels[0] ? channels[0].share : 0,
      confident: readable >= MIN_ROWS
    };
  }

  /**
   * The sentence, or null when there is nothing worth saying.
   *
   * Three shapes, because the interesting fact differs:
   *   one channel      "all from Kurzgesagt"
   *   concentrated     "mostly Kurzgesagt (62%) and 3 others"
   *   spread           "24 channels, none over 20%"
   *
   * The last one matters: a playlist with no dominant creator is a different
   * object from one that is secretly a single-channel archive, and reporting
   * only the top channel would make them look identical.
   */
  function groupingLabel(stats) {
    if (!stats || !stats.confident || !stats.channels.length) return null;
    var n = stats.channels.length;
    var top = stats.channels[0];
    var pct = Math.round(top.share * 100);

    if (n === 1) return 'all from ' + top.name;
    if (pct >= 40) {
      var others = n - 1;
      return 'mostly ' + top.name + ' (' + pct + '%) and ' + others +
        (others === 1 ? ' other' : ' others');
    }
    return n + ' channels, none over ' + Math.max(pct, 1) + '%';
  }

  return {
    MIN_ROWS: MIN_ROWS,
    groupByChannel: groupByChannel,
    groupingLabel: groupingLabel
  };
});
