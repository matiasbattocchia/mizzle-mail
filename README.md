# mizzle

**Your Gmail inbox as an ephemeral feed.** You scroll it like Instagram, act on what matters, and let the rest *mizzle* — drizzle in, then quietly vanish. Nothing accrues. The inbox is a **pipe, not a tank**.

> *mizzle* (v.) — to drizzle; also, *to vanish or slip away*.

See [MANIFESTO.md](./MANIFESTO.md) for the why. This repo is the working prototype.

---

## What it does

- 📜 Scroll your inbox like a feed
- ⏳ Your email decays — nothing past **7 days**
- 📅 Should not decay? It will — export to Google Calendar or download
- 👀 Two modes: **Check** to graze · ✍️ **Write** when you're in the mood
- ♥ Like = filter for write later
- 🏷️ No state held locally, all synced to Gmail

## How it works

A tiny local relay talks to Gmail over **IMAP** (`imapflow`) and **SMTP** (`nodemailer`) using a **Gmail App Password** — no OAuth, no app-verification, no server farm holding your mail. The frontend is dependency-free vanilla JS. Decay is computed on the fly; the inbox itself is the only store.

```
server/
  index.js       Express relay + API
  transport.js   IMAP/SMTP
  decay.js       category-based TTLs
public/          vanilla-JS client
test/            node --test unit tests
```

## Setup

Requires Node 18+ and a Gmail account with **2-Step Verification** on (so you can mint an App Password).

```sh
git clone https://github.com/matiasbattocchia/mizzle-mail && cd mizzle-mail
npm install

cp .env.example .env

npm start            # or: npm run dev   (auto-restart on changes)
open http://localhost:4173
```

> **Security:** your App Password lives only in `.env`, which is git-ignored — never commit it. Revoke it anytime from your Google account.

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `EMAIL` / `APP_PASSWORD` | — | Gmail address + App Password |
| `PORT` | `4173` | relay port |
| `SEED_DAYS` | `3` | on first run, how far back to seed the feed; everything older is ignored forever |
| `MIZZLE_TO` | `inbox` | what happens when a message decays out: `inbox` · `archive` (→ All Mail) · `delete` (→ Trash, recoverable ~30d) |
| `DECAY_TTLS` | — | optional JSON to override per-category TTLs in ms, e.g. `{"promotions":172800000}` |

```sh
npm test     # run the unit tests
```

## Status

Personal working prototype — built against one real Gmail account. Not packaged, not multi-user. Naming, a per-category `MIZZLE_TO` policy, and a forward action are still in flight.
