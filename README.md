# Mizzle Mail

**Your Gmail inbox as an ephemeral feed.** You scroll it like Instagram, act on what matters, and let the rest *mizzle* — drizzle in, then quietly vanish. Nothing accrues. The inbox is a **pipe, not a tank**.

> *mizzle* (v.) — to drizzle; also, *to vanish or slip away*.

See [MANIFESTO.md](./MANIFESTO.md) for the why. This repo is the working prototype.

---

<table align="center">
  <tr>
    <td><img src="./screenshots/feed.png" alt="The feed — Check mode" width="200"></td>
    <td><img src="./screenshots/write.png" alt="Write mode — what you flagged" width="200"></td>
    <td><img src="./screenshots/thread.png" alt="A thread with inline reply" width="200"></td>
  </tr>
  <tr>
    <td><img src="./screenshots/share.png" alt="Share — calendar, download, or copy" width="200"></td>
    <td><img src="./screenshots/decay.png" alt="Everything decays; caught-up divider" width="200"></td>
    <td><img src="./screenshots/image-card.png" alt="A card with a real image" width="200"></td>
  </tr>
</table>

## What it does

- Scroll your inbox like a feed.
- Your email decays; nothing lasts past **7 days**.
- Should not decay? It will. Export it to Google Calendar or download it out.
- Two modes: **Check** to graze · **Write** when you're in the mood.
- Like ❤️️ = filter for "write later".
- No local state, everything stays synced to Gmail.

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

## How actions map to Gmail

Mizzle holds no local state. Every action is a plain Gmail flag or label, so it stays in sync and plays nice with the Gmail web/app:

- **Like** ❤️ → a Gmail ⭐.
- **Read** → a card marks read after it has been on screen ~0.9 s, synced to Gmail as read.
- **Share** (calendar / download / copy) → a Gmail label **`mizzle/sent`**.
- **Reply** → sent over SMTP, lands in your Gmail **Sent**, and marks the thread as answered.

## Setup

Requires Node 18+ and a Gmail account with **2-Step Verification** on, so you can [mint an App Password](https://myaccount.google.com/apppasswords).

```sh
git clone https://github.com/matiasbattocchia/mizzle-mail && cd mizzle-mail
npm install

cp .env.example .env

npm start
open http://localhost:4173
```

## Deploy (self-host)

Run your **own** instance. Your Gmail, your server. Mizzle never holds anyone else's mail.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/matiasbattocchia/mizzle-mail) &nbsp; [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github) &nbsp; [![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/docs/en-US/deploy/github) &nbsp; [![Run on Replit](https://replit.com/badge/github/matiasbattocchia/mizzle-mail)](https://replit.com/github/matiasbattocchia/mizzle-mail)

Set `EMAIL`, `APP_PASSWORD`, and `AUTH_PASSWORD` in the host's env.

**Render** and **Replit** are true one-click. **Railway** and **Zeabur** take you to connect the repo.

> [!CAUTION]
> The web UI has an optional login gate HTTP basic auth. **Username is your `EMAIL`**. It's **on only when `AUTH_PASSWORD` is set**. Set it on any deployed instance, or anyone with the URL can read and act on your inbox. Use a **distinct** password, **not** your `APP_PASSWORD` (that's your Gmail key). Leaving it unset is fine only for local `npm start`.

#### Notes
- Sending replies needs outbound SMTP. Reading (IMAP) works everywhere. **Render's free tier blocks SMTP on 25/465/587**, so replies fail there. To send, use Railway, Zeabur, a VPS, or paid Render.
- Free tiers sleep on idle — first load is slow; be patient, reload if unresponsive.
- On hosts with an ephemeral disk, the onboarding cutoff (`data/state.json`) re-seeds on each deploy. Adjust `SEED_DAYS` if needed.

## Configuration (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `EMAIL` | — | your Gmail address |
| `APP_PASSWORD` | — | a Gmail App Password (not your login password) |
| `AUTH_PASSWORD` | — | login gate for the UI (username = `EMAIL`); unset = open. Required for any deployed URL; use a **distinct** password |
| `MIZZLE_TO` | `inbox` | what happens when a message decays out: `inbox` · `archive` (→ All Mail) · `delete` (→ Trash, recoverable ~30d) · `mixed` (touched → archive, untouched → delete) |

---

<p align="center">
  <a href="https://www.producthunt.com/products/mizzle-mail?utm_source=badge-follow&utm_medium=badge&utm_source=badge-mizzle&#0045;mail" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/follow.svg?product_id=1240140&theme=light" alt="Mizzle&#0032;Mail - Your&#0032;Gmail&#0032;inbox&#0032;as&#0032;an&#0032;Instagram&#0032;feed | Product Hunt" style="width: 250px; height: 54px;" width="250" height="54" /></a>
</p>
