// Decay, reframed: nothing is permanent — and nothing lives past 7 days.
//   Lifetime = latest-message date + base time by Gmail category. That's it.
//   - Like (★) buys NO time — it's purely a Check/Write filter flag.
//   - Reply buys NO time either — but decay keys off the LATEST message's date,
//     so a thread that keeps getting replies stays young and naturally alive.
//   The longest any email can live is the largest base TTL (primary, 7d).
// Half-lives are configurable via DECAY_TTLS env (JSON, ms), e.g. {"promotions":172800000}.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const BASE_DEFAULT = {
  primary:    7 * DAY,
  updates:    3 * DAY,
  social:     1 * DAY,
  forums:     1 * DAY,
  promotions: 1 * DAY,
};
const BASE = (() => {
  try { return { ...BASE_DEFAULT, ...JSON.parse(process.env.DECAY_TTLS || '{}') }; }
  catch { return { ...BASE_DEFAULT }; }
})();

const OTP_TTL = 3 * HOUR;

const ACCENT = {
  primary: '#22c55e', updates: '#38bdf8', social: '#ec4899',
  forums: '#f59e0b', promotions: '#a855f7', otp: '#f43f5e',
};
const LABEL = {
  primary: 'primary', updates: 'updates', social: 'social',
  forums: 'forums', promotions: 'promo', otp: 'code',
};

const OTP_RE = /\b(otp|one[\s-]?time|verification|verify|security code|2fa|login code|código)\b|\bcode\b.*\b\d{4,8}\b|\b\d{4,8}\b.*\bcode\b/;

// TODO (deferred): travel/ticket preservation — detect event/travel date (.ics, parsed
// dates, boarding passes) and set deadline = eventDate + 7d instead of received + base.
// `received` is the latest message's date (set in buildFeed), so replies — which add a new
// latest message — reset the clock and keep an active thread alive. No additive bonuses.
export function decayState({ category = 'primary', received, subject = '' }, now) {
  const isOtp = OTP_RE.test((subject || '').toLowerCase());
  const kind = isOtp ? 'otp' : (BASE[category] ? category : 'updates');
  const ttl = isOtp ? OTP_TTL : (BASE[category] ?? 3 * DAY);
  const remaining = Math.max(0, received + ttl - now);
  const fraction = ttl > 0 ? Math.max(0, Math.min(1, remaining / ttl)) : 0;
  return {
    kind, label: LABEL[kind] || kind, accent: ACCENT[kind] || ACCENT.primary,
    ttl, remaining, fraction, expired: remaining <= 0,
  };
}

export function humanRemaining(ms) {
  if (ms <= 0) return 'gone';
  const d = ms / DAY, h = ms / HOUR;
  if (d >= 1) return `${Math.round(d)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 60000))}m`;
}
