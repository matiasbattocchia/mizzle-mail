// mizzle DEMO server — serves the real frontend with curated/fake data so you can
// screenshot without touching a real inbox. No IMAP, no creds. Port 4174 by default.
//   node demo/server.js
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decayState, humanRemaining } from '../server/decay.js';
import { FIXTURES, THREADS } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = process.env.DEMO_PORT || 4174;
const HOUR = 3600e3;

const app = express();
app.use(express.json());

// Serve the real index.html, but stub IntersectionObserver BEFORE app.js loads so
// the read-on-view marker never fires — unread cards stay unread for screenshots.
// (Mirrors public/index.html, no copy to drift, no change to the shipped app.)
app.get('/', (req, res) => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(
    '<script src="/app.js"',
    '<script>window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};</script>\n  <script src="/app.js"',
  );
  res.type('html').send(html);
});
app.use(express.static(PUBLIC, { index: false }));

function buildFeed() {
  const now = Date.now();
  return FIXTURES.map((it, i) => {
    const received = now - (it.hoursAgo ?? 1) * HOUR;
    const decay = decayState({ category: it.category, received, subject: it.subject }, now);
    const fromDomain = it.fromDomain || null;
    const avatar = it.avatar !== undefined ? it.avatar
      : (fromDomain ? `https://www.google.com/s2/favicons?domain=${fromDomain}&sz=128` : null);
    const uid = 9000 + i;
    return {
      uid, uids: it.uids || [uid], threadId: it.threadId || String(1900000000000000000 + i),
      category: it.category, subject: it.subject, fromName: it.fromName,
      fromDomain, fromAddress: it.fromAddress || (fromDomain ? `info@${fromDomain}` : null),
      received, seen: !!it.seen, kept: !!it.kept, answered: !!it.answered,
      responded: !!it.responded, shared: !!it.shared, count: it.count || 1,
      body: it.body || '', image: it.image || null, event: it.event || null,
      decay: { ...decay, human: humanRemaining(decay.remaining) }, avatar,
    };
  }).filter((m) => !m.decay.expired).sort((a, b) => b.received - a.received);
}

app.get('/api/feed', (req, res) => {
  const feed = buildFeed();
  res.json({
    email: 'battox@gmail.com',
    cutoff: new Date(Date.now() - 3 * 86400e3).toISOString(),
    categories: ['primary', 'updates', 'social', 'forums', 'promotions'],
    mizzleTo: 'inbox', count: feed.length, feed,
  });
});

// Throwaway logo lab (Product Hunt asset) — NOT part of the app UI.
app.get('/logo', (req, res) => {
  // The actual logo as a reusable <symbol>, previewed big + at small/favicon sizes.
  res.type('html').send(`<!doctype html><meta charset=utf-8>
<style>
  body{margin:0;background:#3a3d42;display:flex;flex-direction:column;gap:48px;align-items:center;
       padding:56px;font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#aeb4bc}
  .row{display:flex;gap:40px;align-items:center}
  figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:14px}
  svg.logo{display:block}
</style>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="logo" viewBox="0 0 480 480">
    <radialGradient id="bg" cx="28%" cy="22%" r="100%"><stop offset="0" stop-color="#fafbfc"/><stop offset=".5" stop-color="#e4e7ea"/><stop offset="1" stop-color="#cdd2d8"/></radialGradient>
    <linearGradient id="fogBars" x1="0" y1="0" x2=".65" y2="1"><stop offset="0" stop-color="#3e444b"/><stop offset=".55" stop-color="#676e76"/><stop offset="1" stop-color="#969ca5"/></linearGradient>
    <linearGradient id="fogV" x1="0" y1="0" x2=".65" y2="1"><stop offset="0" stop-color="#2a2e34"/><stop offset=".55" stop-color="#595f67"/><stop offset="1" stop-color="#878e97"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="4" flood-color="#3c424a" flood-opacity=".28"/></filter>
    <rect width="480" height="480" fill="url(#bg)"/>
    <g filter="url(#sh)"><path d="M14 74 V26 M86 74 V26" transform="translate(90 90) scale(3)" fill="none" stroke="url(#fogBars)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 26 L50 52 L86 26" transform="translate(90 90) scale(3)" fill="none" stroke="url(#fogV)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/></g>
  </symbol>
</defs></svg>

<figure><svg class="logo" width="600" height="600"><use href="#logo"/></svg><figcaption>600 × 600</figcaption></figure>
<div class="row">
  <figure><svg class="logo" width="240" height="240"><use href="#logo"/></svg><figcaption>240</figcaption></figure>
  <figure><svg class="logo" width="120" height="120"><use href="#logo"/></svg><figcaption>120</figcaption></figure>
  <figure><svg class="logo" width="64" height="64"><use href="#logo"/></svg><figcaption>64</figcaption></figure>
  <figure><svg class="logo" width="32" height="32"><use href="#logo"/></svg><figcaption>32 (favicon)</figcaption></figure>
</div>`);
});

