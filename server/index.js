import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapTransport, CATEGORIES } from './transport.js';
import { decayState, humanRemaining } from './decay.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const SEED_DAYS = Number(process.env.SEED_DAYS || 3);
// What to do with an email once it mizzles (decays out of the feed):
//   inbox  (default, safe no-op)
//   archive (out of Inbox → All Mail)
//   trash  (→ Trash, recoverable ~30d)
//   mixed  (touched it → archive; untouched noise → trash). "Touched" = liked, shared, or replied.
const MIZZLE_TO = (() => {
  const v = (process.env.MIZZLE_TO || 'inbox').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'mixed') return 'mixed';
  if (v === 'trash' || v === 'delete') return 'trash';
  if (v === 'archive' || v === 'allmail') return 'archive';
  return 'inbox';
})();
// an item is "kept worth archiving" if the user interacted with it at all
const touched = (m) => !!(m.kept || m.answered || m.shared);

const { EMAIL, APP_PASSWORD, IMAP_HOST = 'imap.gmail.com', IMAP_PORT = 993 } = process.env;
if (!EMAIL || !APP_PASSWORD) {
  console.error('Missing EMAIL or APP_PASSWORD in .env (copy from .env.example).');
  process.exit(1);
}

// --- onboarding cutoff: anything before first run is ignored, forever ---
const DATA = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA, 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch {
    fs.mkdirSync(DATA, { recursive: true });
    const cutoff = new Date(Date.now() - SEED_DAYS * 86400000).toISOString();
    const state = { firstRun: new Date().toISOString(), cutoff };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`first run — cutoff set to ${cutoff} (seeded ${SEED_DAYS}d back)`);
    return state;
  }
}
const state = loadState();

const transport = new ImapTransport({ host: IMAP_HOST, port: Number(IMAP_PORT), user: EMAIL, pass: APP_PASSWORD });

const app = express();

// Optional login gate (HTTP basic auth). Enabled only when AUTH_PASSWORD is set, so
// local `npm start` stays open; set it on any deployed/shared instance. Username is
// your EMAIL. Use a DISTINCT password — never reuse APP_PASSWORD (that's your Gmail key).
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const tsEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
if (AUTH_PASSWORD) {
  app.use((req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const i = Buffer.from(encoded, 'base64').toString('utf8').indexOf(':');
      const user = Buffer.from(encoded, 'base64').toString('utf8').slice(0, i);
      const pass = Buffer.from(encoded, 'base64').toString('utf8').slice(i + 1);
      if (tsEqual(user, EMAIL) && tsEqual(pass, AUTH_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="mizzle", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  });
  console.log(`auth: login gate ON (user: ${EMAIL})`);
} else {
  console.log('auth: OPEN (no AUTH_PASSWORD set) — fine for localhost, not for a public URL');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/feed', async (req, res) => {
  try {
    const now = Date.now();
    const msgs = await transport.buildFeed({ cutoff: state.cutoff });
    const feed = msgs
      .map((m) => {
        const decay = decayState(
          { category: m.category, received: m.received, subject: m.subject },
          now,
        );
        return {
          ...m,
          decay: { ...decay, human: humanRemaining(decay.remaining) },
          avatar: m.fromDomain ? `https://www.google.com/s2/favicons?domain=${m.fromDomain}&sz=128` : null,
        };
      });
    const live = feed.filter((m) => !m.decay.expired);

    // mizzled items physically leave the inbox per MIZZLE_TO (default 'inbox' = no-op).
    // Fire-and-forget so the response isn't blocked; logs what it moved.
    if (MIZZLE_TO !== 'inbox') {
      const expired = feed.filter((m) => m.decay.expired);
      // 'mixed': touched → archive, untouched → trash. Otherwise everything to MIZZLE_TO.
      const fateOf = (m) => (MIZZLE_TO === 'mixed' ? (touched(m) ? 'archive' : 'trash') : MIZZLE_TO);
      const byFate = { archive: [], trash: [] };
      for (const m of expired) byFate[fateOf(m)].push(...(m.uids || [m.uid]).filter(Boolean));
      for (const [fate, uids] of Object.entries(byFate)) {
        if (!uids.length) continue;
        transport.applyFate(uids, fate)
          .then((r) => r.moved && console.log(`mizzled ${r.moved} → ${fate} (${r.target})`))
          .catch((e) => console.error('mizzle fate:', e.message));
      }
    }
    res.json({ email: EMAIL, cutoff: state.cutoff, categories: CATEGORIES, mizzleTo: MIZZLE_TO, count: live.length, feed: live });
  } catch (err) {
    console.error('feed error:', err.message);
    const msg = err.authenticationFailed
      ? 'Gmail rejected the login. Check app password, 2-Step Verification, and that IMAP is enabled.'
      : err.message;
    res.status(502).json({ error: msg });
  }
});

// Full Gmail thread (All Mail, by X-GM-THRID) — lazy-loaded when expanding a thread.
app.get('/api/thread', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    res.json(await transport.fetchThread(id));
  } catch (err) {
    console.error('thread error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Batch thread resolution for background preloading (parallel, via the pool).
app.get('/api/threads', async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({});
    res.json(await transport.fetchThreads(ids));
  } catch (err) {
    console.error('threads error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/seen', async (req, res) => {
  try {
    const { uid, uids } = req.body || {};
    const target = uids && uids.length ? uids : uid;
    if (!target) return res.status(400).json({ error: 'uid(s) required' });
    await transport.markSeen(target);
    res.json({ ok: true, target });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/reply', async (req, res) => {
  try {
    const { uid, text } = req.body || {};
    if (!uid || !text || !String(text).trim()) return res.status(400).json({ error: 'uid and text required' });
    const r = await transport.sendReply({ uid, text: String(text) });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('reply error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Faithful download: real raw message source — .eml (single) or .mbox (thread).
app.get('/api/download', async (req, res) => {
  try {
    const { id, uid, scope } = req.query;
    if (!id && !uid) return res.status(400).json({ error: 'id or uid required' });
    const b = await transport.downloadBundle({ threadId: id, uid, scope: scope === 'email' ? 'email' : 'thread' });
    if (!b) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', b.mime);
    res.setHeader('Content-Disposition', `attachment; filename="mizzle.${b.ext}"`);
    res.send(b.content);
  } catch (err) { console.error('download:', err.message); res.status(502).json({ error: err.message }); }
});

// Mark a thread as shared (calendar / download / copy) via Gmail label.
app.post('/api/share', async (req, res) => {
  try {
    const { uid, uids, on = true } = req.body || {};
    const target = uids && uids.length ? uids : uid;
    if (!target) return res.status(400).json({ error: 'uid(s) required' });
    await transport.share(target, on);
    res.json({ ok: true, target, shared: on });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/api/keep', async (req, res) => {
  try {
    const { uid, uids, on = true } = req.body || {};
    const target = uids && uids.length ? uids : uid;
    if (!target) return res.status(400).json({ error: 'uid(s) required' });
    await transport.keep(target, on);
    res.json({ ok: true, target, kept: on });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

const server = app.listen(PORT, () => {
  console.log(`mizzle relay on http://localhost:${PORT}  (account: ${EMAIL}, cutoff: ${state.cutoff}, mizzle-to: ${MIZZLE_TO})`);
});

// Graceful shutdown: LOGOUT all IMAP connections so Gmail frees them right away
// instead of letting them linger and pile up across restarts.
let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig} — closing IMAP connections…`);
  const done = transport.close().catch(() => {});
  server.close();
  await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]); // don't hang forever
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
