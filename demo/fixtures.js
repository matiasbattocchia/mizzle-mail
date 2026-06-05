// Demo fixtures — fabricated launch-day inbox for screenshots (Product Hunt launch).
// 100% English. Real name (Matías Battocchia). Brands send automated notifications;
// any *person* sender is fictional. Real Bandcamp promos kept for visual texture.
// Used only by demo/server.js. NOT part of the app. Untracked.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3600e3;

// a few real Bandcamp promos (de-anonymized to the real name)
const bandcamp = JSON.parse(readFileSync(path.join(__dirname, 'bandcamp.json'), 'utf8'))
  .slice(0, 3)
  .map((b, i) => ({
    category: i === 0 ? 'updates' : 'promotions',
    fromName: b.fromName, fromDomain: b.fromDomain,
    subject: b.subject,
    body: (b.body || '').replace(/Alex Rivera/g, 'Matías Battocchia'),
    image: b.image, count: 1, hoursAgo: 6 + i * 7, seen: i !== 0,
  }));

// expandable conversations (thread demo)
export const THREADS = {
  // active 3-message investor back-and-forth (unread, needs a reply)
  '1700000000000000002': {
    count: 3,
    messages: [
      { fromName: 'Sarah Tan', fromDomain: 'gmail.com', received: Date.now() - 5 * HOUR, fromMe: false, seen: true,
        body: "Hi Matías — congrats on the launch, mizzle is the most original take on email I've seen in years. I'm a partner at Northwind (seed-stage). Any chance you're raising? Would love 20 minutes this week." },
      { fromName: 'You', fromDomain: 'gmail.com', received: Date.now() - 3.5 * HOUR, fromMe: true, seen: true,
        body: "Thanks Sarah, that means a lot! Yes — we're putting together a small round. Are you free Thursday?" },
      { fromName: 'Sarah Tan', fromDomain: 'gmail.com', received: Date.now() - 2 * HOUR, fromMe: false, seen: true,
        body: "Thursday's perfect — 3pm your time? I'll send a calendar invite. Really excited to dig in." },
    ],
  },
  // shorter 2-message thread (already responded)
  '1700000000000000001': {
    count: 2,
    messages: [
      { fromName: 'Devon Park', fromDomain: 'gmail.com', received: Date.now() - 27 * HOUR, fromMe: false, seen: true,
        body: "Matías — I've wanted this exact thing for ten years. An inbox you graze instead of drown in. Just signed up. Take my money: is there a Pro plan?" },
      { fromName: 'You', fromDomain: 'gmail.com', received: Date.now() - 26 * HOUR, fromMe: true, seen: true,
        body: "Ha! Thank you — that means a lot. Pro lands next week. I'll make sure you're first in." },
    ],
  },
};

