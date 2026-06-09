import { ICON } from './icons.js';

const feedEl = document.getElementById('feed');
const stateEl = document.getElementById('state');

let items = [];
let mode = 'check';

const DAY = 86400000;
const CAT_LABEL = { primary: 'Primary', updates: 'Updates', social: 'Social', forums: 'Forums', promotions: 'Promotions' };
let CAT_ORDER = ['primary', 'updates', 'social', 'forums', 'promotions'];

const timeAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const humanLeft = (ms) => {
  if (ms <= 0) return 'gone';
  const d = ms / DAY, h = ms / 3.6e6;
  if (d >= 1) return `${Math.round(d)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(ms / 6e4))}m`;
};
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Turn URLs in ALREADY-ESCAPED text into clickable links. (esc first, then this —
// so no raw HTML from the email is ever injected. Only http/https/www match, so
// javascript: etc. can't slip through.)
function linkify(escaped) {
  // one pass: markdown [label](url) first, then bare URLs. Doing both in a single
  // alternation avoids the bare matcher re-wrapping the url inside a generated href.
  const A = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|\b(https?:\/\/[^\s<]+|www\.[^\s<]+)/g,
    (m, mdLabel, mdUrl, bare) => {
      if (mdUrl) return A(mdUrl, mdLabel);
      const peel = bare.match(/^([\s\S]*?)([.,;:!?)\]'"]*)$/); // peel trailing punctuation
      const url = peel[1], tail = peel[2] || '';
      return A(url.startsWith('http') ? url : `http://${url}`, url) + tail;
    },
  );
}
const initials = (name) => (name || '?').trim().slice(0, 1).toUpperCase() || '?';

// IG-comment style: "Name body", left-aligned, no bubbles.
const threadMsg = (m) => `
  <div class="tmsg" title="${esc(timeAgo(m.received))}"><span class="tmsg-from">${esc(m.fromName)}</span> <span class="tmsg-b">${linkify(esc(m.body || ''))}</span></div>`;

function readCache() { try { return JSON.parse(localStorage.getItem('feedCache') || 'null'); } catch { return null; } }
function writeCache(data) { try { localStorage.setItem('feedCache', JSON.stringify({ categories: data.categories, feed: data.feed })); } catch { /* quota — ignore */ } }
function setSyncing(on) { document.querySelector('.refresh')?.classList.toggle('syncing', on); }

// Gmail's trick: on FIRST load, paint the last-known feed instantly from cache, then
// fetch fresh and swap it in. On a manual refresh the feed is already on screen, so we
// leave it untouched (no cache re-paint — that caused a blank flicker) until fresh data lands.
async function load(initial = false) {
  if (initial) {
    const cached = readCache();
    if (cached && cached.feed && cached.feed.length) {
      if (cached.categories) CAT_ORDER = cached.categories;
      items = cached.feed;
      render(); window.scrollTo(0, 0); // instant, from the top
    } else {
      showState('pulling fresh mail…');
    }
  }
  setSyncing(true);
  try {
    const r = await fetch('/api/feed');
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    const data = await r.json();
    if (data.categories) CAT_ORDER = data.categories;
    if (data.mizzleTo) { const el = document.querySelector('.mzto'); if (el) el.textContent = data.mizzleTo; }
    items = data.feed;
    render(); window.scrollTo(0, 0); // fresh mail resets the feed to the top
    writeCache(data);
    // warm every thread in the background so "reply" is instant — slight delay so
    // the UI settles and early mark-as-read calls aren't behind the heavy batch
    setTimeout(prefetchThreads, 1200);
  } catch (e) {
    if (!items.length) showState(`couldn't reach inbox: ${e.message}`); // keep the current feed on a failed refresh
  } finally {
    setSyncing(false);
  }
}

function showState(msg) { stateEl.textContent = msg; feedEl.replaceChildren(stateEl); }
function caughtUp(stillAliveBelow) {
  const d = document.createElement('div');
  d.className = 'divider';
  d.textContent = stillAliveBelow ? '✨ caught up · older still alive below' : '✨ you’re all caught up';
  return d;
}

function groupsFrom(list) {
  const frag = document.createDocumentFragment();
  for (const cat of CAT_ORDER) {
    const inCat = list.filter((i) => i.category === cat).sort((a, b) => b.received - a.received);
    if (!inCat.length) continue;
    const h = document.createElement('div');
    h.className = 'group';
    h.textContent = CAT_LABEL[cat] || cat;
    frag.appendChild(h);
    for (const it of inCat) frag.appendChild(card(it));
  }
  return frag;
}

function render() {
  if (mode === 'write') {
    // liked = flagged for a reply; once responded (last msg is mine) it's done → drop it
    const todo = items.filter((i) => i.kept && !i.responded);
    if (!todo.length) { showState('nothing to write — like a card in Check mode to queue a reply'); return; }
    feedEl.replaceChildren(groupsFrom(todo));
    observeCards();
    return;
  }
  if (!items.length) { showState('inbox is quiet — nothing fresh'); return; }

  const unread = items.filter((i) => !i.seen);
  const read = items.filter((i) => i.seen);
  const frag = document.createDocumentFragment();
  if (unread.length) frag.appendChild(groupsFrom(unread));
  frag.appendChild(caughtUp(read.length > 0)); // always shown — also holds the legend
  if (read.length) frag.appendChild(groupsFrom(read));
  feedEl.replaceChildren(frag);
  observeCards();
}

function card(it) {
  const accent = it.decay.accent;
  const el = document.createElement('article');
  el.className = 'card' + (it.kept ? ' kept' : '') + (it.seen ? ' seen' : '');
  el.dataset.uid = it.uid;

  const avatar = it.avatar
    ? `<img class="avatar" src="${esc(it.avatar)}" alt="" onerror="this.replaceWith(window.mono('${esc(initials(it.fromName))}','${accent}'))" />`
    : `<div class="avatar mono" style="background:${accent}">${esc(initials(it.fromName))}</div>`;

  el.innerHTML = `
    <div class="acct">
      ${avatar}
      <div class="who">
        <div class="name">${esc(it.fromName)}</div>
        <div class="handle">@${esc(it.fromDomain || 'unknown')}</div>
      </div>
      <span class="time">${timeAgo(it.received)}</span>
    </div>

    ${it.image ? `<img class="heroimg" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}

    <div class="subject">${esc(it.subject)}</div>
    <div class="content"><span class="body">${linkify(esc(it.body || ''))}</span></div>
    <button class="more" hidden>more</button>

    <div class="actions">
      <button class="act star" title="Like — flag for Write mode">${ICON.heart}</button>
      <button class="act reply${it.responded ? ' responded' : ''}" title="${it.responded ? 'Responded — your reply is the latest message' : (it.count > 1 ? it.count + ' messages · reply' : 'Reply')}">${it.responded ? ICON.commentSolid : ICON.comment}${it.count > 1 ? `<span class="actcount">${it.count}</span>` : ''}</button>
      <span class="share-wrap">
        <button class="act share${it.shared ? ' done' : ''}" title="Share">${it.shared ? ICON.sendSolid : ICON.send}</button>
        <div class="ejectmenu" hidden>
          <button data-eject="cal">${ICON.calendar}<span>Add to calendar${it.event && it.event.start ? ` · ${calDateLabel(it.event)}` : ''}</span></button>
          <button data-eject="dl-email">${ICON.download}<span>Download email</span></button>
          ${it.count > 1 ? `<button data-eject="dl-thread">${ICON.download}<span>Download thread</span></button>` : ''}
          <button data-eject="copy">${ICON.copy}<span>Copy to clipboard</span></button>
        </div>
      </span>
      <span class="decaytime" title="time left before it decays" style="color:${accent}">${ICON.clock}<span class="dt">${humanLeft(it.decay.remaining)}</span></span>
    </div>

    ${it.count > 1 ? '<div class="thread" hidden></div>' : ''}
    <div class="composer" hidden>
      <textarea placeholder="Reply to ${esc(it.fromName)}…" rows="3"></textarea>
      <button class="send">${ICON.send} Send</button>
    </div>

    <div class="sliver" style="background:${accent}"></div>
    <div class="burst" style="color:${accent}">♥</div>`;

  wireCard(el, it);
  return el;
}

window.mono = (txt, accent) => {
  const d = document.createElement('div');
  d.className = 'avatar mono'; d.style.background = accent; d.textContent = txt;
  return d;
};

function fetchThread(threadId) {
  return fetch(`/api/thread?id=${encodeURIComponent(threadId)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

// Preload every multi-message thread in one parallel batch (server uses its pool),
// so opening "reply" is instant. Fire-and-forget; never blocks mark-as-read.
async function prefetchThreads() {
  const ids = items.filter((i) => i.count > 1 && !i._thread).map((i) => i.threadId);
  if (!ids.length) return;
  try {
    const r = await fetch('/api/threads?ids=' + encodeURIComponent(ids.join(',')));
    if (!r.ok) return;
    const map = await r.json();
    for (const it of items) if (map[it.threadId] && map[it.threadId].messages && map[it.threadId].messages.length) it._thread = map[it.threadId];
  } catch { /* ignore — reply falls back to lazy fetch */ }
}

function wireCard(el, it) {
  const content = el.querySelector('.content');
  const bodyEl = el.querySelector('.body');
  const moreBtn = el.querySelector('.more');
  const threadEl = el.querySelector('.thread');
  const composer = el.querySelector('.composer');

  // "more" — expand THIS message's content, shown as-is (no thread loading)
  requestAnimationFrame(() => { if (bodyEl.scrollHeight - bodyEl.clientHeight > 4) moreBtn.hidden = false; });
  moreBtn.addEventListener('click', () => {
    const open = content.classList.toggle('open');
    moreBtn.textContent = open ? 'less' : 'more';
  });

  // "reply" — reveal the whole conversation (lazy, or preloaded on hover) + composer
  const replyBtn = el.querySelector('.reply');
  let threadLoaded = false;
  async function loadThreadOnce() {
    if (it.count > 1 && threadEl && !threadLoaded) {
      const d = it._thread || await fetchThread(it.threadId);
      if (d && d.messages && d.messages.length) {
        threadEl.innerHTML = d.messages.map(threadMsg).join('');
        const cnt = el.querySelector('.act.reply .actcount');
        if (cnt && d.count) cnt.textContent = d.count;
      }
      threadLoaded = true;
    }
  }
  replyBtn.addEventListener('pointerenter', () => { // preload on intent so the click is instant
    if (it.count > 1 && !it._thread && !it._prefetching) {
      it._prefetching = true;
      fetchThread(it.threadId).then((d) => { if (d) it._thread = d; });
    }
  });
  replyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (composer.hidden) {                          // open
      await loadThreadOnce();
      if (it.count > 1 && threadEl) threadEl.hidden = false; // re-show every time
      composer.hidden = false;
      composer.querySelector('textarea').focus();
    } else {                                         // close
      composer.hidden = true;
      if (threadEl) threadEl.hidden = true;
    }
  });

  // double-tap to star (mobile only — desktop double-click stays free for copy)
  let last = 0;
  el.addEventListener('touchend', (e) => {
    const t = Date.now();
    if (t - last < 300 && !e.target.closest('.actions,.composer,.more,a')) { e.preventDefault(); setStar(el, it, !it.kept, true); }
    last = t;
  });

  el.querySelector('.star').addEventListener('click', (e) => { e.stopPropagation(); setStar(el, it, !it.kept, false); });
  el.querySelector('.send').addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    const ta = composer.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    const orig = btn.innerHTML; btn.disabled = true; btn.textContent = 'sending…';
    try {
      const r = await fetch('/api/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: it.uid, text }) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || r.statusText);
      ta.value = '';
      composer.hidden = true; // close the composer, but KEEP the thread visible…

      // …and append the reply so the user sees it land in the conversation.
      const sent = { fromName: 'You', fromMe: true, received: Date.now(), body: text, seen: true };
      let te = threadEl;
      if (!te) { // a single-message card has no thread container yet — create one
        te = document.createElement('div');
        te.className = 'thread';
        composer.parentNode.insertBefore(te, composer);
      } else {
        await loadThreadOnce(); // make sure prior messages are rendered before we append
      }
      te.insertAdjacentHTML('beforeend', threadMsg(sent));
      te.hidden = false;
      if (it._thread && Array.isArray(it._thread.messages)) {
        it._thread.messages.push(sent);
        it._thread.count = (it._thread.count || it.count || 0) + 1;
      }

      it.count = (it.count || 1) + 1;
      it.answered = true;  // your reply is now the latest message → resets the decay clock
      it.responded = true; // last thread message is now mine → solid bubble
      const rb = el.querySelector('.act.reply');
      rb.classList.add('responded');
      rb.title = 'Responded — your reply is the latest message';
      rb.innerHTML = ICON.commentSolid + `<span class="actcount">${it.count}</span>`;
      toast('Reply sent');
    } catch (err) {
      toast('Couldn’t send: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  });
  // share → open the eject menu (calendar · share · export)
  const ejectMenu = el.querySelector('.ejectmenu');
  el.querySelector('.share').addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = ejectMenu.hidden;
    document.querySelectorAll('.ejectmenu').forEach((m) => { m.hidden = true; }); // close others
    ejectMenu.hidden = !opening;
  });
  ejectMenu.querySelectorAll('button[data-eject]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    ejectMenu.hidden = true;
    if (b.dataset.eject === 'cal') addToCalendar(el, it);
    else if (b.dataset.eject === 'dl-email') downloadMail(el, it, 'email');
    else if (b.dataset.eject === 'dl-thread') downloadMail(el, it, 'thread');
    else copyClip(el, it);
  }));
}

