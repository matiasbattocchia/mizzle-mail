import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayState, humanRemaining } from '../server/decay.js';

const DAY = 86400000;
const HOUR = 3600000;
const now = 1_750_000_000_000; // fixed clock
const fresh = (over = {}) => ({ category: 'primary', received: now, kept: false, answered: false, subject: '', ...over });
// remaining of a just-received message ≈ its full ttl
const ttlDays = (over) => decayState(fresh(over), now).ttl / DAY;

test('base TTL by Gmail category', () => {
  assert.equal(ttlDays({ category: 'primary' }), 7);
  assert.equal(ttlDays({ category: 'updates' }), 3);
  assert.equal(ttlDays({ category: 'social' }), 1);
  assert.equal(ttlDays({ category: 'forums' }), 1);
  assert.equal(ttlDays({ category: 'promotions' }), 1);
});

test('star adds +7 days, reply adds +14, and they stack', () => {
  assert.equal(ttlDays({ category: 'primary', kept: true }), 14);            // 7 + 7
  assert.equal(ttlDays({ category: 'primary', answered: true }), 21);        // 7 + 14
  assert.equal(ttlDays({ category: 'primary', kept: true, answered: true }), 28); // 7 + 7 + 14
  // bonuses apply regardless of base category
  assert.equal(ttlDays({ category: 'promotions', kept: true }), 8);          // 1 + 7
});

test('OTP subject short-circuits to hours regardless of category', () => {
  const d = decayState(fresh({ category: 'primary', subject: 'Your login code is 123456' }), now);
  assert.equal(d.kind, 'otp');
  assert.ok(d.ttl <= 6 * HOUR, `otp ttl should be hours, got ${d.ttl / HOUR}h`);
});

test('remaining decreases over time and expires', () => {
  const recv = now - 8 * DAY; // primary base 7d -> already expired
  const d = decayState(fresh({ received: recv }), now);
  assert.equal(d.remaining, 0);
  assert.equal(d.expired, true);
  assert.equal(d.fraction, 0);
});

test('fraction is full for a just-received message', () => {
  const d = decayState(fresh(), now);
  assert.ok(d.fraction > 0.99);
  assert.equal(d.expired, false);
});

test('humanRemaining formatting', () => {
  assert.equal(humanRemaining(0), 'gone');
  assert.equal(humanRemaining(-5), 'gone');
  assert.equal(humanRemaining(3 * DAY), '3d');
  assert.equal(humanRemaining(5 * HOUR), '5h');
  assert.equal(humanRemaining(90000), '2m'); // 1.5 min rounds to 2
});
