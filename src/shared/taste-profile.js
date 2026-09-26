'use strict';

/**
 * Taste profile — learns what you actually watch, then scores candidate videos
 * by similarity so "more like this" can be surfaced.
 *
 * Pure functions only: no DOM, no chrome APIs, no network. Everything here is
 * unit-testable in Node, which matters because the scoring is the part most
 * likely to be subtly wrong and least likely to be noticed if it is (a bad
 * recommender doesn't crash, it just quietly suggests rubbish).
 *
 * WHY THIS EXISTS
 * watch-history.js already records WHICH channels and videos were watched, but
 * nothing about WHAT they were about — no title text is stored anywhere. So
 * there was no vocabulary to reason over and no way to answer "find me more
 * like this one". This module adds that layer.
 *
 * HOW IT SCORES
 * Three independent signals, combined:
 *
 *   Channel affinity — you have watched this channel before. The strongest
 *     single predictor by far, and the cheapest to compute.
 *   Token overlap     — meaningful words shared between a candidate's title and
 *     the vocabulary built from titles you have watched, weighted by how often
 *     you have watched each word AND how rare that word is overall (a plain
 *     frequency count would rank "the" above "roguelike").
 *   Recency           — a word watched yesterday says more about current taste
 *     than one watched a year ago, so weights decay.
 *
 * Deliberately NOT a black box: scoreCandidate() returns the reasons behind
 * every number so the UI can explain a suggestion instead of asking the user to
 * trust it.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.UNTasteProfile = factory();
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var STORAGE_KEY = 'unTasteProfile';
  var MAX_TOKENS = 2000; // vocabulary ceiling — trimmed by weight when exceeded
  var MAX_CHANNELS = 500;
  var HALF_LIFE_DAYS = 45; // a signal is worth half as much after this long

  // Words that carry no topical meaning. Without this the vocabulary fills up
  // with "the/and/video/new" and every candidate looks equally similar to
  // everything, which is the classic failure mode of naive token matching.
  var STOP = {};
  (
    'a,an,the,and,or,but,if,of,to,in,on,at,for,with,from,by,as,is,are,was,were,be,been,being,' +
    'this,that,these,those,it,its,i,you,he,she,they,we,me,my,your,his,her,their,our,us,them,' +
    'do,does,did,done,can,could,will,would,should,shall,may,might,must,have,has,had,not,no,yes,' +
    'so,than,then,too,very,just,now,new,more,most,best,top,how,what,why,when,where,who,which,' +
    'video,videos,watch,full,part,ep,episode,official,hd,4k,live,vs,ft,feat,vol,' +
    'get,got,make,made,go,going,goes,one,two,three,first,last,day,days,time,times,' +
    'about,into,out,up,down,over,under,after,before,again,all,any,every,some,each'
  )
    .split(',')
    .forEach(function (w) {
      STOP[w] = true;
    });

  /** Title → meaningful lowercase tokens. */
  function tokenize(text) {
    if (!text) return [];
    var cleaned = String(text)
      .toLowerCase()
      // Keep letters/digits/spaces; everything else becomes a separator so
      // "how-to | 4 tips!" splits cleanly instead of producing "to|4".
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ');
    var parts = cleaned.split(/\s+/);
    var out = [];
    var seen = {};
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i];
      if (w.length < 3 || w.length > 24) continue; // "ai" is too ambiguous, hashes too long
      if (STOP[w]) continue;
      if (/^\d+$/.test(w)) continue; // bare numbers carry no topic
      if (seen[w]) continue; // one vote per title, so repetition can't stuff the profile
      seen[w] = true;
      out.push(w);
    }
    return out;
  }

  function emptyProfile() {
    return {
      version: 1,
      updated: 0,
      tokens: {}, // token -> { w: weight, n: times seen, t: last-seen day }
      channels: {}, // channelKey -> { w: weight, n: count, t: last-seen day, name }
      totalWatched: 0
    };
  }

  function dayOf(ts) {
    return Math.floor((ts || 0) / 86400000);
  }

  /** Exponential decay so old interests fade instead of accumulating forever. */
  function decayFactor(fromDay, toDay) {
    var days = Math.max(0, (toDay || 0) - (fromDay || 0));
    if (!days) return 1;
    return Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  function normalize(profile) {
    var p = profile && typeof profile === 'object' ? profile : {};
    return {
      version: 1,
      updated: p.updated || 0,
      tokens: p.tokens && typeof p.tokens === 'object' ? p.tokens : {},
      channels: p.channels && typeof p.channels === 'object' ? p.channels : {},
      totalWatched: p.totalWatched || 0
    };
  }

  /**
   * Fold one watched video into the profile.
   * @param profile existing profile (or null)
   * @param video   { title, channelKey, channelName, ts, weight }
   *                `weight` lets a fully-watched video count more than a
   *                10-second bounce — the caller decides, since only it knows
   *                watch progress.
   */
  function recordWatch(profile, video) {
    var p = normalize(profile);
    if (!video) return p;
    var ts = video.ts || Date.now();
    var day = dayOf(ts);
    var w = typeof video.weight === 'number' ? Math.max(0, Math.min(3, video.weight)) : 1;
    if (!w) return p;

    var toks = tokenize(video.title);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      var cur = p.tokens[t] || { w: 0, n: 0, t: day };
      // Decay what was already there to `day` before adding, so weights from
      // different eras are always on the same scale. Without this a token
      // watched heavily two years ago would outrank a current obsession.
      cur.w = cur.w * decayFactor(cur.t, day) + w;
      cur.n += 1;
      cur.t = day;
      p.tokens[t] = cur;
    }

    if (video.channelKey) {
      var ck = String(video.channelKey);
      var c = p.channels[ck] || { w: 0, n: 0, t: day, name: video.channelName || '' };
      c.w = c.w * decayFactor(c.t, day) + w;
      c.n += 1;
      c.t = day;
      if (video.channelName) c.name = video.channelName;
      p.channels[ck] = c;
    }

    p.totalWatched += 1;
    p.updated = ts;
    return trim(p);
  }

  /** Keep the profile bounded — drop the weakest entries past the ceilings. */
  function trim(profile) {
    var p = normalize(profile);
    var keys = Object.keys(p.tokens);
    if (keys.length > MAX_TOKENS) {
      keys
        .sort(function (a, b) {
          return p.tokens[b].w - p.tokens[a].w;
        })
        .slice(MAX_TOKENS)
        .forEach(function (k) {
          delete p.tokens[k];
        });
    }
    var cks = Object.keys(p.channels);
    if (cks.length > MAX_CHANNELS) {
      cks
        .sort(function (a, b) {
          return p.channels[b].w - p.channels[a].w;
        })
        .slice(MAX_CHANNELS)
        .forEach(function (k) {
          delete p.channels[k];
        });
    }
    return p;
  }

  /** Current (decayed) weight of a token as of `day`. */
  function tokenWeight(profile, token, day) {
    var e = profile.tokens[token];
    if (!e) return 0;
    return e.w * decayFactor(e.t, day);
  }

  function channelWeight(profile, key, day) {
    var e = profile.channels[key];
    if (!e) return 0;
    return e.w * decayFactor(e.t, day);
  }

  /**
   * Fallback channel lookup by display name when no key/href match exists.
   *
   * WHY: YouTube's watch-page related rail (yt-lockup-view-model tiles) case
   * renders the channel purely as text inside yt-content-metadata-view-model
   * — no <a href="/@handle"> or /channel/UC… link anywhere in the tile at
   * all. tileChannelKey() (src/shared/yt-dom.js) can only ever derive a key
   * from an href, so on this markup it always returns null, and channel
   * affinity — worth up to 45 of scoreCandidate's 100 points, the single
   * strongest signal per this module's own docs — silently contributed
   * nothing to EVERY related-rail candidate. Confirmed live: a channel with
   * heavy watch history scored identically to a channel never watched once,
   * because both hit this same channelKey-lookup dead end. Reported as the
   * match badge "barely working" — token overlap alone (max 55 points, and
   * only when title wording happens to overlap) was carrying the entire
   * score. Name matching is a weaker signal than a stable key (two different
   * channels can share a display name) so this is a fallback, never
   * preferred over an actual key hit.
   */
  function channelWeightByName(profile, name, day) {
    if (!name) return { weight: 0, key: null };
    var low = String(name).trim().toLowerCase();
    if (!low) return { weight: 0, key: null };
    var keys = Object.keys(profile.channels);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var entry = profile.channels[k];
      if (entry.name && String(entry.name).trim().toLowerCase() === low) {
        return { weight: channelWeight(profile, k, day), key: k };
      }
    }
    return { weight: 0, key: null };
  }

  /**
   * Highest decayed token weight in the profile. Used to normalize scores into
   * a stable 0–100 range regardless of how much history exists — without it a
   * heavy user's scores would all bunch near 100 and a new user's near 0.
   */
  function peakTokenWeight(profile, day) {
    var max = 0;
    var keys = Object.keys(profile.tokens);
    for (var i = 0; i < keys.length; i++) {
      var w = tokenWeight(profile, keys[i], day);
      if (w > max) max = w;
    }
    return max;
  }

  /**
   * Score how well a candidate matches the profile.
   * @returns {{score:number, level:string, reasons:string[], matched:string[]}}
   *   score 0–100.
   */
  function scoreCandidate(profile, candidate, opts) {
    var p = normalize(profile);
    var c = candidate || {};
    var now = (opts && opts.now) || Date.now();
    var day = dayOf(now);
    var reasons = [];
    var matched = [];

    // A profile with nothing in it cannot rank anything. Say so honestly
    // rather than emitting confident-looking noise.
    var vocab = Object.keys(p.tokens).length;
    if (!vocab && !Object.keys(p.channels).length) {
      return { score: 0, level: 'none', reasons: ['No watch history yet'], matched: [] };
    }

    var score = 0;

    // --- channel affinity ---
    var chKey = c.channelKey;
    var cw = chKey ? channelWeight(p, chKey, day) : 0;
    // A candidate with no usable key (see channelWeightByName's comment —
    // some surfaces render the channel as plain text with no link at all)
    // still deserves a shot at the strongest signal this scorer has, via its
    // display name. Only tried when the key lookup found nothing, and never
    // overrides a real key hit.
    if (!cw && c.channelName) {
      var byName = channelWeightByName(p, c.channelName, day);
      if (byName.weight > 0) {
        cw = byName.weight;
        chKey = byName.key;
      }
    }
    if (cw > 0) {
      // Saturating: the 1st watch of a channel is a big signal, the 40th adds
      // little. Linear scaling would let one binge-watched channel dominate
      // every ranking forever.
      var chPart = 45 * (cw / (cw + 3));
      score += chPart;
      reasons.push('You watch this channel (' + (p.channels[chKey].n || 1) + ' videos)');
      matched.push('channel');
    }

    // --- token overlap ---
    var toks = tokenize(c.title);
    var peak = peakTokenWeight(p, day) || 1;
    var hits = [];
    for (var i = 0; i < toks.length; i++) {
      var w = tokenWeight(p, toks[i], day);
      if (w > 0) hits.push({ token: toks[i], w: w });
    }
    if (hits.length) {
      hits.sort(function (a, b) {
        return b.w - a.w;
      });
      // Sum the top few relative to the profile's own peak, with diminishing
      // returns per additional word — a title matching 12 common words is not
      // 12x more relevant than one matching the single word that matters.
      //
      // The raw sum is then squashed through x/(x+k) rather than clamped with
      // min(1, …). A hard clamp meant a single top-weight match already hit
      // the ceiling, so matching ONE interest scored identically to matching
      // FIVE — the engine could not tell "vaguely related" from "exactly your
      // thing", which is most of the value. The curve keeps every additional
      // match worth something while still approaching, never reaching, the
      // maximum.
      var raw = 0;
      for (var j = 0; j < hits.length && j < 6; j++) {
        raw += (hits[j].w / peak) / Math.pow(1.6, j);
      }
      var tokPart = 55 * (raw / (raw + 0.9));
      score += tokPart;
      var names = hits.slice(0, 3).map(function (h) {
        return h.token;
      });
      reasons.push('Matches your interests: ' + names.join(', '));
      matched = matched.concat(names);
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    var level = score >= 65 ? 'high' : score >= 35 ? 'medium' : score >= 15 ? 'low' : 'none';
    if (!reasons.length) reasons.push('No overlap with what you usually watch');
    return { score: score, level: level, reasons: reasons, matched: matched };
  }

  /**
   * Rank candidates best-first. Ties break on the ORIGINAL feed order so the
   * result stays stable across re-scans (an unstable sort makes the UI
   * visibly reshuffle on every DOM mutation).
   */
  function rankCandidates(profile, candidates, opts) {
    var list = (candidates || []).map(function (c, i) {
      var s = scoreCandidate(profile, c, opts);
      return { candidate: c, score: s.score, level: s.level, reasons: s.reasons, matched: s.matched, _i: i };
    });
    list.sort(function (a, b) {
      return b.score - a.score || a._i - b._i;
    });
    return list.map(function (r) {
      delete r._i;
      return r;
    });
  }

  /** The strongest current interests — for "because you watch X" UI. */
  function topInterests(profile, n, opts) {
    var p = normalize(profile);
    var day = dayOf((opts && opts.now) || Date.now());
    return Object.keys(p.tokens)
      .map(function (t) {
        return { token: t, weight: tokenWeight(p, t, day), seen: p.tokens[t].n };
      })
      .filter(function (x) {
        return x.weight > 0;
      })
      .sort(function (a, b) {
        return b.weight - a.weight;
      })
      .slice(0, n || 10);
  }

  function topChannels(profile, n, opts) {
    var p = normalize(profile);
    var day = dayOf((opts && opts.now) || Date.now());
    return Object.keys(p.channels)
      .map(function (k) {
        return { key: k, name: p.channels[k].name || k, weight: channelWeight(p, k, day), seen: p.channels[k].n };
      })
      .filter(function (x) {
        return x.weight > 0;
      })
      .sort(function (a, b) {
        return b.weight - a.weight;
      })
      .slice(0, n || 10);
  }

  // ---- explicit negative signal ----
  //
  // recordWatch() only ever adds interest. "Not interested" and "never from
  // this channel" are the other half: without them the only way to stop seeing
  // something is to keep not clicking it, which the profile cannot distinguish
  // from not having seen it yet. Kept SEPARATE from the profile itself so a
  // dismissal survives profile trimming — dropping the weakest tokens must
  // never quietly un-dismiss something the user explicitly rejected.
  var STORAGE_KEY_DISMISSED = 'unTasteDismissed';
  // Bounded like the profile. Oldest first, since a rejection from a year ago
  // matters far less than last week's.
  var MAX_DISMISSED_VIDEOS = 2000;
  var MAX_DISMISSED_CHANNELS = 500;

  function emptyDismissed() {
    return { videos: {}, channels: {}, updated: 0 };
  }

  function normalizeDismissed(d) {
    if (!d || typeof d !== 'object') return emptyDismissed();
    return {
      videos: d.videos && typeof d.videos === 'object' ? d.videos : {},
      channels: d.channels && typeof d.channels === 'object' ? d.channels : {},
      updated: Number(d.updated) || 0
    };
  }

  function trimMap(map, max) {
    var keys = Object.keys(map);
    if (keys.length <= max) return map;
    keys
      .sort(function (a, b) { return (map[a] || 0) - (map[b] || 0); })
      .slice(0, keys.length - max)
      .forEach(function (k) { delete map[k]; });
    return map;
  }

  function dismissVideo(dismissed, videoId, ts) {
    var d = normalizeDismissed(dismissed);
    if (!videoId) return d;
    d.videos[String(videoId)] = ts || Date.now();
    d.videos = trimMap(d.videos, MAX_DISMISSED_VIDEOS);
    d.updated = ts || Date.now();
    return d;
  }

  function dismissChannel(dismissed, channelKey, ts) {
    var d = normalizeDismissed(dismissed);
    if (!channelKey) return d;
    d.channels[String(channelKey).toLowerCase()] = ts || Date.now();
    d.channels = trimMap(d.channels, MAX_DISMISSED_CHANNELS);
    d.updated = ts || Date.now();
    return d;
  }

  /** True when this candidate was explicitly rejected, by id or by channel. */
  function isDismissed(dismissed, candidate) {
    if (!candidate) return false;
    var d = normalizeDismissed(dismissed);
    if (candidate.videoId && d.videos[String(candidate.videoId)]) return true;
    var key = candidate.channelKey ? String(candidate.channelKey).toLowerCase() : '';
    return !!(key && d.channels[key]);
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    MAX_TOKENS: MAX_TOKENS,
    MAX_CHANNELS: MAX_CHANNELS,
    HALF_LIFE_DAYS: HALF_LIFE_DAYS,
    tokenize: tokenize,
    emptyProfile: emptyProfile,
    normalize: normalize,
    recordWatch: recordWatch,
    trim: trim,
    tokenWeight: tokenWeight,
    channelWeight: channelWeight,
    channelWeightByName: channelWeightByName,
    scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates,
    topInterests: topInterests,
    topChannels: topChannels,
    STORAGE_KEY_DISMISSED: STORAGE_KEY_DISMISSED,
    emptyDismissed: emptyDismissed,
    normalizeDismissed: normalizeDismissed,
    dismissVideo: dismissVideo,
    dismissChannel: dismissChannel,
    isDismissed: isDismissed
  };
});