// "Shared" = the payload has left the pipe (calendar / download / copy). Tracked with a
// Gmail label (POST /api/share) so the solid share icon syncs across devices.
function markShared(el, it) {
  if (it.shared) return;
  it.shared = true;
  const b = el.querySelector('.act.share');
  if (b) { b.classList.add('done'); b.innerHTML = ICON.sendSolid; }
  fetch('/api/share', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: it.uid, uids: it.uids, on: true }) }).catch(() => { });
}

// ---- calendar export: a no-auth Google Calendar "template" URL (no OAuth, no storage)
function calBasic(iso) { // ISO → YYYYMMDD or YYYYMMDDTHHMMSSZ
  const d = new Date(iso);
  if (isNaN(d)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.replace(/-/g, '');
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function calDateLabel(ev) {
  const d = new Date(ev.start); if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function calendarUrl(it) {
  const ev = it.event || {};
  const p = new URLSearchParams({ action: 'TEMPLATE', text: ev.title || it.subject || 'Event' });
  if (ev.start) {
    const s = calBasic(ev.start);
    let e = ev.end && calBasic(ev.end);
    if (!e && s) { // default span: +2h, or next day for all-day
      e = ev.allDay ? calBasic(new Date(new Date(ev.start).getTime() + 864e5).toISOString().slice(0, 10))
        : calBasic(new Date(new Date(ev.start).getTime() + 72e5).toISOString());
    }
    if (s && e) p.set('dates', `${s}/${e}`);
  }
  if (ev.location) p.set('location', ev.location);
  // mirror Gemini: link back to the source thread in Gmail (durable while it's in All Mail)
  const src = it.threadId && /^\d+$/.test(String(it.threadId)) ? `https://mail.google.com/mail/u/0/#all/thread-f:${it.threadId}` : '';
  const details = [src && `Source: ${src}`, (it.body || '').replace(/^You:\s*/, '').slice(0, 800)].filter(Boolean).join('\n\n');
  if (details) p.set('details', details);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
function addToCalendar(el, it) {
  window.open(calendarUrl(it), '_blank', 'noopener');
  markShared(el, it);
  toast(it.event && it.event.start ? 'Opening calendar — date prefilled' : 'Opening calendar — set the date');
}

function setStar(el, it, on, burst) {
  it.kept = on;
  el.classList.toggle('kept', on); // fills the heart via CSS
  // Like no longer buys time — it's just a flag that surfaces the item in Write mode.
  // The decay cue stays untouched; lifetime is driven by the latest message's date.
  if (on && burst) { const b = el.querySelector('.burst'); b.classList.remove('go'); void b.offsetWidth; b.classList.add('go'); }
  fetch('/api/keep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: it.uid, on }) }).catch(() => { });
}

// plain-text rendering of the payload, used by both download and copy
function payloadText(it) {
  const ev = it.event;
  const from = it.fromAddress ? `${it.fromName} <${it.fromAddress}>`
    : (it.fromDomain ? `${it.fromName} <@${it.fromDomain}>` : it.fromName);
  return [
    `Subject: ${it.subject}`,
    `From: ${from}`,
    ev && ev.start ? `Event: ${ev.start}${ev.location ? ` · ${ev.location}` : ''}` : '',
    '',
    (it.body || '').replace(/^You:\s*/, ''),
  ].filter((l) => l !== null && l !== undefined).join('\n').trim();
}
function slug(s) { return (s || 'email').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'email'; }

// Download the real raw message source. scope 'email' → this message (.eml);
// 'thread' → the whole conversation (.mbox). The format is silent — the file just
// opens in any mail client. Fetched from the relay (which pulls the IMAP source).
async function downloadMail(el, it, scope) {
  const ext = scope === 'thread' ? 'mbox' : 'eml';
  try {
    const q = new URLSearchParams({ id: it.threadId || '', uid: String(it.uid), scope });
    const r = await fetch('/api/download?' + q);
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${slug(it.subject)}.${ext}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    markShared(el, it); // payload left the pipe → solid icon
    toast(scope === 'thread' ? 'Thread downloaded' : 'Email downloaded');
  } catch { toast('Download failed'); }
}

async function copyClip(el, it) {
  try {
    await navigator.clipboard.writeText(payloadText(it));
    markShared(el, it);
    toast('Copied to clipboard');
  } catch { toast('Copy failed'); }
}

// mark-as-read when a card is genuinely viewed (≥60% visible for ≥900ms)
let observer;
function observeCards() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (e.isIntersecting && e.intersectionRatio >= 0.6) el._timer = setTimeout(() => markSeen(el), 900);
      else clearTimeout(el._timer);
    }
  }, { threshold: [0, 0.6, 1] });
  feedEl.querySelectorAll('.card:not(.seen)').forEach((c) => observer.observe(c));
}

function markSeen(el) {
  const uid = Number(el.dataset.uid);
  const it = items.find((i) => i.uid === uid);
  if (!it || it.seen) return;
  it.seen = true;
  el.classList.add('seen');
  observer.unobserve(el);
  fetch('/api/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uids: it.uids || [uid] }) }).catch(() => { });
}

let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// controls — inject header icons
document.querySelector('.refresh').innerHTML = ICON.refresh;
document.querySelectorAll('.mode').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    mode = b.dataset.mode;
    render();
  })
);
document.querySelector('.refresh').addEventListener('click', () => load()); // refresh: no cache re-paint

// close any open eject menu when clicking outside it
document.addEventListener('click', (e) => {
  if (e.target.closest('.ejectmenu') || e.target.closest('.act.share')) return;
  document.querySelectorAll('.ejectmenu:not([hidden])').forEach((m) => { m.hidden = true; });
});

// theme: cycle light → dark → auto. 'auto' = no attribute → follows the OS.
const THEME_CYCLE = ['light', 'dark', 'auto'];
const THEME_ICON = { light: 'sun', dark: 'theme', auto: 'monitor' };
function applyTheme(choice) {
  if (choice === 'auto') { delete document.documentElement.dataset.theme; localStorage.removeItem('theme'); }
  else { document.documentElement.dataset.theme = choice; localStorage.setItem('theme', choice); }
  const btn = document.querySelector('.theme');
  btn.innerHTML = ICON[THEME_ICON[choice]];
  btn.title = `Theme: ${choice}${choice === 'auto' ? ' (following system)' : ''} — tap to change`;
}
applyTheme(localStorage.getItem('theme') || 'auto');
document.querySelector('.theme').addEventListener('click', () => {
  const cur = localStorage.getItem('theme') || 'auto';
  applyTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length]);
});

load(true); // first paint: use the cache
