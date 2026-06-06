// MailTransport: the swappable seam (IMAP today; DirectSockets/IWA later).
// Key constraint: the inbox can be 37k+ messages, so we NEVER page it — we pull
// bounded per-category, post-cutoff slices using Gmail's search over IMAP.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

export const CATEGORIES = ['primary', 'updates', 'social', 'forums', 'promotions'];

export class ImapTransport {
  constructor({ host, port, user, pass }) {
    this.config = {
      host, port, secure: true,
      auth: { user, pass: (pass || '').replace(/\s/g, '') },
      logger: false, greetingTimeout: 10000, connectionTimeout: 10000,
    };
    this.snippetCache = new Map(); // uid -> snippet (snippets never change)
  }

  // Short ops (mark-seen, keep, fetch-thread) share ONE persistent connection so
  // they don't open new sockets per call and blow past Gmail's ~15-connection cap.
  async #ops() {
    if (this._opsClient && this._opsClient.usable) return this._opsClient;
    this._opsClient = await this.#openClient();
    return this._opsClient;
  }

  async #withClient(fn, mailbox = 'INBOX') {
    const client = await this.#ops();
    const path = mailbox === 'ALL' ? await this.#mailboxPath(client, '\\All') : mailbox;
    const lock = await client.getMailboxLock(path);
    try { return await fn(client); }
    finally { lock.release(); }
  }

  // Resolve a Gmail special-use mailbox path (\All, \Sent, …), cached per flag.
  async #mailboxPath(client, flag) {
    this._paths = this._paths || {};
    if (this._paths[flag]) return this._paths[flag];
    let path;
    try { const boxes = await client.list(); path = boxes.find((b) => b.specialUse === flag)?.path; }
    catch { /* ignore */ }
    path = path || (flag === '\\All' ? '[Gmail]/All Mail' : flag === '\\Sent' ? '[Gmail]/Sent Mail' : 'INBOX');
    this._paths[flag] = path;
    return path;
  }

  // Bounded feed: for each Gmail category, the most recent messages after the
  // cutoff. Returns metadata + a Gmail-style content snippet per card.
  async buildFeed(opts) {
    // serialize builds so concurrent loads don't contend over the shared pool
    while (this._building) { try { await this._building; } catch { /* ignore */ } }
    this._building = this.#buildFeedInner(opts);
    try { return await this._building; } finally { this._building = null; }
  }

  async #buildFeedInner({ cutoff, perCategory = 18, maxItems = 50 }) {
    const lap = () => {};
    const me = (this.config.auth.user || '').toLowerCase();
    const conns = await this.#getPool();
    const POOL = conns.length;
    const c0 = conns[0];
    lap('pool ready');
    try {
      const after = gmDate(cutoff);

      // PHASE A — INBOX: candidate threads, categories, correspondent identity,
      // unread/kept state. No bodies (the headline body comes from All Mail).
      // Run the category searches in parallel, each on its own pool connection.
      const catResults = await Promise.all(CATEGORIES.map(async (cat, i) => {
        const client = conns[i % POOL];
        const lock = await client.getMailboxLock('INBOX');
        try { return [cat, (await client.search({ gmailRaw: `category:${cat} after:${after}` }, { uid: true })) || []]; }
        catch (e) { console.error(`search ${cat}:`, e.message); return [cat, []]; }
        finally { lock.release(); }
      }));
      lap('category searches (parallel)');
      const catOf = new Map();
      for (const [cat, uids] of catResults)
        for (const uid of uids.slice(-perCategory)) if (!catOf.has(uid)) catOf.set(uid, cat);

      const info = new Map(); // threadId -> thread summary
      if (catOf.size) {
        const lock = await c0.getMailboxLock('INBOX');
        try {
          for await (const msg of c0.fetch([...catOf.keys()], {
            uid: true, flags: true, labels: true, threadId: true, envelope: true, internalDate: true,
          }, { uid: true })) {
            const m = metaOf(msg, me);
            const t = info.get(m.threadId) || {
              category: catOf.get(msg.uid) || 'primary', subject: m.subject,
              fromName: m.fromName, fromDomain: m.fromDomain, fromAddress: m.fromAddress,
              anyUnread: false, anyKept: false, anyAnswered: false, anyShared: false, uids: [], latestInbox: 0,
            };
            t.anyUnread ||= !m.seen; t.anyKept ||= m.kept; t.anyAnswered ||= m.answered; t.anyShared ||= m.shared;
            t.uids.push(m.uid);
            if (m.received >= t.latestInbox) { t.latestInbox = m.received; t.fromName = m.fromName; t.fromDomain = m.fromDomain; t.fromAddress = m.fromAddress; t.subject = m.subject; }
            info.set(m.threadId, t);
          }
        } finally { lock.release(); }
      }
      lap(`inbox done (${info.size} threads)`);
      if (!info.size) return [];

      // PHASE B — resolve each thread against All Mail by X-GM-THRID, in parallel.
      // This always finds your original (even old cold-outreach) + every reply,
      // giving the true count and the true latest message.
      const allPath = await this.#mailboxPath(c0, '\\All');
      const ids = [...info.keys()];
      const resolved = new Map(); // threadId -> { count, latestUid }
      let idx = 0;
      await Promise.all(conns.map(async (client) => {
        const lock = await client.getMailboxLock(allPath);
        try {
          while (true) {
            const i = idx++; if (i >= ids.length) break;
            const tid = ids[i];
            if (/^u\d+$/.test(tid)) { resolved.set(tid, { count: 1, latestUid: null }); continue; }
            try {
              const uids = await client.search({ threadId: String(tid) }, { uid: true });
              const arr = uids || [];
              resolved.set(tid, { count: arr.length || 1, latestUid: arr.length ? arr.reduce((a, b) => (b > a ? b : a)) : null });
            } catch { resolved.set(tid, { count: 1, latestUid: null }); }
          }
        } finally { lock.release(); }
      }));
      lap('thread resolution (All Mail, parallel)');

      // PHASE C — fetch the latest message per thread (headline) + bodies, from All Mail.
      const latestUids = [...resolved.values()].map((r) => r.latestUid).filter(Boolean);
      const headByUid = new Map();
      if (latestUids.length) {
        const lock = await c0.getMailboxLock(allPath);
        try {
          const metas = [];
          for await (const msg of c0.fetch(latestUids, {
            uid: true, envelope: true, internalDate: true, bodyStructure: true,
          }, { uid: true })) {
            const m = metaOf(msg, me); metas.push(m); headByUid.set(msg.uid, m);
          }
          await this.#fillSnippets(c0, metas, 'a');
        } finally { lock.release(); }
      }
      lap('headline bodies');

      return ids.map((tid) => {
        const t = info.get(tid);
        const r = resolved.get(tid) || { count: 1, latestUid: null };
        const head = r.latestUid ? headByUid.get(r.latestUid) : null;
        return {
          threadId: tid,
          uid: t.uids[t.uids.length - 1],     // latest inbox uid — card identity + star target
          uids: t.uids,                       // all inbox uids, for marking the thread read
          category: t.category,
          subject: t.subject,
          fromName: t.fromName,               // the correspondent (from the inbox message)
          fromDomain: t.fromDomain,
          fromAddress: t.fromAddress,          // full address, for a proper "Name <email>" export
          received: head ? head.received : t.latestInbox,
          seen: !t.anyUnread, kept: t.anyKept, answered: t.anyAnswered,
          shared: t.anyShared, // shared out (Gmail label mizzle/sent) → solid share icon
          // "responded" = a real conversation whose LATEST message is mine. Requires
          // more than one message — a lone from-me item (e.g. a calendar/booking
          // confirmation sent as you) isn't a reply, so it stays hollow. If they wrote
          // back after my reply, the latest is theirs again → not responded.
          responded: head ? (!!head.fromMe && r.count > 1) : false,
          count: r.count,
          body: head ? ((head.fromMe ? 'You: ' : '') + (head.body || '')) : '',
          image: head ? head.image : null,
          event: head ? (head.event || null) : null, // {title,start,end,location,allDay} when the sender embedded it

        };
      }).sort((a, b) => b.received - a.received).slice(0, maxItems);
    } finally { /* persistent pool — keep connections warm between loads */ }
  }

  async #openClient() {
    const c = new ImapFlow(this.config);
    c.on('error', (err) => console.error('imap socket:', err.code || err.message));
    await c.connect();
    return c;
  }

  // A pool of authenticated connections kept warm across requests (avoids paying
  // the ~2.5s TLS+login handshake on every feed load). Recreated if any drop.
  async #getPool() {
    const POOL = 6; // leave headroom under Gmail's ~15-connection cap (+ ops conn)
    if (this._pool && this._pool.length === POOL && this._pool.every((c) => c.usable)) return this._pool;
    if (this._pool) await Promise.all(this._pool.map((c) => c.logout().catch(() => {})));
    this._pool = await Promise.all(Array.from({ length: POOL }, () => this.#openClient()));
    return this._pool;
  }

  // Gracefully LOGOUT every connection so Gmail frees the slots immediately on
  // shutdown — otherwise they linger server-side and pile up across restarts.
  async close() {
    const conns = [this._ops, ...(this._pool || [])].filter(Boolean);
    this._ops = null; this._pool = null;
    await Promise.all(conns.map((c) => Promise.resolve(c.logout?.()).catch(() => { try { c.close?.(); } catch { /* ignore */ } })));
    try { this._smtp?.close?.(); } catch { /* ignore */ }
  }

  // tag namespaces the body cache per mailbox ('i' INBOX, 'a' All Mail) since
  // IMAP UIDs are per-mailbox and would otherwise collide.
  async #fillSnippets(client, items, tag = 'i') {
    const byPart = new Map(); // part id -> items needing it
    for (const it of items) {
      const key = tag + it.uid;
      if (this.snippetCache.has(key)) {
        const c = this.snippetCache.get(key);
        it.body = c.body; it.image = c.image; it.event = c.event || null; continue;
      }
      if (!it.textPart) continue;
      const g = byPart.get(it.textPart.part) || [];
      g.push(it); byPart.set(it.textPart.part, g);
    }
    for (const [part, group] of byPart) {
      const map = new Map(group.map((it) => [it.uid, it]));
      try {
        for await (const msg of client.fetch([...map.keys()], { uid: true, bodyParts: [part] }, { uid: true })) {
          const it = map.get(msg.uid);
          if (!it) continue; // fetch returned a uid we didn't ask for — skip, don't abort the group
          const raw = msg.bodyParts && msg.bodyParts.get(part);
          let body = '', image = null, event = null;
          if (raw) {
            let text = decodePart(raw, it.textPart.encoding, it.textPart.charset);
            if (it.textPart.isHtml) { image = extractImage(text); event = extractEvent(text); text = stripHtml(text); }
            body = cleanBody(text);
          }
          it.body = body; it.image = image; it.event = event;
          this.snippetCache.set(tag + it.uid, { body, image, event });
        }
      } catch (e) { console.error(`body part ${part}:`, e.message); }
    }

    // Second pass: parse .ics parts for any item that didn't get an event from JSON-LD.
    const calByPart = new Map();
    for (const it of items) {
      if (!it.calPart || it.event) continue;
      const g = calByPart.get(it.calPart.part) || [];
      g.push(it); calByPart.set(it.calPart.part, g);
    }
    for (const [part, group] of calByPart) {
      const map = new Map(group.map((it) => [it.uid, it]));
      try {
        for await (const msg of client.fetch([...map.keys()], { uid: true, bodyParts: [part] }, { uid: true })) {
          const it = map.get(msg.uid);
          if (!it) continue;
          const raw = msg.bodyParts && msg.bodyParts.get(part);
          if (!raw) continue;
          const ev = parseIcs(decodePart(raw, it.calPart.encoding, it.calPart.charset));
          if (ev) { it.event = ev; this.snippetCache.set(tag + it.uid, { body: it.body, image: it.image, event: ev }); }
        }
      } catch (e) { console.error(`ics part ${part}:`, e.message); }
    }
  }

  // The WHOLE Gmail thread (All Mail, incl. your sent replies & archived msgs),
  // by X-GM-THRID. Used to expand "view thread". Returns chronological messages.
  // Resolve one thread on an already-All-Mail-locked client → {count, messages}.
  async #resolveThreadOn(client, threadId, me) {
    let uids = [];
    try { uids = await client.search({ threadId: String(threadId) }, { uid: true }); }
    catch (e) { console.error('thread search:', e.message); }
    if (!uids || !uids.length) return { count: 0, messages: [] };
    const want = String(threadId);
    const metas = [];
    for await (const msg of client.fetch(uids, {
      uid: true, flags: true, threadId: true, envelope: true, internalDate: true, bodyStructure: true,
    }, { uid: true })) {
      metas.push(metaOf(msg, me)); // keep threadId for the membership check below
    }
    // Guard: only messages that actually belong to THIS Gmail thread and have a real
    // sender. Drops any stray/senderless ("unknown") message that shouldn't be here.
    const clean = metas.filter((m) => String(m.threadId) === want && !(m.fromName === 'unknown' && !m.fromAddress));
    await this.#fillSnippets(client, clean, 'a');
    clean.sort((a, b) => a.received - b.received);
    return {
      count: clean.length,
      messages: clean.map((m) => ({
        fromName: m.fromMe ? 'You' : m.fromName,
        fromDomain: m.fromDomain, received: m.received, seen: m.seen, body: m.body, fromMe: m.fromMe,
      })),
    };
  }

  async fetchThread(threadId) {
    const me = (this.config.auth.user || '').toLowerCase();
    return this.#withClient((client) => this.#resolveThreadOn(client, threadId, me), 'ALL');
  }

  // Resolve MANY threads in parallel across the build pool (NOT the single ops
  // connection) so aggressive background preloading never stalls mark-as-read.
  async fetchThreads(threadIds) {
    const ids = [...new Set(threadIds)].filter(Boolean).slice(0, 40);
    if (!ids.length) return {};
    const me = (this.config.auth.user || '').toLowerCase();
    const conns = await this.#getPool();
    const allPath = await this.#mailboxPath(conns[0], '\\All');
    const out = {};
    let idx = 0;
    await Promise.all(conns.map(async (client) => {
      const lock = await client.getMailboxLock(allPath);
      try {
        while (true) {
          const i = idx++; if (i >= ids.length) break;
          try { out[ids[i]] = await this.#resolveThreadOn(client, ids[i], me); }
          catch { out[ids[i]] = { count: 0, messages: [] }; }
        }
      } finally { lock.release(); }
    }));
    return out;
  }

  // Mark a whole thread read (all its in-window messages).
  async markSeen(uids) {
    const range = Array.isArray(uids) ? uids : [uids];
    return this.#withClient((c) => c.messageFlagsAdd(range, ['\\Seen'], { uid: true }));
  }

  async keep(uid, on = true) {
    return this.#withClient((c) => {
      const op = on ? c.messageFlagsAdd.bind(c) : c.messageFlagsRemove.bind(c);
      return op([uid], ['\\Flagged'], { uid: true });
    });
  }

  async markAnswered(uid) {
    return this.#withClient((c) => c.messageFlagsAdd([uid], ['\\Answered'], { uid: true }));
  }

  // Faithful export of the real raw message source: a single .eml (RFC 5322) or,
  // for a multi-message thread, an .mbox (the format local mail stores / SMTP use).
  // scope 'email' → just the latest message (.eml); 'thread' → the whole conversation (.mbox).
  async downloadBundle({ threadId, uid, scope = 'thread' }) {
    const collect = async (client, uids) => {
      const msgs = [];
      for await (const m of client.fetch(uids, { uid: true, source: true, envelope: true, internalDate: true }, { uid: true })) {
        const from = (m.envelope && m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || 'unknown@localhost';
        msgs.push({ source: m.source, from, date: m.internalDate || (m.envelope && m.envelope.date) || null });
      }
      msgs.sort((a, b) => (a.date ? +new Date(a.date) : 0) - (b.date ? +new Date(b.date) : 0));
      return buildBundle(msgs);
    };
    if (threadId && /^\d+$/.test(String(threadId))) { // real Gmail thread, in All Mail
      return this.#withClient(async (c) => {
        let uids = (await c.search({ threadId: String(threadId) }, { uid: true })) || [];
        if (scope === 'email' && uids.length) uids = [uids.reduce((a, b) => (b > a ? b : a))]; // latest message only
        return collect(c, uids);
      }, 'ALL');
    }
    return this.#withClient((c) => collect(c, [Number(uid)])); // lone INBOX message
  }

  // Mark a thread as shared (calendar / download / copy) with a Gmail label — syncs
  // across devices, unlike a localStorage flag. Writes mizzle/sent; on un-share removes
  // both the new and legacy labels.
  async share(uids, on = true) {
    const range = (Array.isArray(uids) ? uids : [uids]).filter(Boolean);
    if (!range.length) return { ok: false };
    return this.#withClient((c) => (on
      ? c.messageFlagsAdd(range, [SENT_LABEL], { uid: true, useLabels: true })
      : c.messageFlagsRemove(range, [SENT_LABEL, LEGACY_SENT_LABEL], { uid: true, useLabels: true })));
  }

  // What happens to a message when it mizzles out of the feed (MIZZLE_TO):
  //   'inbox'   → nothing (just hidden from the feed)  [caller skips this entirely]
  //   'archive' → move out of INBOX into All Mail (non-destructive, still searchable)
  //   'trash'   → move to Trash (recoverable ~30d, then gone)
  // Operates on INBOX uids; moving FROM INBOX is what removes the Inbox label.
  async applyFate(uids, mode) {
    const range = (Array.isArray(uids) ? uids : [uids]).filter(Boolean);
    if (!range.length || mode === 'inbox') return { moved: 0 };
    const flag = mode === 'trash' ? '\\Trash' : '\\All';
    return this.#withClient(async (c) => {
      const target = await this.#mailboxPath(c, flag);
      await c.messageMove(range, target, { uid: true });
      return { moved: range.length, target };
    });
  }

  #smtp() {
    if (this._smtp) return this._smtp;
    this._smtp = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: this.config.auth.user, pass: this.config.auth.pass },
    });
    return this._smtp;
  }

  // Reply to the message `uid` (a received message) over SMTP. Gmail auto-saves
  // the sent copy to Sent → it threads via In-Reply-To and surfaces in the feed.
  async sendReply({ uid, text }) {
    const env = await this.#withClient(async (c) => {
      let e = null;
      for await (const msg of c.fetch([Number(uid)], { uid: true, envelope: true }, { uid: true })) e = msg.envelope;
      return e;
    });
    if (!env) throw new Error('message not found');
    const from = (env.from && env.from[0]) || {};
    const to = from.address;
    if (!to) throw new Error('no recipient on the original message');
    const subject = /^\s*re:/i.test(env.subject || '') ? env.subject : `Re: ${env.subject || ''}`;
    const messageId = env.messageId || undefined;

    await this.#smtp().sendMail({
      from: this.config.auth.user,
      to,
      subject,
      inReplyTo: messageId,
      references: messageId ? [messageId] : undefined,
      text,
    });
    try { await this.markAnswered(Number(uid)); } catch (e) { console.error('markAnswered:', e.message); }
    return { to, subject };
  }

  async verifySmtp() { return this.#smtp().verify(); }
}

