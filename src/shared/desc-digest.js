/**
 * Pure parser for a YouTube watch-page description.
 * Turns the current video's text into a blurb, outbound links, and seek stamps.
 * No DOM. Used by the watch-page digest card and by unit tests.
 */
(function (g) {
  'use strict';

  function secondsFromTs(str) {
    const parts = String(str).split(':').map(Number);
    if (parts.some((n) => Number.isNaN(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function linkLabel(url, host) {
    try {
      const u = new URL(url);
      const vid = u.searchParams.get('v');
      if (vid && /youtube\.com$/.test(host)) return 'youtube.com/' + vid;
    } catch (e) {
      /* keep host */
    }
    return host;
  }

  /**
   * One spelling for a time. Descriptions write "00:05", "0:05" and "05" for
   * the same moment, and the deck printed whatever it found — "00:00 00:05"
   * on one video, "0:00 1:07" on the next (observed 2026-09-22). YouTube's
   * own format: minutes unpadded, hours only when there are hours.
   */
  function tsLabel(sec) {
    const h = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return h ? h + ':' + String(mm).padStart(2, '0') + ':' + ss : mm + ':' + ss;
  }

  /**
   * The chapter's name: the rest of the line the timestamp sits on.
   *
   * A row of bare times — "0:00 1:07 2:42" — says there are chapters without
   * saying what any of them is, which is DESIGN-STANDARD rule A one level
   * down: the timestamp is the address, the title is the value. Strips list
   * markers and separators ("-", "–", "|", ":") so "0:00 - Intro" is "Intro".
   * Returns '' when the line carries no words of its own (an inline "at 3:35
   * he says" reference is not a chapter title and must not pretend to be one).
   */
  function stampTitle(text, idx, len) {
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    let lineEnd = text.indexOf('\n', idx + len);
    if (lineEnd === -1) lineEnd = text.length;
    const before = text.slice(lineStart, idx).trim();
    let after = text.slice(idx + len, lineEnd);
    // A timestamp that is not at the start of its line (after list markers) is
    // a reference inside prose, not a chapter heading.
    if (before.replace(/^[\s\-–—•*·|(\[]+/, '').length > 0) return '';
    after = after
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^[\s\])\-–—:|·•]+/, '')
      .trim();
    if (!/[A-Za-z\u00C0-\uFFFD]/.test(after)) return '';
    return after.length > 60 ? after.slice(0, 60).replace(/\s+\S*$/, '') + '…' : after;
  }

  /**
   * WHAT A LINK IS FOR (2026-09-24).
   *
   * Owner request: list every link and what it is for, and summarize
   * anything important. A row of hostnames says where a link goes,
   * not why it is there. The description usually says why, on the same line
   * ("Patreon: https://...", "Use code MIKE for 20% off: https://...") or on
   * the line above a bare URL. That text is the label; the host is secondary.
   */
  function cleanContext(t) {
    return String(t || '')
      .replace(/\bhttps?:\/\/\S+/gi, ' ')
      .replace(/[\u2190-\u21FF\u2700-\u27BF\uFE0F\u200D]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g, ' ')
      .replace(/^[\s\-\u2013\u2014\u2022*\u00B7|>:\u25BA\u25B6]+/, '')
      .replace(/[\s\-\u2013\u2014:|>\u2192(\[]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // A connector between two links on one line is not a label for either.
  const FILLER_RE = /^(and|or|&|also|here|link|links|at|on|via|see|plus|\+|or here)$/i;

  function contextFor(text, idx, len) {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
    let lineEnd = text.indexOf('\n', idx + len);
    if (lineEnd === -1) lineEnd = text.length;
    // Only the text between this link and its neighbours on the line: with
    // two links on one line, each takes the words next to it, not the other's.
    const lineText = text.slice(lineStart, lineEnd);
    const rel = idx - lineStart;
    const prevUrlEnd = (function () {
      let end = 0;
      const re = /\bhttps?:\/\/\S+/gi;
      let mm;
      while ((mm = re.exec(lineText)) !== null && mm.index < rel) end = mm.index + mm[0].length;
      return end;
    })();
    const nextUrl = lineText.slice(rel + len).search(/\bhttps?:\/\//i);
    const afterEnd = nextUrl === -1 ? lineText.length : rel + len + nextUrl;
    let ctx = cleanContext(lineText.slice(prevUrlEnd, rel));
    if (FILLER_RE.test(ctx)) ctx = '';
    if (!ctx) ctx = cleanContext(lineText.slice(rel + len, afterEnd));
    if (FILLER_RE.test(ctx)) ctx = '';
    if (!ctx && lineStart > 0) {
      // A bare URL under a line that introduces it ("Follow me on Instagram").
      const prevEnd = lineStart - 1;
      const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
      const prev = text.slice(prevStart, prevEnd);
      if (!/https?:\/\//i.test(prev) && prev.trim().length <= 80) ctx = cleanContext(prev);
    }
    if (!/[A-Za-z\u00C0-\uFFFD]/.test(ctx)) return '';
    return ctx.length > 70 ? ctx.slice(0, 70).replace(/\s+\S*$/, '') + '\u2026' : ctx;
  }

  const PURPOSES = [
    { id: 'sponsor', label: 'Sponsors & deals' },
    { id: 'support', label: 'Support the creator' },
    { id: 'merch', label: 'Merch' },
    { id: 'social', label: 'Socials' },
    { id: 'music', label: 'Listen' },
    { id: 'youtube', label: 'More on YouTube' },
    { id: 'source', label: 'Sources' },
    { id: 'other', label: 'Other links' }
  ];

  const SPONSOR_RE = /\b(sponsors?|sponsored|use (?:my |the )?code|promo ?code|coupon|discount|\d{1,2}\s?% off|free trial|affiliates?|partner(?:ed)? with)\b/i;
  // "Grab a TITAN Evo chair", "Get the VPN of our choice", "Shop Seasonic PSUs
  // here": a buying verb that opens the line is a product pitch, which in a
  // description is a sponsor or affiliate link far more often than not
  // (measured on a real Linus Tech Tips description, 2026-09-24, where all of
  // these had landed in "Other links").
  const PITCH_RE = /^(?:grab|get|buy|shop|order|try|save|check out|pick up|snag|upgrade)\b/i;
  // The creator's OWN shop, as opposed to a pitch for someone else's product.
  const OWN_MERCH_RE = /\b(merch|our (?:store|shop)|my (?:store|shop)|official (?:store|shop|merch))\b/i;

  /** Which group a link belongs in, from its host and the words around it. */
  function purposeOf(host, url, ctx) {
    const h = String(host || '').toLowerCase();
    const c = String(ctx || '');
    const u = String(url || '');
    const ownMerchHost = /(teespring|creator-spring|spring\.com|fourthwall|spreadshirt|redbubble|bonfire|represent\.com|merch|store\.|store$|shop\.)/.test(h) || /store\.com$/.test(h);
    if (OWN_MERCH_RE.test(c) || (ownMerchHost && !SPONSOR_RE.test(c))) return 'merch';
    if (SPONSOR_RE.test(c) || /(^|\.)(amzn\.to|geni\.us)$/.test(h) || (/(^|\.)amazon\./.test(h) && /[?&]tag=/.test(u))) return 'sponsor';
    // Before the pitch rule: "GET EXCLUSIVE CONTENT ON FLOATPLANE" opens with a
    // buying verb but is a membership, and the membership words are the more
    // specific signal.
    if (/(^|\.)(patreon\.com|ko-fi\.com|buymeacoffee\.com|paypal\.me|paypal\.com|gofundme\.com|streamlabs\.com|floatplane\.com|nebula\.tv)$/.test(h) ||
        /\/join(?:[?#]|$)/.test(u) || /\b(support (?:me|us|the channel|my work)|donate|tip jar|become a member|membership|exclusive content|floatplane|nebula)\b/i.test(c)) return 'support';
    if (PITCH_RE.test(c)) return 'sponsor';
    if (/(^|\.)(twitter\.com|x\.com|instagram\.com|tiktok\.com|facebook\.com|fb\.com|discord\.gg|discord\.com|twitch\.tv|reddit\.com|threads\.net|bsky\.app|linkedin\.com|snapchat\.com|mastodon\.social|linktr\.ee|beacons\.ai)$/.test(h) ||
        /\b(forum|community|discord|follow (?:me|us)|subreddit)\b/i.test(c)) return 'social';
    if (/(spotify\.com|music\.apple\.com|soundcloud\.com|bandcamp\.com|\.lnk\.to$|deezer\.com|tidal\.com|music\.youtube\.com|podcasts\.apple\.com)/.test(h)) return 'music';
    if (/(^|\.)(youtube\.com|youtu\.be)$/.test(h)) return 'youtube';
    if (/(wikipedia\.org|arxiv\.org|doi\.org|github\.com|nature\.com|science\.org|pubmed|ncbi\.nlm\.nih\.gov|scholar\.google|\.gov$|\.edu$|jstor\.org|sciencedirect\.com|springer\.com)/.test(h) ||
        /\b(source|sources|reference|references|paper|study|studies|article|further reading|read more|citation)\b/i.test(c)) return 'source';
    return 'other';
  }

  function clipLine(t, n) {
    t = cleanContext(t).replace(/[\s:\-|]+$/, '').trim();
    return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '\u2026' : t;
  }

  /**
   * THE THINGS WORTH KNOWING, pulled out of the text by pattern and never
   * invented: a sponsor line and its code, a paid or affiliate disclosure, a
   * disclaimer, a correction, the credits. Each is the description's own
   * words, clipped.
   */
  function highlightsOf(text) {
    const out = [];
    const seen = Object.create(null);
    const add = function (kind, label, t) {
      const k = kind + '|' + String(t).toLowerCase();
      if (!t || seen[k]) return;
      seen[k] = true;
      out.push({ kind: kind, label: label, text: t });
    };
    const credits = [];
    String(text || '').split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line) return;
      const words = line.replace(/\bhttps?:\/\/\S+/gi, '');
      if (/\b(correction|erratum|errata|clarification)\b|^\s*(update|edit)\s*:/i.test(line)) add('correction', 'Correction', clipLine(line, 140));
      if (/\b(not (?:financial|legal|medical|investment) advice|disclaimer|for (?:educational|entertainment) purposes)\b/i.test(line)) add('disclaimer', 'Disclaimer', clipLine(line, 140));
      if (/\b(affiliate links?|earn (?:a )?(?:small )?commission|paid (?:partnership|promotion)|contains (?:paid|sponsored))\b|#ad\b|#sponsored\b/i.test(line)) {
        add('disclosure', 'Disclosure', clipLine(line, 140));
      } else if (SPONSOR_RE.test(words) && /[a-z]{3}/.test(words)) {
        // /[a-z]/ (lowercase) on purpose: an all-caps line such as "SPONSORS,
        // AFFILIATES, AND PARTNERS:" is a link heading, not a statement about
        // this video (seen on a real Linus Tech Tips description).
        const code = line.match(/\bcode[:\s]+["\u201C']?([A-Z0-9][A-Z0-9_-]{2,19})\b/i);
        add('sponsor', code ? 'Code ' + code[1].toUpperCase() : 'Sponsor', clipLine(line, 140));
      }
      const cr = line.match(/^[\s\-\u2022*]*(music|song|edited|editor|editing|animation|animated|thumbnail|produced|producer|written|writer|filmed|camera|voice|narration|research|graphics|sound)\b[^:\n]{0,20}?\s*[:\-\u2013]\s*(.+)$/i) ||
        line.match(/^[\s\-\u2022*]*(music|edited|animated|produced|written|filmed|narrated)\s+by\s+(.+)$/i);
      if (cr && credits.length < 5) {
        const role = cr[1].charAt(0).toUpperCase() + cr[1].slice(1).toLowerCase();
        credits.push(clipLine(role + ': ' + cr[2].replace(/^by\s+/i, ''), 60));
      }
    });
    if (credits.length) add('credits', 'Credits', credits.join(' \u00B7 '));
    return out.slice(0, 8);
  }

  /**
   * The quick description, whole (2026-09-24). Owner request: show it in full,
   * never cut off and nothing to expand. The first prose paragraph is
   * kept entire up to 600 characters; past that it ends at the last full
   * sentence inside the limit rather than mid-word with an ellipsis.
   */
  function aboutText(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const MAX = 600;
    if (t.length <= MAX) return t;
    const head = t.slice(0, MAX);
    const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (end > 120) return head.slice(0, end + 1);
    return clipBlurb(t, MAX);
  }

  function clipBlurb(s, max) {
    max = max || 320;
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  }

  /**
   * @param {string} raw  full description of THIS video
   * @returns {{ empty: boolean, blurb: string, links: {url:string,host:string,label:string}[], stamps: {label:string,sec:number,title:string}[] }}
   */
  function parseWatchDescription(raw) {
    const text = String(raw || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ');
    const trimmed = text.trim();
    if (!trimmed) {
      return { empty: true, blurb: '', links: [], stamps: [], highlights: [], linkGroups: [] };
    }

    const links = [];
    const seenUrl = Object.create(null);
    // Deduping by full URL alone is not enough. A music description carries a
    // whole shelf of per-store smart links — different URLs, all on one host —
    // and every one of them renders with the host as its label, so the row read
    // as "rickastley.lnk.to" nine times in a row. Seen on a real watch page.
    // Cap how many links one host may contribute so the row stays a set of
    // distinct destinations rather than one host repeated.
    // Keyed by host + the label a reader would SEE. Every link is kept
    // (2026-09-24, "include all links"), but links that would render with an
    // identical label and nothing to tell them apart still collapse to one:
    // that is what the old one-per-host cap was protecting against.
    const seenShown = Object.create(null);
    const MAX_LINKS = 40;
    const urlRe = /\bhttps?:\/\/[^\s<>"'）)\]]+/gi;
    let m;
    while ((m = urlRe.exec(text)) !== null) {
      let url = m[0].replace(/[.,;:!?]+$/g, '');
      if (!/^https?:\/\//i.test(url)) continue;
      if (seenUrl[url]) continue;
      const host = hostOf(url);
      if (!host) continue;
      const label = linkLabel(url, host);
      const context = contextFor(text, m.index, m[0].length);
      // What the reader would see: the context, else the link's own label.
      // Two links collapse only when both are identical AND neither carries a
      // label of its own (a video id, a path) that tells them apart.
      const shown = host + '|' + label + '|' + context;
      if (seenShown[shown] && (context || label === host)) continue;
      seenShown[shown] = true;
      seenUrl[url] = true;
      links.push({ url: url, host: host, label: label, context: context, purpose: purposeOf(host, url, context) });
      if (links.length >= MAX_LINKS) break;
    }

    const stamps = [];
    const seenSec = Object.create(null);
    // ':' in the lookahead: "2:42: Layers" is a common chapter spelling and
    // was silently skipped. Greedy matching still takes "1:02:03" whole.
    const tsRe = /(?:^|[\s(\[])(\d{1,2}:\d{2}(?::\d{2})?)(?=[\s)\].,:]|$)/gm;
    while ((m = tsRe.exec(text)) !== null) {
      const sec = secondsFromTs(m[1]);
      if (sec == null || seenSec[sec]) continue;
      seenSec[sec] = true;
      stamps.push({ label: tsLabel(sec), sec: sec, title: stampTitle(text, m.index, m[0].length) });
      if (stamps.length >= 16) break;
    }

    // THE BLURB IS PROSE, NOT A LINK LIST (2026-09-24). A paragraph where
    // every line carries a URL, or opens with a pitch, is the sponsor block or
    // the socials; taking it as "what this video is about" printed "Shop
    // Seasonic PSUs here: Learn more about Seasonic..." on a real video. The
    // first paragraph that is prose wins; with none, there is no blurb rather
    // than a pitch dressed as one.
    const isListLine = (line) => /https?:\/\//i.test(line) || PITCH_RE.test(cleanContext(line)) || SPONSOR_RE.test(line) || /^\s*\d{1,2}:\d{2}/.test(line);
    const paras = text.split(/\n{2,}/);
    let blurb = '';
    for (let i = 0; i < paras.length; i++) {
      const lines = paras[i].split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length || lines.every(isListLine)) continue;
      const prose = lines.filter((l) => !isListLine(l)).join(' ');
      const withoutUrls = prose.replace(/\bhttps?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
      if (withoutUrls.length >= 20) {
        blurb = aboutText(withoutUrls);
        break;
      }
    }

    const linkGroups = PURPOSES
      .map((p) => ({ id: p.id, label: p.label, links: links.filter((l) => l.purpose === p.id) }))
      .filter((grp) => grp.links.length);

    // text: the whole description, for opening it in place in the guide.
    return { empty: false, blurb: blurb, links: links, stamps: stamps, highlights: highlightsOf(text), linkGroups: linkGroups, text: trimmed };
  }

  const api = { parseWatchDescription, secondsFromTs, clipBlurb, aboutText, tsLabel, purposeOf, highlightsOf, PURPOSES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNDescDigest = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
