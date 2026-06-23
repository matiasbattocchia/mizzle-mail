// gmail.ts — GmailTransport: the same method surface as the self-hosted ImapTransport
// (buildFeed / fetchThread / fetchThreads / markSeen / keep / share / sendReply /
// downloadBundle / applyFate), but over the Gmail REST API via fetch instead of IMAP.
//
// It reuses the SAME pure parsers as the relay (../../server/mail-text.js) and the
// SAME decay model (../../server/decay.js, used by the caller), so a card looks and
// decays identically in both builds. Gmail's API makes threading native (every
// message carries threadId), so this is markedly simpler than the IMAP thread walk.

import {
  gmDate, stripHtml, extractImage, extractEvent, cleanBody, parseIcs,
  buildBundle, normCharset, SENT_LABEL, LEGACY_SENT_LABEL,
} from '../../server/mail-text.js';

// Mirrors server/transport.js (kept local — transport.js pulls in imapflow, which
// is Node-only and won't bundle on Workers).
export const CATEGORIES = ['primary', 'updates', 'social', 'forums', 'promotions'];

// Map a message's Gmail CATEGORY_* labels to our category name. No category label
// (or CATEGORY_PERSONAL) means Primary — the same buckets the inbox tabs use.
function categoryOf(msg: { labelIds?: string[] }): string {
  const labels = msg.labelIds || [];
  if (labels.includes('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labels.includes('CATEGORY_SOCIAL')) return 'social';
  if (labels.includes('CATEGORY_FORUMS')) return 'forums';
  if (labels.includes('CATEGORY_UPDATES')) return 'updates';
  return 'primary';
}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GHeader { name: string; value: string; }
interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart;
  raw?: string;
}

function header(msg: GMessage, name: string): string {
  const hs = msg.payload?.headers || [];
  const h = hs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// "Display Name <addr@host>" | "addr@host" -> { name, address }. Forgiving: real From
// headers can be malformed/doubled (e.g. '"Name <a@b>" <a@b>'), so we grab the LAST
// angle-bracketed address (the real envelope addr), or any email token, rather than
// requiring a clean shape — otherwise a brittle match falls back to the whole string
// as the "address" and our own messages stop matching `me` (→ name+email, not "You").
function parseAddress(raw: string): { name: string; address: string } {
  if (!raw) return { name: '', address: '' };
  const angles = [...raw.matchAll(/<([^>]+)>/g)];
  if (angles.length) {
    const address = angles[angles.length - 1][1].trim().toLowerCase();
    const name = raw.slice(0, raw.indexOf('<')).replace(/"/g, '').trim();
    return { name, address };
  }
  const em = raw.match(/[^\s<>@,;]+@[^\s<>@,;]+/);
  if (em) return { name: raw.replace(em[0], '').replace(/["<>]/g, '').trim(), address: em[0].toLowerCase() };
  return { name: '', address: raw.trim().toLowerCase() };
}

function parseAddressList(raw: string): { name?: string; address: string }[] {
  if (!raw) return [];
  // split on commas not inside quotes/angle brackets (good enough for header lists)
  return raw.split(/,(?![^<]*>)/).map((s) => parseAddress(s)).filter((a) => a.address);
}

// base64url -> string in the part's charset. Gmail already strips the part's
// Content-Transfer-Encoding, so body.data decodes straight to bytes.
function decodeData(data: string | undefined, charset = 'utf8'): string {
  if (!data) return '';
  try { return Buffer.from(data, 'base64url').toString(charset as BufferEncoding); }
  catch { return Buffer.from(data, 'base64url').toString('utf8'); }
}

function partCharset(part: GPart): string {
  const ct = (part.headers || []).find((h) => h.name.toLowerCase() === 'content-type')?.value
    || part.mimeType || '';
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)/i);
  return normCharset(m ? m[1] : undefined);
}

// Walk the MIME tree: prefer text/html (for image + event extraction), fall back to
// text/plain. Skips attachments. Mirrors findTextPart's preference order.
function findTextPart(part: GPart | undefined, acc: { html?: GPart; plain?: GPart } = {}): { html?: GPart; plain?: GPart } {
  if (!part) return acc;
  if (part.parts && part.parts.length) { for (const p of part.parts) findTextPart(p, acc); return acc; }
  const type = (part.mimeType || '').toLowerCase();
  if (part.filename) return acc; // an attachment, not body
  if (type === 'text/html' && !acc.html) acc.html = part;
  else if (type === 'text/plain' && !acc.plain) acc.plain = part;
  return acc;
}

function findCalendarPart(part: GPart | undefined): GPart | null {
  if (!part) return null;
  if (part.parts && part.parts.length) { for (const p of part.parts) { const r = findCalendarPart(p); if (r) return r; } return null; }
  const type = (part.mimeType || '').toLowerCase();
  const fn = (part.filename || '').toLowerCase();
  if (type === 'text/calendar' || type === 'application/ics' || fn.endsWith('.ics')) return part;
  return null;
}

// Bounded-concurrency map (Gmail per-user rate limits are generous, but don't fan out
// 50 thread.get calls at once).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++; if (i >= items.length) break;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null as unknown as R; }
    }
  });
  await Promise.all(workers);
  return out;
}