// Find the content part. Prefer text/html (so we can pull a hero image AND a
// text head from it); fall back to text/plain when there's no HTML.
function findTextPart(node, plain = { v: null }, html = { v: null }) {
  if (!node) return null;
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) findTextPart(child, plain, html);
  } else {
    const type = (node.type || '').toLowerCase();
    const part = node.part || '1';
    const encoding = (node.encoding || '').toLowerCase();
    const charset = normCharset(node.parameters && node.parameters.charset);
    if (type === 'text/plain' && !plain.v) plain.v = { part, isHtml: false, encoding, charset };
    else if (type === 'text/html' && !html.v) html.v = { part, isHtml: true, encoding, charset };
  }
  return html.v || plain.v;
}

// Find a text/calendar (.ics) attachment part — the other deterministic event source.
function findCalendarPart(node, out = { v: null }) {
  if (!node || out.v) return out.v;
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) findCalendarPart(child, out);
  } else {
    const type = (node.type || '').toLowerCase();
    const fn = (node.dispositionParameters?.filename || node.parameters?.name || '').toLowerCase();
    if (type === 'text/calendar' || type === 'application/ics' || fn.endsWith('.ics')) {
      out.v = { part: node.part || '1', encoding: (node.encoding || '').toLowerCase(), charset: normCharset(node.parameters && node.parameters.charset) };
    }
  }
  return out.v;
}

