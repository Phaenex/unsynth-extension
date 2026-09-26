/** Pure builders for generated subscription/discovery rows. */
(function (g, factory) {
  'use strict';
  var api = factory(
    typeof require !== 'undefined' ? require('./sub-groups.js') : g && g.UNSubGroups,
    typeof require !== 'undefined' ? require('./taste-profile.js') : g && g.UNTasteProfile
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNSubSmartRows = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis, function (SG, TP) {
  'use strict';

  var NEWS_RE = /\b(news|reuters|associated press|politics|current events|breaking|journal|times|post|guardian|bbc|cnn|cbs|nbc|abc|msnbc|pbs|c-span|al jazeera|bloomberg|economist|ign|gamespot)\b/i;

  function channelKey(sub) {
    if (!sub) return '';
    return sub.handle ? SG.handleKey(sub.handle) : sub.channelId ? 'channel:' + sub.channelId : '';
  }

  function assigned(store, sub) {
    var keys = [channelKey(sub), sub && sub.channelId ? 'channel:' + sub.channelId : ''].filter(Boolean);
    return keys.some(function (key) {
      return SG.groupsForChannel(store || {}, key).length > 0;
    });
  }

  function scoreSubscription(profile, sub) {
    if (!TP || !profile || !profile.totalWatched) return 0;
    var candidates = [];
    if (sub.handle) candidates.push(SG.handleKey(sub.handle));
    if (sub.channelId) candidates.push('channel:' + sub.channelId);
    var best = 0;
    candidates.forEach(function (key) {
      var result = TP.scoreCandidate(profile, { title: sub.title || '', channelKey: key, channelName: sub.title || '' });
      if (result.score > best) best = result.score;
    });
    return best;
  }

  function suggestedChannels(subscriptions, store, profile, limit) {
    return (subscriptions || [])
      .filter(function (sub) { return sub && sub.channelId && !assigned(store, sub); })
      .map(function (sub) {
        return Object.assign({}, sub, { key: channelKey(sub) || 'channel:' + sub.channelId, score: scoreSubscription(profile, sub) });
      })
      .sort(function (a, b) { return b.score - a.score || String(a.title).localeCompare(String(b.title)); })
      .slice(0, limit || 12);
  }

  function newsChannels(subscriptions, limit) {
    return (subscriptions || [])
      .filter(function (sub) { return sub && NEWS_RE.test((sub.title || '') + ' ' + (sub.handle || '')); })
      .map(function (sub) { return Object.assign({}, sub, { key: channelKey(sub) || 'channel:' + sub.channelId }); })
      .sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); })
      .slice(0, limit || 20);
  }

  // Score threshold below which a "match" isn't really one — kept low
  // enough that a candidate pool built from scraped tiles (never more than a
  // few hundred at once, no API to pull a bigger universe from) still
  // surfaces a real list rather than 1-2 videos. Reported live: with the
  // pool that size, a 25-point floor let almost nothing through.
  var MIN_MATCH_SCORE = 15;

  /**
   * Membership-gated videos never belong in these rows.
   *
   * Suggested / News / Discover are recommendation surfaces — the whole point
   * is "here is something to watch next". A members-only or members-first video
   * is one you click and then cannot play, so putting it there is worse than
   * showing nothing. This is NOT the user-facing "Hide members-only" toggle,
   * which governs YouTube's own feeds where a paid video is at least honest
   * about being part of a channel you follow; these lists are ours, we chose
   * what goes in them, and a paywall is never a good recommendation.
   *
   * Anchored exactly like yt-dom's MEMBER_BADGE_RE — a substring test matches
   * "Member First Credit Union", which is a real channel.
   */
  var MEMBER_BADGE_RE = /^members?[\s-]*(only|first)$/;

  function isMembershipGated(candidate) {
    var badges = (candidate && candidate.badges) || [];
    for (var i = 0; i < badges.length; i++) {
      if (MEMBER_BADGE_RE.test(String(badges[i]).trim().toLowerCase())) return true;
    }
    return false;
  }

  function discoverVideos(candidates, profile, subscribedCache, limit, dismissed) {
    if (!TP || !profile || !profile.totalWatched) return [];
    var seen = {};
    return (candidates || [])
      .filter(function (candidate) {
        if (!candidate || !candidate.videoId || seen[candidate.videoId]) return false;
        seen[candidate.videoId] = true;
        if (isMembershipGated(candidate)) return false;
        if (TP && TP.isDismissed && TP.isDismissed(dismissed, candidate)) return false;
        return !SG.isSubscribedInCache(subscribedCache, candidate.channelName || '', candidate.channelKey || '');
      })
      .map(function (candidate) {
        var result = TP.scoreCandidate(profile, candidate);
        return Object.assign({}, candidate, { score: result.score, reasons: result.reasons || [] });
      })
      .filter(function (candidate) { return candidate.score >= MIN_MATCH_SCORE; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit || 60);
  }

  // Video-level "Suggested" / "News" — taste-matched picks from whatever
  // tiles have actually rendered on the home page, same source pool
  // discoverVideos() already scores from. Deliberately NOT filtered by
  // subscription status (unlike discoverVideos, which exists specifically to
  // surface UNFAMILIAR channels) — "Suggested" here means "matches what you
  // watch," independent of who you follow. Reported live: the sidebar rows
  // for Suggested/News previously only ever listed SUBSCRIBED channels
  // (suggestedChannels/newsChannels above), which is a different feature —
  // "organize channels I already follow" — not "show me videos based on what
  // I watch," which is what these two are for.
  function suggestedVideos(candidates, profile, limit, dismissed) {
    if (!TP || !profile || !profile.totalWatched) return [];
    var seen = {};
    return (candidates || [])
      .filter(function (candidate) {
        if (!candidate || !candidate.videoId || seen[candidate.videoId]) return false;
        seen[candidate.videoId] = true;
        if (isMembershipGated(candidate)) return false;
        if (TP && TP.isDismissed && TP.isDismissed(dismissed, candidate)) return false;
        return true;
      })
      .map(function (candidate) {
        var result = TP.scoreCandidate(profile, candidate);
        return Object.assign({}, candidate, { score: result.score, reasons: result.reasons || [] });
      })
      .filter(function (candidate) { return candidate.score >= MIN_MATCH_SCORE; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit || 60);
  }

  function newsVideos(candidates, profile, limit, dismissed) {
    if (!TP || !profile || !profile.totalWatched) return [];
    var seen = {};
    return (candidates || [])
      .filter(function (candidate) {
        if (!candidate || !candidate.videoId || seen[candidate.videoId]) return false;
        seen[candidate.videoId] = true;
        if (isMembershipGated(candidate)) return false;
        if (TP && TP.isDismissed && TP.isDismissed(dismissed, candidate)) return false;
        return NEWS_RE.test((candidate.title || '') + ' ' + (candidate.channelName || ''));
      })
      .map(function (candidate) {
        var result = TP.scoreCandidate(profile, candidate);
        // News is selected by TOPIC, not by taste — a news video you have never
        // watched anything like still belongs here, so unlike the other two
        // builders this one deliberately has no MIN_MATCH_SCORE floor.
        //
        // But a "1% match" badge is noise pretending to be information: it
        // says the score is meaningless, in the visual language of a score that
        // means something. Reported from a screenshot of the News page showing
        // "2% match" and "1% match" on its only two rows. Below the floor the
        // score is dropped entirely so no badge renders, and the row simply
        // stands on being news.
        var score = result.score >= MIN_MATCH_SCORE ? result.score : 0;
        return Object.assign({}, candidate, { score: score, reasons: result.reasons || [] });
      })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit || 60);
  }

  return {
    channelKey: channelKey,
    assigned: assigned,
    suggestedChannels: suggestedChannels,
    newsChannels: newsChannels,
    discoverVideos: discoverVideos,
    suggestedVideos: suggestedVideos,
    newsVideos: newsVideos
  };
});