export class GmailTransport {
  private sentLabelId: string | null = null;
  private sharedLabelIds: string[] = [];

  constructor(private accessToken: string, private email: string) {
    this.email = (email || '').toLowerCase();
  }

  // --- REST plumbing --------------------------------------------------------
  private async api(path: string, init: RequestInit = {}): Promise<any> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`gmail ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }

  private sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  // ONE batched HTTP call (Gmail batch endpoint). Returns per-input { status, json }
  // aligned to `paths` order, so the caller can tell a rate-limited 429 from a 200.
  private async batchOnce(paths: string[]): Promise<{ status: number; json: any | null }[]> {
    const out = paths.map(() => ({ status: 0, json: null as any }));
    const boundary = 'mizzle_batch';
    const body = paths.map((p, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${i}>\r\n\r\nGET ${p}\r\n`,
    ).join('') + `--${boundary}--\r\n`;
    const res = await fetch('https://gmail.googleapis.com/batch/gmail/v1', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}`, 'content-type': `multipart/mixed; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`batch ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    const bm = (res.headers.get('content-type') || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const respBoundary = ((bm && (bm[1] || bm[2])) || '').trim();
    if (!respBoundary) throw new Error('batch: no response boundary');
    for (const part of text.split(`--${respBoundary}`)) {
      const idm = part.match(/Content-ID:\s*<?response-item-(\d+)>?/i);
      if (!idm) continue;
      const i = Number(idm[1]);
      const statusM = part.match(/HTTP\/\d\.\d (\d{3})/);
      out[i].status = statusM ? Number(statusM[1]) : 0;
      if (out[i].status === 200) {
        const bs = part.indexOf('\r\n\r\n', part.indexOf(statusM![0]));
        if (bs >= 0) { try { out[i].json = JSON.parse(part.slice(bs + 4).trim()); } catch { /* leave null */ } }
      }
    }
    return out;
  }

  // Fetch many GETs via batched HTTP, THROTTLED under Gmail's per-user quota and
  // RETRYING rate-limited items. threads.get costs 10 quota units and the cap is
  // ~250/sec, so a single 74-item batch gets ~half its ops 429'd — the cause of the
  // feed dropping/shuffling threads. We send ~20 per second and retry 429/5xx items
  // a few times so every thread eventually lands. Returns JSON aligned to `paths`.
  private async batchGet(paths: string[]): Promise<(any | null)[]> {
    const results: (any | null)[] = new Array(paths.length).fill(null);
    let pending = paths.map((p, i) => ({ p, i }));
    const CHUNK = 20;   // 20 × 10 units = 200/sec, comfortably under the ~250/sec cap
    const ROUNDS = 4;
    for (let round = 0; round < ROUNDS && pending.length; round++) {
      const next: { p: string; i: number }[] = [];
      for (let s = 0; s < pending.length; s += CHUNK) {
        if (s > 0 || round > 0) await this.sleep(1100); // one chunk per ~second
        const group = pending.slice(s, s + CHUNK);
        const got = await this.batchOnce(group.map((g) => g.p));
        group.forEach((g, k) => {
          const r = got[k];
          if (r.status === 200) results[g.i] = r.json;
          else if (r.status === 429 || r.status >= 500 || r.status === 0) next.push(g); // retriable
          // permanent failures (404/403) → leave null
        });
      }
      pending = next;
    }
    return results;
  }

  // Resolve (and lazily create) the mizzle/sent label so `shared` state lives in Gmail
  // and syncs across devices. Also notes the legacy mizzle/ejected id, if present.
  private async ensureLabels(): Promise<void> {
    if (this.sentLabelId) return;
    const { labels = [] } = await this.api('/labels');
    const byName = new Map<string, string>(labels.map((l: any) => [l.name, l.id]));
    this.sentLabelId = byName.get(SENT_LABEL) || null;
    const legacy = byName.get(LEGACY_SENT_LABEL);
    if (!this.sentLabelId) {
      const created = await this.api('/labels', {
        method: 'POST',
        body: JSON.stringify({ name: SENT_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
      });
      this.sentLabelId = created.id;
    }
    this.sharedLabelIds = [this.sentLabelId!, ...(legacy ? [legacy] : [])];
  }

  // --- feed -----------------------------------------------------------------
  async buildFeed({ cutoff, limit = 80 }: { cutoff: string; limit?: number }) {
    await this.ensureLabels();
    const after = gmDate(cutoff);

    // The most-recent inbox threads after the onboarding cutoff. We list MESSAGES, not
    // threads: `threads.list` orders by thread age, so an OLD thread with a fresh reply
    // sorts to the bottom and falls out of the window (a recent reply on a long-running
    // conversation would silently vanish). `messages.list` is ordered by message date
    // (newest first), so we dedupe its threadIds to get threads by latest activity.
    const data = await this.api(`/messages?q=${encodeURIComponent(`in:inbox after:${after}`)}&maxResults=${limit * 3}`)
      .catch(() => ({ messages: [] }));
    const seen = new Set<string>();
    const tids: string[] = [];
    for (const m of (data.messages || []) as { threadId: string }[]) {
      if (seen.has(m.threadId)) continue;
      seen.add(m.threadId);
      tids.push(m.threadId);
      if (tids.length >= limit) break;
    }
    if (!tids.length) return [];

    // Fetch every candidate thread in ONE batched HTTP call (Gmail batches up to 100
    // sub-requests per call) — otherwise a per-thread fetch blows past the Worker's
    // subrequest cap and silently drops threads, making the feed non-idempotent.
    const threads = await this.batchGet(tids.map((t) => `/gmail/v1/users/me/threads/${t}?format=full`));
    const items = [];
    for (let i = 0; i < tids.length; i++) {
      const th = threads[i];
      if (!th) continue;
      const item = this.threadToFeedItem(tids[i], th.messages || []);
      if (item) items.push(item);
    }
    // Tiebreak equal timestamps (same-second arrivals are common) by uid so the order
    // is a total order — identical on every reload, no within-category shuffling.
    return items
      .sort((a, b) => (b.received - a.received) || String(b.uid).localeCompare(String(a.uid)));
  }

  private async getThread(threadId: string): Promise<{ messages: GMessage[] }> {
    return await this.api(`/threads/${threadId}?format=full`);
  }

  // Headline body + image + event from a single message's payload.
  private parseMessageBody(msg: GMessage): { body: string; image: string | null; event: any } {
    const { html, plain } = findTextPart(msg.payload);
    let body = '', image: string | null = null, event: any = null;
    const part = html || plain;
    if (part) {
      let text = decodeData(part.body?.data, partCharset(part));
      if (html) { image = extractImage(text); event = extractEvent(text); text = stripHtml(text); }
      body = cleanBody(text);
    }
    if (!event) {
      const cal = findCalendarPart(msg.payload);
      if (cal) { const ev = parseIcs(decodeData(cal.body?.data, partCharset(cal))); if (ev) event = ev; }
    }
    return { body, image, event };
  }

  private threadToFeedItem(threadId: string, msgs: GMessage[]) {
    if (!msgs.length) return null;
    const me = this.email;
    const inbox = msgs.filter((m) => (m.labelIds || []).includes('INBOX'));
    const last = msgs[msgs.length - 1];                 // newest overall (incl. my sent replies)
    const headMsg = inbox.length ? inbox[inbox.length - 1] : last; // the correspondent's latest
    const category = categoryOf(headMsg);               // from Gmail's CATEGORY_* labels

    const lastFrom = parseAddress(header(last, 'From'));
    const fromMe = lastFrom.address === me;
    const count = msgs.length;
    const anyUnread = inbox.some((m) => (m.labelIds || []).includes('UNREAD'));
    const anyKept = inbox.some((m) => (m.labelIds || []).includes('STARRED'));
    const anyShared = this.sharedLabelIds.length
      ? msgs.some((m) => (m.labelIds || []).some((l) => this.sharedLabelIds.includes(l))) : false;
    const anyFromMe = msgs.some((m) => parseAddress(header(m, 'From')).address === me);

    const corr = parseAddress(header(headMsg, 'From'));
    const fromAddress = corr.address;
    const parsed = this.parseMessageBody(last);

    return {
      threadId,
      uid: (inbox.length ? inbox[inbox.length - 1] : last).id, // card identity + star target
      uids: inbox.map((m) => m.id),                            // inbox messages, for marking read
      category,
      subject: header(headMsg, 'Subject') || '(no subject)',
      fromName: corr.name || fromAddress || 'unknown',
      fromDomain: fromAddress.split('@')[1] || '',
      fromAddress,
      received: Number(last.internalDate) || 0,
      seen: !anyUnread,
      kept: anyKept,
      answered: count > 1 && anyFromMe,
      shared: anyShared,
      // "responded" = a real conversation whose LATEST message is mine (count > 1).
      responded: fromMe && count > 1,
      count,
      body: (fromMe ? 'You: ' : '') + (parsed.body || ''),
      image: parsed.image,
      event: parsed.event || null,
    };
  }

  // --- thread expansion -----------------------------------------------------
  // Chronological, frontend-shaped view of a thread's messages.
  private threadView(rawMsgs: GMessage[]) {
    const me = this.email;
    const msgs = (rawMsgs || []).filter((m) => {
      const f = parseAddress(header(m, 'From'));
      return f.address || f.name; // drop senderless strays
    });
    msgs.sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0));
    return {
      count: msgs.length,
      messages: msgs.map((m) => {
        const f = parseAddress(header(m, 'From'));
        const fromMe = f.address === me;
        const { body } = this.parseMessageBody(m);
        return {
          fromName: fromMe ? 'You' : (f.name || f.address),
          fromDomain: f.address.split('@')[1] || '',
          received: Number(m.internalDate) || 0,
          seen: !(m.labelIds || []).includes('UNREAD'),
          body,
          fromMe,
        };
      }),
    };
  }

  async fetchThread(threadId: string) {
    let th: { messages?: GMessage[] };
    try { th = await this.getThread(threadId); } catch { return { count: 0, messages: [] }; }
    return this.threadView(th.messages || []);
  }

  // Many threads at once via ONE batched HTTP call (avoids the per-request subrequest cap).
  async fetchThreads(threadIds: string[]) {
    const ids = [...new Set(threadIds)].filter(Boolean).slice(0, 100);
    const out: Record<string, any> = {};
    const threads = await this.batchGet(ids.map((id) => `/gmail/v1/users/me/threads/${id}?format=full`));
    ids.forEach((id, i) => { out[id] = threads[i] ? this.threadView(threads[i].messages || []) : { count: 0, messages: [] }; });
    return out;
  }

  // --- mutations ------------------------------------------------------------
  private async batchModify(ids: string[], add: string[] = [], remove: string[] = []): Promise<void> {
    const list = ids.filter(Boolean);
    if (!list.length) return;
    await this.api('/messages/batchModify', {
      method: 'POST',
      body: JSON.stringify({ ids: list, addLabelIds: add, removeLabelIds: remove }),
    });
  }

  async markSeen(uids: string | string[]) {
    const ids = Array.isArray(uids) ? uids : [uids];
    await this.batchModify(ids, [], ['UNREAD']);
    return { ok: true };
  }

  async keep(uid: string, on = true) {
    await this.api(`/messages/${uid}/modify`, {
      method: 'POST',
      body: JSON.stringify(on ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }),
    });
    return { ok: true };
  }

  async share(uids: string | string[], on = true) {
    await this.ensureLabels();
    const ids = (Array.isArray(uids) ? uids : [uids]).filter(Boolean);
    if (!ids.length) return { ok: false };
    if (on) await this.batchModify(ids, [this.sentLabelId!], []);
    else await this.batchModify(ids, [], this.sharedLabelIds);
    return { ok: true };
  }

  // MIZZLE_TO fate: archive (drop INBOX) or trash (add TRASH, drop INBOX).
  async applyFate(uids: string | string[], mode: string) {
    const ids = (Array.isArray(uids) ? uids : [uids]).filter(Boolean);
    if (!ids.length || mode === 'inbox') return { moved: 0 };
    if (mode === 'trash') await this.batchModify(ids, ['TRASH'], ['INBOX']);
    else await this.batchModify(ids, [], ['INBOX']);
    return { moved: ids.length, target: mode };
  }

  // --- download (raw .eml / .mbox) ------------------------------------------
  async downloadBundle({ threadId, uid, scope = 'thread' }: { threadId?: string; uid?: string; scope?: string }) {
    let ids: string[] = [];
    if (threadId) {
      const th = await this.getThread(threadId).catch(() => ({ messages: [] as GMessage[] }));
      const msgs = (th.messages || []).slice().sort((a, b) => (Number(a.internalDate) || 0) - (Number(b.internalDate) || 0));
      ids = scope === 'email' && msgs.length ? [msgs[msgs.length - 1].id] : msgs.map((m) => m.id);
    } else if (uid) {
      ids = [uid];
    }
    if (!ids.length) return null;
    const raws = await mapLimit(ids, 6, async (id) => {
      const m: GMessage = await this.api(`/messages/${id}?format=raw`);
      const source = Buffer.from(m.raw || '', 'base64url');
      const from = parseAddress(header(m, 'From')).address || 'unknown@localhost';
      return { source, from, date: Number(m.internalDate) || null };
    });
    const msgs = raws.filter(Boolean).sort((a, b) => (a.date || 0) - (b.date || 0));
    return buildBundle(msgs);
  }

  // --- reply (reply-all) ----------------------------------------------------
  async sendReply({ uid, text }: { uid: string; text: string }) {
    const msg: GMessage = await this.api(`/messages/${uid}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID`);
    const me = this.email;
    const from = parseAddress(header(msg, 'From'));
    const replyTo = parseAddress(header(msg, 'Reply-To'));
    const sender = replyTo.address ? replyTo : from;
    if (!sender.address) throw new Error('no recipient on the original message');

    // Reply-all: To = sender; Cc = every other original recipient, minus me and sender.
    const seen = new Set([me, sender.address]);
    const cc: { name?: string; address: string }[] = [];
    for (const a of [...parseAddressList(header(msg, 'To')), ...parseAddressList(header(msg, 'Cc'))]) {
      if (seen.has(a.address)) continue;
      seen.add(a.address);
      cc.push(a);
    }
    const rawSubject = header(msg, 'Subject') || '';
    const subject = /^\s*re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
    const messageId = header(msg, 'Message-ID') || header(msg, 'Message-Id');

    const fmt = (a: { name?: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
    const lines = [
      `From: ${me}`,
      `To: ${fmt(sender)}`,
      ...(cc.length ? [`Cc: ${cc.map(fmt).join(', ')}`] : []),
      `Subject: ${subject}`,
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${messageId}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      text,
    ];
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
    await this.api('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw, threadId: msg.threadId }),
    });
    return { to: sender.address, cc: cc.map((a) => a.address), subject };
  }
}
