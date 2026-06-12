// index.ts — hosted Mizzle on Cloudflare Workers. Hono router that:
//   • runs the Google OAuth dance (/login, /auth/start, /auth/callback, /logout),
//   • gates the app + /api/* behind a server-side session,
//   • mirrors the self-hosted relay's /api/* response shapes (so the SAME public/
//     frontend works unchanged) but talks to Gmail through GmailTransport.
//
// Self-hosting against your own Gmail (server/, App Password) remains the main path;
// this exists so a few friends can sign in with Google instead of minting passwords.

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { decayState, humanRemaining } from '../../server/decay.js';
import { GmailTransport, CATEGORIES } from './gmail';
import { Store, type User } from './store';
import {
  type Env, authUrl, exchangeCode, refreshAccessToken, getUserInfo, sign, unsign,
} from './oauth';

const SESSION_COOKIE = 'mizzle_session';
const STATE_COOKIE = 'mizzle_oauth_state';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

const app = new Hono<{ Bindings: Env; Variables: { user: User; token: string } }>();

// What happens to a message when it mizzles out of the feed. Default 'inbox' (no-op),
// the safe choice for a shared instance; override per deployment via the MIZZLE_TO var.
function mizzleTo(env: Env): 'inbox' | 'archive' | 'trash' | 'mixed' {
  const v = String((env as any).MIZZLE_TO || 'inbox').toLowerCase().replace(/[\s_-]/g, '');
  if (v === 'mixed') return 'mixed';
  if (v === 'trash' || v === 'delete') return 'trash';
  if (v === 'archive' || v === 'allmail') return 'archive';
  return 'inbox';
}
const touched = (m: any) => !!(m.kept || m.answered || m.shared);

// --- session resolution + token freshness -----------------------------------
async function currentUser(c: any): Promise<User | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const sid = await unsign(raw, c.env.SESSION_SECRET);
  if (!sid) return null;
  const store = new Store(c.env.DB);
  return await store.getSessionUser(sid, Date.now());
}

// Return a non-expired access token, refreshing (and persisting) when needed.
async function freshToken(env: Env, user: User): Promise<string> {
  const now = Date.now();
  if (user.access_token && user.token_expiry && user.token_expiry > now + 60_000) return user.access_token;
  if (!user.refresh_token) throw new Error('session expired — please sign in again');
  const t = await refreshAccessToken(env, user.refresh_token);
  const expiry = now + t.expires_in * 1000;
  await new Store(env.DB).updateTokens(user.sub, t.access_token, expiry);
  return t.access_token;
}

// --- OAuth -------------------------------------------------------------------
app.get('/login', (c) => c.html(loginPage()));

app.get('/auth/start', async (c) => {
  const state = crypto.randomUUID();
  setCookie(c, STATE_COOKIE, await sign(state, c.env.SESSION_SECRET), {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600,
  });
  return c.redirect(authUrl(c.env, state));
});

app.get('/auth/callback', async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return c.html(errorPage(`Google returned: ${err}`), 400);
  if (!code || !state) return c.html(errorPage('Missing code/state.'), 400);

  const stateCookie = getCookie(c, STATE_COOKIE);
  const expected = stateCookie ? await unsign(stateCookie, c.env.SESSION_SECRET) : null;
  if (!expected || expected !== state) return c.html(errorPage('State mismatch — try signing in again.'), 400);
  deleteCookie(c, STATE_COOKIE, { path: '/' });

  try {
    const tokens = await exchangeCode(c.env, code);
    const { sub, email } = await getUserInfo(tokens.access_token);
    const now = Date.now();
    const store = new Store(c.env.DB);
    const existing = await store.getUser(sub);
    const seedDays = Number(c.env.SEED_DAYS || 3);
    const cutoff = existing?.cutoff || new Date(now - seedDays * 86_400_000).toISOString();
    await store.upsertUser({
      sub, email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: now + tokens.expires_in * 1000,
      cutoff, now,
    });
    await store.pruneSessions(now);
    const sid = crypto.randomUUID();
    await store.createSession(sid, sub, now + SESSION_TTL, now);
    setCookie(c, SESSION_COOKIE, await sign(sid, c.env.SESSION_SECRET), {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL / 1000,
    });
    return c.redirect('/');
  } catch (e: any) {
    return c.html(errorPage(e.message || 'Sign-in failed.'), 502);
  }
});

app.get('/logout', async (c) => {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    const sid = await unsign(raw, c.env.SESSION_SECRET);
    if (sid) await new Store(c.env.DB).deleteSession(sid);
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/login');
});

// --- API guard: every /api/* needs a session + a fresh Gmail token -----------
app.use('/api/*', async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  try {
    c.set('token', await freshToken(c.env, user));
    c.set('user', user);
  } catch (e: any) {
    return c.json({ error: e.message }, 401);
  }
  await next();
});

const tx = (c: any) => new GmailTransport(c.get('token'), c.get('user').email);