// Minimal VEVENT parser — pulls the first event's summary/start/end/location.
function parseIcs(ics) {
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
function upscaleThumb(src) {
  return src.replace(/(f4\.bcbits\.com\/img\/[a-z0-9]+)_\d+(\.jpg)/i, '$1_16$2');
}

const MIN_HERO = 64; // px — anything declared smaller is an icon/thumb, not a hero image

// Best image in the HTML — skips tracking pixels/spacers AND tiny thumbnails,
// prefers a content image over a header logo/icon, and upscales known size-coded
// thumbnails. Returns null when there's nothing worth showing (better than a blurry
// 50px thumb): a card with no real image renders clean text instead.
function extractImage(html) {
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
function extractEvent(html) {
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
function findEventNode(node, depth = 0) {
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

function normCharset(cs) {
  const c = (cs || 'utf-8').toLowerCase();
  if (/utf-?8/.test(c)) return 'utf8';
  if (/8859-1|latin1|windows-1252|ascii/.test(c)) return 'latin1';
  return 'utf8';
}

// Decode transfer-encoding to BYTES first, then interpret with the charset,
// so multibyte UTF-8 (e.g. "í", nbsp) reassembles correctly.
function decodePart(buf, encoding, charset = 'utf8') {
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

// Extract common message metadata from a fetched message.
function metaOf(msg, me) {
  const env = msg.envelope || {};
  const from = (env.from && env.from[0]) || {};
  const addr = (from.address || '').toLowerCase();
  const flags = msg.flags || new Set();
  return {
    uid: msg.uid,
    threadId: msg.threadId || `u${msg.uid}`,
    subject: env.subject || '(no subject)',
    fromName: from.name || from.address || 'unknown',
    fromAddress: addr,
    fromDomain: addr.split('@')[1] || '',
    received: (msg.internalDate || env.date || new Date(0)).valueOf(),
    seen: flags.has('\\Seen'),
    kept: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    fromMe: addr === me,
    shared: msg.labels ? (msg.labels.has(SENT_LABEL) || msg.labels.has(LEGACY_SENT_LABEL)) : false, // shared out (Gmail label)
    textPart: findTextPart(msg.bodyStructure),
    calPart: findCalendarPart(msg.bodyStructure), // text/calendar (.ics) part, if any
    body: '', image: null, event: null,
  };
}

// Gmail label marking "I shared this out" (calendar / download / copy). Lives in Gmail
// so the state syncs across devices. mizzle/sent is preferred; mizzle/ejected is the
// legacy name, still read for backwards compatibility.
const SENT_LABEL = 'mizzle/sent';
const LEGACY_SENT_LABEL = 'mizzle/ejected';

// Wrap raw message source(s) into a downloadable bundle: .eml for one, .mbox for many.
function buildBundle(msgs) {
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
function hostOnlyLabel(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)?([?#].*)?$/i.exec(url);
  if (!m) return null;
  const path = (m[2] || '').replace(/\/+$/, '');
  return (!path && !m[3]) ? m[1] : null;
}

function stripHtml(html) {
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
function trimQuoted(text) {
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

function cleanBody(text) {
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
function dedupeLinks(s) {
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

function gmDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}

// exported for unit tests (pure helpers, no IMAP)
export { metaOf, findTextPart, findCalendarPart, decodePart, stripHtml, trimQuoted, cleanBody, extractImage, extractEvent, parseIcs, gmDate };