export const FIXTURES = [
  // ── primary ──────────────────────────────────────────────
  { category: 'primary', fromName: 'Sarah Tan', fromDomain: 'gmail.com', avatar: null,
    subject: 'Re: Saw mizzle on Product Hunt — coffee?',
    body: "Thursday's perfect — 3pm your time? I'll send a calendar invite. Really excited to dig in.",
    hoursAgo: 2, seen: false, kept: true, count: 3, threadId: '1700000000000000002', uids: [9201, 9202, 9203] },
  { category: 'primary', fromName: 'Devon Park', fromDomain: 'gmail.com', avatar: null,
    subject: "Re: I've wanted this for 10 years",
    body: "You: Ha! Thank you — that means a lot. Pro lands next week. I'll make sure you're first in.",
    hoursAgo: 26, seen: true, kept: true, responded: true, count: 2,
    threadId: '1700000000000000001', uids: [9101, 9102] },
  { category: 'primary', fromName: 'Y Combinator', fromDomain: 'ycombinator.com',
    subject: 'Your YC W27 application',
    body: 'Hi Matías, thanks for applying to Y Combinator with mizzle. We saw the Product Hunt launch — strong start. Your interview slot is being scheduled.',
    hoursAgo: 12, seen: false, kept: true },
  { category: 'primary', fromName: 'GitHub', fromDomain: 'github.com',
    subject: 'Your verification code is 481920',
    body: 'Continue signing in to GitHub by entering the code 481920. It expires in 10 minutes. If you didn’t request this, you can ignore this email.',
    hoursAgo: 1, seen: false },
  { category: 'primary', fromName: 'Marina Cole', fromDomain: 'gmail.com', avatar: null,
    subject: 'Invitation: Podcast recording @ Thu Jun 5, 3:00 PM',
    body: "Loved the launch! Want to come on the show and talk about ephemeral email? Sending an invite — let me know if the time works.",
    hoursAgo: 3, seen: false,
    event: { title: 'Podcast: mizzle & the ephemeral inbox', start: '2026-06-05T15:00:00-03:00', end: '2026-06-05T16:00:00-03:00', location: 'Riverside (remote)', allDay: false } },
  { category: 'primary', fromName: 'United Airlines', fromDomain: 'united.com',
    subject: 'Your flight UA1245 — San Francisco → New York',
    body: 'Check-in is open. Flight UA1245 departs June 10 at 8:40 AM from SFO. Arrive 2 hours early. Your boarding pass is attached.',
    hoursAgo: 40, seen: true, shared: true,
    event: { title: 'Flight UA1245 · SFO → JFK', start: '2026-06-10T08:40:00-07:00', location: 'San Francisco Intl (SFO)', allDay: false } },

  // ── updates ──────────────────────────────────────────────
  { category: 'updates', fromName: 'Product Hunt', fromDomain: 'producthunt.com',
    subject: '🚀 mizzle is #1 Product of the Day',
    body: 'Congratulations! mizzle finished the day at #1 with 1,204 upvotes and 187 comments. You also earned the Golden Kitty nomination badge.',
    hoursAgo: 5, seen: false },
  { category: 'updates', fromName: 'GitHub', fromDomain: 'github.com',
    subject: 'matiasbattocchia/mizzle-mail hit 1,000 stars ⭐',
    body: 'Your repository gained 847 stars in the last 24 hours and is trending in JavaScript. 213 people forked it today.',
    hoursAgo: 6, seen: false },
  { category: 'updates', fromName: 'Stripe', fromDomain: 'stripe.com',
    subject: 'You received your first payment 🎉',
    body: 'mizzle Pro — $8.00 from a customer in Berlin. Your first sale. Funds will arrive in your account in 2 business days.',
    hoursAgo: 8, seen: false },

  // ── social ───────────────────────────────────────────────
  { category: 'social', fromName: 'X', fromDomain: 'x.com',
    subject: 'Matías, your post is taking off',
    body: 'Your post about the mizzle launch has 2,341 likes and 418 reposts. 23 people you follow are talking about it.',
    hoursAgo: 4, seen: false },
  { category: 'social', fromName: 'LinkedIn', fromDomain: 'linkedin.com',
    subject: 'You appeared in 312 searches this week',
    body: 'Your launch is getting attention — 312 people found you in search, up 940% from last week.',
    hoursAgo: 15, seen: true },

  // ── forums ───────────────────────────────────────────────
  { category: 'forums', fromName: 'Hacker News', fromDomain: 'ycombinator.com',
    subject: 'Show HN: Mizzle – your inbox as a feed that decays',
    body: "Your submission is #2 on the front page with 487 points and 263 comments. Top comment: “Finally, someone treats email like a river instead of a reservoir.”",
    hoursAgo: 9, seen: false },
  { category: 'forums', fromName: 'Indie Hackers', fromDomain: 'indiehackers.com',
    subject: 'Your milestone: mizzle crossed 5,000 signups',
    body: 'You posted a milestone: mizzle passed 5,000 signups in its first 24 hours. 64 people cheered. Great traction!',
    hoursAgo: 20, seen: false },

  // ── promotions ───────────────────────────────────────────
  { category: 'promotions', fromName: 'Hacker Newsletter', fromDomain: 'hackernewsletter.com',
    subject: 'Issue #720 — featuring mizzle',
    body: 'This week’s top picks include “Mizzle: the inbox is a pipe, not a tank.” Read the full issue.',
    hoursAgo: 11, seen: true },

  // ── real (de-anonymized) Bandcamp promos, with images ────
  ...bandcamp,
];
