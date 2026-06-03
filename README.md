# mizzle

**Your Gmail inbox as an ephemeral feed.** You scroll it like Instagram, act on what matters, and let the rest *mizzle* — drizzle in, then quietly vanish. Nothing accrues. The inbox is a **pipe, not a tank**.

> *mizzle* (v.) — to drizzle; also, chiefly British, *to vanish or slip away*.

See [MANIFESTO.md](./MANIFESTO.md) for the why. This repo is the working prototype.

---

## What it does

- **A feed, not a list.** Full-bleed cards — sender, subject, body, the first real image if there is one. Scroll, graze, flick past.
- **Everything decays.** Each message has a content-aware time-to-live; nothing lives past **7 days**:
  - `primary 7d · updates 3d · social 1d · forums 1d · promos 1d` · OTP codes ~3h.
  - Decay keys off the **latest** message in a thread, so an active conversation stays alive on its own — a reply resets the clock. No bonus timers, no babysitting.
- **Two modes.** *Check* (lean back, graze) and *Write* (lean forward — only the things you flagged that still need a reply).
- **Like = a filter, not a save.** Liking (♥) flags a thread for Write mode. It buys no time. Once you've replied (your message is the latest), it drops out of Write — a solid bubble marks "responded".
- **Threads & reply.** Expand the whole Gmail conversation; reply inline over SMTP (it threads correctly and lands in Sent).
- **Eject, don't hoard.** A thing worth keeping is a *payload*, not an email — so you send it to its real home and let the message decay:
  - **Add to calendar** — opens a prefilled Google Calendar event (date auto-filled when the sender embedded `schema.org`/`.ics` event data).
  - **Download** — the real raw message: `.eml` for one message, `.mbox` for a whole thread (opens in any mail client).
  - **Copy to clipboard** — plain-text of the message.
  - Ejected items are tagged with a Gmail label (`mizzle/ejected`) so the state syncs across devices.

## How it works

A tiny local relay talks to Gmail over **IMAP** (`imapflow`) and **SMTP** (`nodemailer`) using a **Gmail App Password** — no OAuth, no app-verification, no server farm holding your mail. The frontend is dependency-free vanilla JS. Decay is computed on the fly; the inbox itself is the only store.

```
server/
  index.js       Express relay + API (/api/feed, /api/thread, /api/reply, /api/eject, /api/download …)
  transport.js   IMAP/SMTP: bounded per-category feed, thread resolution, event (.ics/JSON-LD) detection
  decay.js       category-based TTLs (max 7d), OTP short-circuit
public/          vanilla-JS client (feed, themes, eject menu) + vendored Lucide icons
test/            node --test unit tests
```

## Setup

Requires Node 18+ and a Gmail account with **2-Step Verification** on (so you can mint an App Password).

```sh
git clone <this repo> && cd mizzle
npm install

cp .env.example .env
#   EMAIL=you@gmail.com
#   APP_PASSWORD=…           # Gmail → Security → App passwords (NOT your login password)

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
| `MIZZLE_TO` | `inbox` | what happens when a message decays out: `inbox` (just hidden, safe) · `archive` (→ All Mail) · `trash` (recoverable ~30d) |
| `DECAY_TTLS` | — | optional JSON to override per-category TTLs in ms, e.g. `{"promotions":172800000}` |

```sh
npm test     # run the unit tests
```

## Status

Personal working prototype — built against one real Gmail account. Not packaged, not multi-user. Naming, a per-category `MIZZLE_TO` policy, and a forward action are still in flight.