app.get('/api/feed', async (c) => {
  try {
    const user = c.get('user');
    const now = Date.now();
    const t = tx(c);
    const msgs = await t.buildFeed({ cutoff: user.cutoff || new Date(now - 3 * 86_400_000).toISOString() });
    const feed = msgs.map((m: any) => {
      const decay = decayState({ category: m.category, received: m.received, subject: m.subject }, now);
      return {
        ...m,
        decay: { ...decay, human: humanRemaining(decay.remaining) },
        avatar: m.fromDomain ? `https://www.google.com/s2/favicons?domain=${m.fromDomain}&sz=128` : null,
      };
    });
    const live = feed.filter((m: any) => !m.decay.expired);

    const mode = mizzleTo(c.env);
    if (mode !== 'inbox') {
      const expired = feed.filter((m: any) => m.decay.expired);
      const fateOf = (m: any) => (mode === 'mixed' ? (touched(m) ? 'archive' : 'trash') : mode);
      const byFate: Record<string, string[]> = { archive: [], trash: [] };
      for (const m of expired) byFate[fateOf(m)].push(...(m.uids || [m.uid]).filter(Boolean));
      // fire-and-forget; don't block the response
      for (const [fate, uids] of Object.entries(byFate)) {
        if (uids.length) c.executionCtx.waitUntil(t.applyFate(uids, fate).catch(() => {}));
      }
    }
    return c.json({ email: user.email, cutoff: user.cutoff, categories: CATEGORIES, mizzleTo: mode, count: live.length, feed: live });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.get('/api/thread', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id required' }, 400);
  try { return c.json(await tx(c).fetchThread(id)); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.get('/api/threads', async (c) => {
  const ids = String(c.req.query('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return c.json({});
  try { return c.json(await tx(c).fetchThreads(ids)); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.post('/api/seen', async (c) => {
  const { uid, uids } = await c.req.json().catch(() => ({}));
  const target = uids && uids.length ? uids : uid;
  if (!target) return c.json({ error: 'uid(s) required' }, 400);
  try { await tx(c).markSeen(target); return c.json({ ok: true, target }); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.post('/api/reply', async (c) => {
  const { uid, text } = await c.req.json().catch(() => ({}));
  if (!uid || !text || !String(text).trim()) return c.json({ error: 'uid and text required' }, 400);
  try { const r = await tx(c).sendReply({ uid, text: String(text) }); return c.json({ ok: true, ...r }); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.get('/api/download', async (c) => {
  const id = c.req.query('id');
  const uid = c.req.query('uid');
  const scope = c.req.query('scope') === 'email' ? 'email' : 'thread';
  if (!id && !uid) return c.json({ error: 'id or uid required' }, 400);
  try {
    const b = await tx(c).downloadBundle({ threadId: id, uid, scope });
    if (!b) return c.json({ error: 'not found' }, 404);
    return new Response(b.content, {
      headers: { 'content-type': b.mime, 'content-disposition': `attachment; filename="mizzle.${b.ext}"` },
    });
  } catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.post('/api/share', async (c) => {
  const { uid, uids, on = true } = await c.req.json().catch(() => ({}));
  const target = uids && uids.length ? uids : uid;
  if (!target) return c.json({ error: 'uid(s) required' }, 400);
  try { await tx(c).share(target, on); return c.json({ ok: true, target, shared: on }); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

app.post('/api/keep', async (c) => {
  const { uid, on = true } = await c.req.json().catch(() => ({}));
  if (!uid) return c.json({ error: 'uid required' }, 400);
  try { await tx(c).keep(uid, on); return c.json({ ok: true, uid, kept: on }); }
  catch (err: any) { return c.json({ error: err.message }, 502); }
});

// --- everything else: the gated static frontend ------------------------------
app.get('*', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/login');
  return c.env.ASSETS.fetch(c.req.raw); // serve public/ via the assets binding
});

// --- inline pages ------------------------------------------------------------
function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
    font: 16px/1.5 -apple-system,system-ui,sans-serif; background:#0b0b0c; color:#e7e7e8; }
  .card { max-width: 22rem; padding: 2rem 1.75rem; text-align:center; }
  h1 { font-size: 2rem; margin:.2rem 0 .1rem; letter-spacing:-.02em; }
  .sub { color:#9aa; margin:0 0 1.5rem; }
  .btn { display:inline-block; padding:.7rem 1.1rem; border-radius:.6rem; font-weight:600;
    text-decoration:none; background:#e7e7e8; color:#0b0b0c; }
  .note { margin-top:1.5rem; font-size:.82rem; color:#888; }
  a.q { color:#9bd; }
</style></head><body><div class="card">${body}</div></body></html>`;
}

function loginPage(): string {
  return shell('Sign in · Mizzle', `
    <h1>mizzle</h1>
    <p class="sub">your Gmail, as a feed that mizzles</p>
    <a class="btn" href="/auth/start">Continue with Google</a>
    <p class="note">Mizzle is an <b>unverified</b> app, so Google will show a warning screen.
    Click <i>Advanced → go to mizzlemail.com</i> to continue. Mizzle requests Gmail access
    to read, label, archive, and send on your behalf — nothing leaves your account.
    Prefer to run your own? <a class="q" href="https://github.com/matiasbattocchia/mizzle-mail">Self-host it</a>.</p>`);
}

function errorPage(msg: string): string {
  return shell('Error · Mizzle', `
    <h1>mizzle</h1>
    <p class="sub">${msg.replace(/[<>&]/g, '')}</p>
    <a class="btn" href="/login">Back to sign in</a>`);
}

export default app;
