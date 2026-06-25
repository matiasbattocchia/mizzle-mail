// MailTransport: the swappable seam (IMAP today; DirectSockets/IWA later).
// Key constraint: the inbox can be 37k+ messages, so we NEVER page it — we pull
// bounded per-category, post-cutoff slices using Gmail's search over IMAP.

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import {
  SENT_LABEL, LEGACY_SENT_LABEL,
  normCharset, decodePart, gmDate,
  stripHtml, cleanBody, extractImage, extractEvent,
  parseIcs, buildBundle,
} from './mail-text.js';

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
          // open the thread in Gmail (X-GM-THRID → thread-f permalink); '' for non-threads
          threadUrl: /^\d+$/.test(String(tid)) ? `https://mail.google.com/mail/u/0/#all/thread-f:${tid}` : '',
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
      }).sort((a, b) => (b.received - a.received) || String(b.uid).localeCompare(String(a.uid))).slice(0, maxItems);
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
        fromDomain: m.fromDomain, fromAddress: m.fromAddress, received: m.received, seen: m.seen, body: m.body, fromMe: m.fromMe,
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

  // Like (star) / unlike. `kept` is true if ANY inbox message is flagged, so un-like
  // must clear \Flagged from every message in the thread; on like, flag the latest.
  async keep(uids, on = true) {
    const range = (Array.isArray(uids) ? uids : [uids]).filter(Boolean);
    if (!range.length) return;
    return this.#withClient((c) => (on
      ? c.messageFlagsAdd([range[range.length - 1]], ['\\Flagged'], { uid: true })
      : c.messageFlagsRemove(range, ['\\Flagged'], { uid: true })));
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
    const port = Number(process.env.SMTP_PORT || 465);
    this._smtp = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port, secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: this.config.auth.user, pass: this.config.auth.pass },
      // fail fast instead of hanging forever when a host blocks outbound SMTP
      connectionTimeout: 12000, greetingTimeout: 10000, socketTimeout: 20000,
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
    const replyTo = (env.replyTo && env.replyTo[0]) || null;
    const sender = replyTo && replyTo.address ? replyTo : from; // honor Reply-To, else From
    if (!sender.address) throw new Error('no recipient on the original message');

    // Reply-all: To = the sender; Cc = every other original recipient (To + Cc),
    // minus me and minus the sender. Dedupe by address, keep display names.
    const me = (this.config.auth.user || '').toLowerCase();
    const seen = new Set([me, sender.address.toLowerCase()]);
    const cc = [];
    for (const a of [...(env.to || []), ...(env.cc || [])]) {
      if (!a || !a.address) continue;
      const low = a.address.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      cc.push({ name: a.name || undefined, address: a.address });
    }
    const subject = /^\s*re:/i.test(env.subject || '') ? env.subject : `Re: ${env.subject || ''}`;
    const messageId = env.messageId || undefined;

    await this.#smtp().sendMail({
      from: this.config.auth.user,
      to: { name: sender.name || undefined, address: sender.address },
      cc: cc.length ? cc : undefined,
      subject,
      inReplyTo: messageId,
      references: messageId ? [messageId] : undefined,
      text,
    });
    try { await this.markAnswered(Number(uid)); } catch (e) { console.error('markAnswered:', e.message); }
    return { to: sender.address, cc: cc.map((a) => a.address), subject };
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

// IMAP-shape-coupled helpers (metaOf, findTextPart, findCalendarPart) live here;
// the pure string/Buffer helpers live in ./mail-text.js. Re-export both groups so
// existing test imports (`from './transport.js'`) keep resolving unchanged.
export { metaOf, findTextPart, findCalendarPart };
export { decodePart, stripHtml, trimQuoted, cleanBody, extractImage, extractEvent, parseIcs, gmDate } from './mail-text.js';
