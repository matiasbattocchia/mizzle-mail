# Mizzle, hosted (Cloudflare Workers + Gmail API)

> **Self-hosting is the main path.** If you just want Mizzle for your own Gmail, use
> the root project ([../README.md](../README.md)): a tiny local relay with an App
> Password, no OAuth, no third party ever holding your mail. **Use this folder only**
> if you want to host one shared instance that a few friends sign into with Google.

This is a [Cloudflare Worker](https://workers.cloudflare.com/) that serves the same
dependency-free frontend (`../public`) but talks to Gmail over the **Gmail REST API**
with per-user **OAuth**, storing tokens and sessions in **D1** (SQLite). It reuses the
relay's pure parsers (`../server/mail-text.js`) and decay model (`../server/decay.js`)
unchanged, so a card looks and decays identically in both builds.

```
hosted/
  wrangler.toml     Worker + D1 + assets config
  schema.sql        users + sessions tables
  src/
    index.ts        Hono router: /login, /auth/*, gated /api/*, static frontend
    oauth.ts        Google Authorization-Code flow + token refresh + cookie signing
    store.ts        D1 queries (users, sessions)
    gmail.ts        GmailTransport — ImapTransport's surface over the Gmail REST API
```

## Why unverified (and what that means)

Mizzle needs the **`gmail.modify`** scope (read bodies, label, archive, trash, send).
That's a Google *restricted* scope. Getting an app **verified** requires a security
assessment. For a friends-only instance you can instead publish the OAuth app in
**Production, unverified**:

- Google shows an **"unverified app"** warning; users click *Advanced → go to
  mizzlemail.com* to proceed.
- You're capped at **100 users** and the consent screen carries the warning — both
  fine for a handful of friends. Tell them to accept the risk knowingly.

(Testing mode is the alternative, but its refresh tokens expire after 7 days, forcing a
weekly re-login — so Production-unverified is the better fit.)

## One-time Google setup

1. In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services**:
   - Enable the **Gmail API**.
   - **OAuth consent screen**: User type *External*, publishing status *In production*.
     Add `mizzlemail.com` under *Authorized domains*. Add the `gmail.modify`, `openid`,
     and `email` scopes.
   - **Credentials → Create OAuth client ID → Web application**:
     - **Authorized redirect URIs**: `https://mizzlemail.com/auth/callback` and (for
       local dev) `http://localhost:8787/auth/callback`.
     - Authorized JavaScript origins: leave empty (this is a server-side flow).
2. Note the **Client ID** and **Client secret**. The downloaded `client_secret_*.json`
   is git-ignored at the repo root — never commit it.

## Deploy

```sh
cd hosted
npm install

# 1. Create the database, paste its id into wrangler.toml (database_id), then init it.
#    `db:init` applies the schema to the REMOTE (production) D1; `db:init:local` is for
#    `wrangler dev`. (Bare `d1 execute` defaults to local, which is the usual "no such
#    table" foot-gun.)
npx wrangler d1 create mizzle
npm run db:init

# 2. Set secrets (never committed). The helper reads client_id + client_secret from
#    the git-ignored client_secret_*.json, generates a SESSION_SECRET, and pipes all
#    three to wrangler via stdin (nothing is echoed). Requires `wrangler login` first.
npm run secrets
#    …or set them by hand:
#    npx wrangler secret put GOOGLE_CLIENT_ID
#    npx wrangler secret put GOOGLE_CLIENT_SECRET
#    npx wrangler secret put SESSION_SECRET

# 3. Ship it.
npm run deploy
```

`OAUTH_REDIRECT`, `SEED_DAYS`, and optional `MIZZLE_TO` live as plain `[vars]` in
`wrangler.toml`. To use the `mizzlemail.com` route, add the zone to your Cloudflare
account first (or delete the `routes` block to deploy on `*.workers.dev`).

### Local dev

```sh
cp .dev.vars.example .dev.vars     # fill in your client id/secret + a session secret
npm run db:init:local
npm run dev                        # http://localhost:8787
```

Make sure `http://localhost:8787/auth/callback` is in the client's redirect URIs and
`OAUTH_REDIRECT` in `.dev.vars` points at it.

## How it maps to the relay

| Relay (`server/transport.js`, IMAP) | Hosted (`gmail.ts`, REST) |
|---|---|
| `category:X after:Y` over IMAP search | `threads.list?q=category:X after:Y in:inbox` |
| X-GM-THRID thread walk in All Mail | native `threadId` + `threads.get` |
| `\Seen` / `\Flagged` flags | `UNREAD` / `STARRED` label ids |
| `mizzle/sent` label via IMAP | same label, resolved/created via the labels API |
| SMTP reply-all (`nodemailer`) | RFC 822 built by hand → `messages.send` |
| `messageMove` to `\All` / `\Trash` | `batchModify` dropping `INBOX` / adding `TRASH` |
| `.eml`/`.mbox` from IMAP `source` | `messages.get?format=raw` → same `buildBundle` |

## Notes & limits

- **Sessions** are server-side (D1 `sessions` table); the cookie holds only a signed,
  opaque id. Access tokens refresh automatically; the refresh token is stored per user.
- **Static frontend gating**: the Worker redirects unauthenticated `/` to `/login`
  (via `run_worker_first`). Even if a host serves `public/` directly, every `/api/*`
  route independently requires a valid session, so no mail is exposed — the frontend
  itself carries no secrets. `run_worker_first` needs a recent wrangler (3.90+ / 4).
- This shares **no code paths** with `server/` beyond the two pure modules it imports;
  the self-hosted relay is untouched and one-click deploys for it are unaffected.
