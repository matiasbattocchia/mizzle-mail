// mail-text.js — pure, dependency-free mail parsing/formatting helpers.
//
// Everything here is string/Buffer-level: no imapflow, no nodemailer, no IMAP
// shapes. That's deliberate — these run unchanged in the local IMAP relay AND in
// the hosted Cloudflare Worker (which talks to the Gmail REST API). The only
// runtime dependency is Buffer (Node global; available in Workers via
// `nodejs_compat`). transport.js imports from here and re-exports for the tests.

// Gmail label marking "I shared this out" (calendar / download / copy). Lives in Gmail
// so the state syncs across devices. mizzle/sent is preferred; mizzle/ejected is the
// legacy name, still read for backwards compatibility.
export const SENT_LABEL = 'mizzle/sent';
export const LEGACY_SENT_LABEL = 'mizzle/ejected';

const MIN_HERO = 64; // px — anything declared smaller is an icon/thumb, not a hero image

// Minimal VEVENT parser — pulls the first event's summary/start/end/location.
export function parseIcs(ics) {
  const block = String(ics).match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i);
  if (!block) return null;
  const body = '\n' + block[1].replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, ''); // unfold continuation lines
  const line = (key) => { const m = body.match(new RegExp('\\n' + key + '[^:\\n]*:([^\\n\\r]+)', 'i')); return m ? m[1].trim() : null; };
  const icsDate = (val) => {
    if (!val) return null;
    const m = val.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return null;
    if (!m[4]) return { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
    return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] || ''}`, allDay: false };
  };
  const start = icsDate(line('DTSTART')); if (!start) return null;
  const end = icsDate(line('DTEND'));
  const unesc = (s) => s ? s.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ').replace(/\\\\/g, '\\') : null;
  return { title: unesc(line('SUMMARY')), start: start.iso, end: end ? end.iso : null, location: unesc(line('LOCATION')), allDay: start.allDay };
}

// Some senders embed the image size in the URL — fetch a crisp version instead of
// the tiny thumbnail. Bandcamp: f4.bcbits.com/img/<id>_<code>.jpg → the ~700px size.
export function upscaleThumb(src) {
  return src.replace(/(f4\.bcbits\.com\/img\/[a-z0-9]+)_\d+(\.jpg)/i, '$1_16$2');
}

// Best image in the HTML — skips tracking pixels/spacers AND tiny thumbnails,
// prefers a content image over a header logo/icon, and upscales known size-coded
// thumbnails. Returns null when there's nothing worth showing (better than a blurry
// 50px thumb): a card with no real image renders clean text instead.
export function extractImage(html) {
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  let fallback = null;
  for (const tag of tags) {
    const raw = (tag.match(/\bsrc\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (!raw || !/^https?:\/\//i.test(raw)) continue;
    if (/pixel|beacon|track|spacer|\/open[._-]|email[._-]?open|1x1/i.test(raw)) continue;
    const w = +((tag.match(/\bwidth\s*=\s*["']?(\d+)/i) || [])[1] || 0);
    const h = +((tag.match(/\bheight\s*=\s*["']?(\d+)/i) || [])[1] || 0);
    const src = upscaleThumb(raw);
    const upscalable = src !== raw; // we can pull a big version → declared size is irrelevant
    if (!upscalable && ((w && w < MIN_HERO) || (h && h < MIN_HERO))) continue; // tiny → skip, try the next
    if (!fallback) fallback = src;
    if (/logo|icon|header|footer|sprite|badge|social|facebook|twitter|instagram-glyph/i.test(raw)) continue;
    return src; // a content image
  }
  return fallback; // may be null — no decent image, show none
}

// Deterministic event detection — read the structured event data senders already
// embed (schema.org JSON-LD, the same source Gmail/Calendar parse). No AI, no
// prose-guessing: we only claim "event" when the sender literally declared one.
export function extractEvent(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const json = b.replace(/<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '').trim();
    let data; try { data = JSON.parse(json); } catch { continue; }
    const ev = findEventNode(data);
    if (ev) return ev;
  }
  return null;
}

// Walk a JSON-LD value (object, array, or @graph) for the first Event / *Reservation.
export function findEventNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const e = findEventNode(n, depth + 1); if (e) return e; } return null; }
  if (typeof node !== 'object') return null;
  if (node['@graph']) { const e = findEventNode(node['@graph'], depth + 1); if (e) return e; }
  const type = String(node['@type'] || '');
  // a reservation points at the real event via reservationFor
  if (/Reservation/i.test(type) && node.reservationFor) { const e = findEventNode(node.reservationFor, depth + 1); if (e) return e; }
  if (/Event/i.test(type) && (node.startDate || node.startTime)) {
    const loc = node.location;
    const locName = typeof loc === 'string' ? loc
      : (loc && (loc.name || (loc.address && (loc.address.name || [loc.address.streetAddress, loc.address.addressLocality].filter(Boolean).join(', '))))) || '';
    const start = String(node.startDate || node.startTime);
    return {
      title: String(node.name || '').trim() || null,
      start,
      end: node.endDate ? String(node.endDate) : null,
      location: (locName || '').trim() || null,
      allDay: /^\d{4}-\d{2}-\d{2}$/.test(start), // date with no time component
    };
  }
  // shallow descent into common containers
  for (const k of ['subEvent', 'event', 'about']) { if (node[k]) { const e = findEventNode(node[k], depth + 1); if (e) return e; } }
  return null;
}

export function normCharset(cs) {
  const c = (cs || 'utf-8').toLowerCase();
  if (/utf-?8/.test(c)) return 'utf8';
  if (/8859-1|latin1|windows-1252|ascii/.test(c)) return 'latin1';
  return 'utf8';
}

// Decode transfer-encoding to BYTES first, then interpret with the charset,
// so multibyte UTF-8 (e.g. "í", nbsp) reassembles correctly.
export function decodePart(buf, encoding, charset = 'utf8') {
  try {
    if (encoding === 'base64') {
      return Buffer.from(buf.toString('ascii'), 'base64').toString(charset);
    }
    if (encoding === 'quoted-printable') {
      const src = buf.toString('binary').replace(/=\r?\n/g, '');
      const bytes = [];
      for (let i = 0; i < src.length; i++) {
        if (src[i] === '=' && /[0-9A-Fa-f]{2}/.test(src.substr(i + 1, 2))) {
          bytes.push(parseInt(src.substr(i + 1, 2), 16)); i += 2;
        } else { bytes.push(src.charCodeAt(i) & 0xff); }
      }
      return Buffer.from(bytes).toString(charset);
    }
  } catch { /* fall through */ }
  return buf.toString(charset);
}

// Wrap raw message source(s) into a downloadable bundle: .eml for one, .mbox for many.
export function buildBundle(msgs) {
  if (!msgs.length) return null;
  if (msgs.length === 1) return { ext: 'eml', mime: 'message/rfc822', content: msgs[0].source };
  const parts = msgs.map((m) => {
    const dt = m.date ? new Date(m.date) : new Date(0);
    const body = m.source.toString('utf8').replace(/\r?\n(>*From )/g, '\n>$1'); // mboxrd: escape From_ lines
    return `From ${m.from} ${dt.toUTCString()}\n${body}${body.endsWith('\n') ? '\n' : '\n\n'}`;
  });
  return { ext: 'mbox', mime: 'application/mbox', content: Buffer.from(parts.join(''), 'utf8') };
}

// For a path-less URL, a clean label is just the host (no scheme, no trailing slash),
// e.g. https://hardlinesounds.bandcamp.com/ → "hardlinesounds.bandcamp.com". Returns
// null when the URL has a path/query/fragment (then a generic label reads better).
export function hostOnlyLabel(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)?([?#].*)?$/i.exec(url);
  if (!m) return null;
  const path = (m[2] || '').replace(/\/+$/, '');
  return (!path && !m[3]) ? m[1] : null;
}

export function stripHtml(html) {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ') // drop quoted replies
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // keep link targets so buttons ("Accept", "Confirm"…) stay actionable, but tidily:
    // <a href="URL">Label</a> → "[Label](URL)" (markdown), which linkify renders as a
    // clickable "Label" — no long URL clutter. Falls back to "link" when there's no label.
    // Handles quoted AND unquoted hrefs (Google uses unquoted href=https://c.gle/…).
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, q1, q2, q3, inner) => {
      const url = (q1 ?? q2 ?? q3 ?? '').replace(/&amp;/gi, '&').trim();
      let text = inner.replace(/<[^>]+>/g, ' ').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
      if (!/^(https?:|mailto:)/i.test(url)) return ` ${text} `;          // #, javascript:, tel: → text only
      if (text && text.toLowerCase() === url.toLowerCase()) {
        if (!hostOnlyLabel(url)) return ` ${url} `;                      // url-as-text with a path → show it bare
        text = '';                                                       // host-only url-as-text → placeholder
      }
      if (!text) text = 'link';      // placeholder — dedup prefers real labels, then it's named post-hoc
      return ` [${text}](${url}) `;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&[a-z0-9#]+;/gi, ' ');
}

// Cut off quoted reply chains ("On … wrote:", "El … escribió:", > lines, etc.)
// so a thread doesn't repeat the same content over and over.
export function trimQuoted(text) {
  const markers = [
    /\bOn\b.{0,160}?\bwrote:/,
    /\bEl\b.{0,160}?\bescribi[óo]:/i,
    /\bLe\b.{0,160}?\ba écrit\s*:/,
    /-{2,}\s*Original Message\s*-{2,}/i,
    /\bFrom:.{0,80}?\bSent:/is,
    /_{6,}/,
  ];
  let cut = text.length;
  for (const re of markers) { const m = text.match(re); if (m && m.index < cut) cut = m.index; }
  return text.slice(0, cut).replace(/(\n\s*>.*)+\s*$/g, '');
}

export function cleanBody(text) {
  // drop zero-width chars, trim quoted history, then collapse whitespace; keep the
  // full readable body (bounded) so the card can expand to it via "more".
  const t = trimQuoted(text.replace(/[​‌‍﻿]/g, ''));
  const collapsed = t.replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // dedupe consecutive same-url links, then name any leftover "link" placeholder after
  // its host when the URL is path-less (e.g. → hardlinesounds.bandcamp.com).
  const deduped = dedupeLinks(collapsed).replace(/\[link\]\((https?:\/\/[^\s)]+)\)/g, (m, url) => {
    const h = hostOnlyLabel(url);
    return h ? `[${h}](${url})` : m;
  });
  return deduped.slice(0, 4000);
}

// HTML emails routinely place two links to the SAME url back-to-back (an icon/image
// link with no text, then the text link). Collapse consecutive same-url markdown
// links into one, keeping the most descriptive label (a real label over "link").
export function dedupeLinks(s) {
  const re = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)\s*\n?\s*\[([^\]]*)\]\(\2\)/g;
  let prev;
  do {
    prev = s;
    s = s.replace(re, (_m, a, url, b) => {
      const label = a === 'link' ? b : b === 'link' ? a : a.length >= b.length ? a : b;
      return `[${label}](${url})`;
    });
  } while (s !== prev);
  return s;
}

export function gmDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}