// Serve the exported logo at full resolution (open in a real tab, not a screenshot).
app.get('/mizzle-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'mizzle-logo.png')));

// Receive a rasterized PNG dataURL from the browser and write it to demo/.
app.post('/save-logo', express.text({ limit: '12mb', type: '*/*' }), (req, res) => {
  try {
    const b64 = String(req.body).replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    const out = path.join(__dirname, 'mizzle-logo.png');
    writeFileSync(out, buf);
    res.json({ ok: true, path: out, bytes: buf.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full-bleed export tile (fog edge-to-edge, no rounded corners — PH rounds it itself).
app.get('/logo/export', (req, res) => {
  const sw = +(req.query.sw || 18);
  const S = 480;
  res.type('html').send(`<!doctype html><meta charset=utf-8>
<style>
  html,body{margin:0;padding:0;background:#b6bbc3}
  .tile{width:${S}px;height:${S}px;display:flex;align-items:center;justify-content:center;overflow:hidden;
        background:radial-gradient(125% 120% at 28% 22%,#f4f5f7,#d7dbe0 48%,#b6bbc3)}
  .m{-webkit-mask-image:linear-gradient(108deg,#000 36%,rgba(0,0,0,.18) 74%,transparent 92%);
     mask-image:linear-gradient(108deg,#000 36%,rgba(0,0,0,.18) 74%,transparent 92%);
     filter:drop-shadow(0 2px 7px rgba(80,86,94,.22))}
</style>
<div class="tile">
  <svg class="m" viewBox="0 0 100 100" width="300" height="300" aria-label="M">
    <defs><linearGradient id="fog" x1="0" y1="0" x2="0.65" y2="1">
      <stop offset="0" stop-color="#4b5057"/><stop offset="0.55" stop-color="#868c95"/><stop offset="1" stop-color="#b0b6be"/>
    </linearGradient></defs>
    <path d="M16 85 V15 L50 55 L84 15 V85" fill="none" stroke="url(#fog)"
          stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
</div>`);
});

app.get('/api/thread', (req, res) => res.json(THREADS[req.query.id] || { count: 0, messages: [] }));
app.get('/api/threads', (req, res) => {
  const out = {};
  for (const id of String(req.query.ids || '').split(',')) if (THREADS[id]) out[id] = THREADS[id];
  res.json(out);
});

// all side-effects are no-ops in the demo (so the UI works for screenshots)
app.post('/api/seen', (req, res) => res.json({ ok: true }));
app.post('/api/keep', (req, res) => res.json({ ok: true, kept: req.body?.on }));
app.post('/api/reply', (req, res) => res.json({ ok: true, to: 'demo@example.com', subject: 'demo' }));
app.post('/api/share', (req, res) => res.json({ ok: true, shared: true }));
app.get('/api/download', (req, res) => {
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', 'attachment; filename="demo.eml"');
  res.send('Subject: demo\r\nFrom: demo <demo@example.com>\r\n\r\nDemo message.\r\n');
});

app.listen(PORT, () => console.log(`mizzle DEMO on http://localhost:${PORT}  (fake data, no inbox)`));
