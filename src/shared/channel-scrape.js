/**
 * Resolve public YouTube channel titles from channel pages (no OAuth).
 * Used by the service worker when the Data API is unavailable.
 */
(function (g) {
  'use strict';

  function unescapeJsonString(s) {
    if (!s) return '';
    try {
      return JSON.parse('"' + s + '"');
    } catch (e) {
      return s.replace(/\\u0026/g, '&').replace(/\\"/g, '"');
    }
  }

  // og:title's content="..." comes straight out of raw page HTML, unlike the
  // channelMetadataRenderer/c4TabbedHeaderRenderer paths below which are JSON
  // string literals already unescaped via unescapeJsonString(). A channel
  // name containing &, ', ", <, > (e.g. "Marvel &amp; DC Universe") was
  // rendered with the literal entity text instead of the real character.
  var HTML_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' '
  };
  function decodeHtmlEntities(s) {
    if (!s) return '';
    return String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, function (whole, ent) {
      if (ent.charAt(0) === '#') {
        var code = ent.charAt(1).toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return isNaN(code) ? whole : String.fromCodePoint(code);
      }
      var key = ent.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : whole;
    });
  }

  function titleFromRuns(t) {
    if (!t) return '';
    if (typeof t === 'string') return t.trim();
    if (t.simpleText) return String(t.simpleText).trim();
    if (t.runs && t.runs.length) {
      return t.runs
        .map(function (r) {
          return r.text || '';
        })
        .join('')
        .trim();
    }
    return '';
  }

  function parseYtInitialData(html) {
    var out = { title: '', thumb: '' };
    var m = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});/s) || html.match(/ytInitialData\s*=\s*(\{.+?\});/s);
    if (!m || !m[1]) return out;
    try {
      var data = JSON.parse(m[1]);
      var stack = [data];
      var seen = new Set();
      while (stack.length) {
        var cur = stack.pop();
        if (!cur || typeof cur !== 'object') continue;
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (cur.channelMetadataRenderer) {
          var meta = cur.channelMetadataRenderer;
          if (!out.title) out.title = titleFromRuns(meta.title);
          if (!out.thumb && meta.avatar && meta.avatar.thumbnails && meta.avatar.thumbnails.length) {
            var ths = meta.avatar.thumbnails;
            out.thumb = ths[ths.length - 1].url || '';
          }
        }
        if (!out.title && cur.c4TabbedHeaderRenderer && cur.c4TabbedHeaderRenderer.title) {
          out.title = titleFromRuns(cur.c4TabbedHeaderRenderer.title);
        }
        for (var k in cur) {
          var v = cur[k];
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch (e) {
      /* ignore malformed JSON */
    }
    return out;
  }

  /** Parse a channel watch page HTML blob for title + avatar URL. */
  function parseChannelHtml(html) {
    var out = { title: '', thumb: '' };
    if (!html || typeof html !== 'string') return out;

    var og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    if (og) out.title = decodeHtmlEntities(og[1]).replace(/\s*-\s*YouTube\s*$/i, '').trim();

    if (!out.title) {
      var meta = html.match(/"channelMetadataRenderer"\s*:\s*\{[\s\S]{0,800}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (meta) out.title = unescapeJsonString(meta[1]).trim();
    }
    if (!out.title) {
      var hdr = html.match(/"c4TabbedHeaderRenderer"\s*:\s*\{[\s\S]{0,400}?"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (hdr) out.title = unescapeJsonString(hdr[1]).trim();
    }

    var yt = parseYtInitialData(html);
    if (!out.title && yt.title) out.title = yt.title;

    var thumb = html.match(/"avatar"\s*:\s*\{\s*"thumbnails"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (thumb) out.thumb = unescapeJsonString(thumb[1]);
    if (!out.thumb && yt.thumb) out.thumb = yt.thumb;

    return out;
  }

  async function scrapeOneChannel(id) {
    if (!id || !/^UC[\w-]+$/.test(id)) return null;
    try {
      var r = await fetch('https://www.youtube.com/channel/' + id, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html'
        }
      });
      if (!r.ok) return null;
      var html = await r.text();
      var parsed = parseChannelHtml(html);
      if (!parsed.title) return null;
      return { id: id, title: parsed.title, thumb: parsed.thumb || '' };
    } catch (e) {
      return null;
    }
  }

  /** Resolve channel ids in parallel batches (no artificial cap — caller batches). */
  async function scrapeChannelNames(ids, opts) {
    var batch = (opts && opts.batch) || 8;
    var names = {};
    var thumbs = {};
    var list = (ids || []).filter(function (id) {
      return id && /^UC[\w-]+$/.test(id);
    });

    for (var i = 0; i < list.length; i += batch) {
      var chunk = list.slice(i, i + batch);
      var results = await Promise.all(
        chunk.map(function (id) {
          return scrapeOneChannel(id);
        })
      );
      results.forEach(function (row) {
        if (!row || !row.title) return;
        names[row.id] = row.title;
        if (row.thumb) thumbs[row.id] = row.thumb;
      });
    }
    return { names: names, thumbs: thumbs };
  }

  var api = { parseChannelHtml: parseChannelHtml, parseYtInitialData: parseYtInitialData, scrapeChannelNames: scrapeChannelNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (g) g.UNChannelScrape = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
