import { test } from 'node:test';
import assert from 'node:assert/strict';

// Hits the running relay and asserts the feed item shape. Skips if the relay
// isn't up. This guards structural regressions (e.g. a dropped `uid` field that
// silently broke mark-as-read and starring).
const BASE = process.env.FEED_URL || 'http://localhost:4173';

test('GET /api/feed returns well-formed items', { timeout: 30000 }, async (t) => {
  let data;
  try {
    const ctrl = AbortController ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(`${BASE}/api/feed`, ctrl ? { signal: ctrl.signal } : {});
    if (timer) clearTimeout(timer);
    if (!r.ok) { t.skip(`feed responded ${r.status} — relay not ready`); return; }
    data = await r.json();
  } catch (e) {
    t.skip(`relay not reachable at ${BASE} (${e.message})`);
    return;
  }

  assert.ok(Array.isArray(data.feed), 'feed is an array');
  for (const m of data.feed) {
    assert.equal(typeof m.uid, 'number', `item.uid must be a number (guards mark-as-read/star) — got ${JSON.stringify(m.uid)}`);
    assert.ok(Array.isArray(m.uids) && m.uids.length > 0, 'item.uids is a non-empty array');
    assert.ok(m.threadId, 'item.threadId present');
    assert.ok(m.category, 'item.category present');
    assert.equal(typeof m.count, 'number', 'item.count is a number');
    assert.equal(typeof m.seen, 'boolean', 'item.seen is a boolean');
    assert.ok(m.decay && typeof m.decay.human === 'string', 'item.decay.human present');
  }
});
