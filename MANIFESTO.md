# mizzle — a manifesto

> **Email is a medium, not a destination.**

Gmail's premise, since 2004: *never delete, search later.* The inbox became a tank
that only fills. Twenty years on, finding anything in it is broken, and the anxiety of
a 40,000-message backlog is the implicit obligation that you *might* need any of it.

We make the opposite bet.

---

## The one law

> **Nothing accrues in the inbox.**
> Replies flow **out** (Sent). Payloads flow **out** (download / share). Everything
> unhandled **decays**. The inbox holds no permanent state — it's a **pipe, not a tank.**

This is the **Stream, not Inbox** philosophy (popularized by tech essayists arguing that
content like newsletters should be treated like **a flowing river to dip into, rather than
a bucket that needs to be completely drained**). The bucket creates the debt — the implicit
obligation to drain it to zero. The river has no bottom to reach: you dip in, take what you
want, and let the rest flow past. We build the river.

Mailbox (RIP, 2013–2016) sped up the treadmill with snooze — but snooze is deferral,
the pile keeps growing. Dropbox admitted they couldn't "fundamentally fix email." The
fix they missed: don't process the pile faster — **remove the floor.** Let it decay.

---

## How it feels: a feed, not a list

You **scroll** your mail like an Instagram feed. Lean back, graze, flick past 95% of it.

- Each email is a **full-bleed card** — sender as the account (avatar, `@domain`), the
  first image/attachment/link-preview as the photo, subject + snippet as the caption.
- No image? A generated **typographic card** from the subject.
- A **countdown ring** on every card shows its remaining life. Decay is *legible*,
  never a silent loss.
- A **stories row** up top for the genuinely time-sensitive (OTPs, calendar, check-ins).

## Two modes — consumption ≠ production

You often check email because you're **bored**, not because you owe a reply. So we
never make scrolling demand a decision.

- **Check mode** — lean back. Graze the feed. The only gesture is **double-tap**.
- **Write mode** — lean forward. A focused, batched view of what you flagged. Clear it,
  then close it. (Voice-AI reply lives here for the in-the-moment answers, and queues
  the ones you need to *think* about.)

## Double-tap means one of two things — and neither one "keeps the email"

1. **"I need to act on this"** → into the **reply queue** (surfaces in Write mode).
2. **"I need this *thing*"** (a photo, a receipt, a contract) → you don't need the
   *email*, you need the **payload**. **Download or share it.** The email decays anyway.

Saving content **sends the payload out** and lets the message die on schedule. The inbox
never becomes your file vault — that was Gmail's accident (and arguably the genesis of
Drive). We refuse it by design.

---

## What we deliberately do NOT build

- **Search.** Gmail search is broken anyway — it's not Google search, it sucks. If
  everything decays, there's nothing to search. You kept what mattered by downloading it;
  it lives where files live now. Search is *intentionally absent*, not missing.
- **Folders / labels / archive-everything.** The pipe has no shelves.
- **A server that holds your mail.** See the constraint below.

## The architecture constraint (the Mailbox lesson)

Mailbox died on economics: it **proxied everyone's email through its own servers** to
deliver its features — cost scaled linearly with users, zero revenue, a privacy liability.

> **Client-side, direct against the Gmail API.** OAuth, query and act on-device.
> We never rebuild the server farm that bled Dropbox dry.

---

## Why this is unclaimed

The pieces exist separately; the fusion doesn't.

- **Swipe-card triage** — crowded (Avec raised $8.4M in April 2026; Mailbox's ghost).
- **Instagram *vertical feed* for email** — only HEY's "The Feed" echoes it, newsletters only.
- **Ephemeral-by-default ("save or it's gone")** — *nobody.*
- **All of it, as a Gmail replacement** — **unclaimed.**

The swipe gesture is a commodity now. **Feed + decay is the moat.** The decay is the
novel bet; the feed is the wrapper that makes decay feel natural instead of scary.
