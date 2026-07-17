import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTextPart, decodePart, stripHtml, trimQuoted, cleanBody, extractImage, gmDate, metaOf } from '../server/transport.js';

test('findTextPart prefers HTML over plain and returns part id', () => {
  const node = { childNodes: [
    { type: 'text/plain', part: '1', encoding: '7bit' },
    { type: 'text/html', part: '2', encoding: 'quoted-printable' },
  ] };
  const p = findTextPart(node);
  assert.equal(p.part, '2');
  assert.equal(p.isHtml, true);
  assert.equal(p.encoding, 'quoted-printable');
});

test('findTextPart falls back to plain when no html', () => {
  const p = findTextPart({ childNodes: [{ type: 'text/plain', part: '1' }] });
  assert.equal(p.part, '1');
  assert.equal(p.isHtml, false);
});

test('decodePart handles base64', () => {
  assert.equal(decodePart(Buffer.from('SGVsbG8gd29ybGQ='), 'base64', 'utf8'), 'Hello world');
});

test('decodePart handles quoted-printable as UTF-8 (multibyte reassembled)', () => {
  // =C3=AD is "í" in UTF-8 — must come back as one char, not "Ã­"
  assert.equal(decodePart(Buffer.from('Mat=C3=ADas'), 'quoted-printable', 'utf8'), 'Matías');
});

test('decodePart respects latin1 charset', () => {
  assert.equal(decodePart(Buffer.from([0x4d, 0x61, 0x74, 0xed, 0x61, 0x73]), '7bit', 'latin1'), 'Matías');
});

test('stripHtml removes style/script/blockquote and decodes basic entities', () => {
  const html = '<style>.x{color:red}</style><p>Hi&nbsp;there &amp; co</p><blockquote>quoted reply</blockquote>';
  const out = stripHtml(html).replace(/\s+/g, ' ').trim();
  assert.ok(!out.includes('color:red'), 'style contents dropped');
  assert.ok(!out.includes('quoted reply'), 'blockquote dropped');
  assert.ok(out.includes('Hi there & co'), `entities decoded: "${out}"`);
});

test('trimQuoted cuts reply chains (English, Spanish, > lines)', () => {
  assert.equal(trimQuoted('My reply.\nOn Mon, Jan 1, 2026 at 9:00, Bob <b@x.com> wrote:\nold stuff').trim(), 'My reply.');
  assert.equal(trimQuoted('Mi respuesta.\nEl dom, 1 ene 2026, Bob escribió:\nviejo').trim(), 'Mi respuesta.');
  assert.equal(trimQuoted('Top.\n> quoted line\n> more quoted').trim(), 'Top.');
});

test('cleanBody trims quotes, collapses whitespace, bounds length', () => {
  const out = cleanBody('Hello   world\n\n\n\nOn Jan 1 Bob wrote:\nold');
  assert.equal(out, 'Hello world');
  assert.ok(cleanBody('x'.repeat(9000)).length === 9000);   // no longer cut at 4000
  assert.ok(cleanBody('x'.repeat(20000)).length <= 16000);  // but still bounded
});

test('extractImage skips tracking pixels and prefers content over logo', () => {
  assert.equal(extractImage('<img src="https://e.com/pixel.gif" width="1" height="1">'), null);
  assert.equal(extractImage('<img src="https://e.com/track/open.png">'), null);
  // only a logo available -> fall back to it
  assert.equal(extractImage('<img src="https://e.com/logo.png">'), 'https://e.com/logo.png');
  // content image wins over a leading logo
  assert.equal(
    extractImage('<img src="https://e.com/logo.png"><img src="https://e.com/hero.jpg">'),
    'https://e.com/hero.jpg',
  );
  assert.equal(extractImage('<p>no images here</p>'), null);
});

test('gmDate formats as Y/M/D for Gmail search', () => {
  assert.equal(gmDate('2026-06-01T12:00:00Z'), '2026/6/1');
});

test('metaOf marks fromMe and extracts identity', () => {
  const msg = {
    uid: 42, threadId: 't1', internalDate: new Date('2026-06-01T00:00:00Z'),
    flags: new Set(['\\Seen']),
    envelope: { subject: 'Hi', from: [{ name: 'Me', address: 'cabra@MIRLO.mx' }] },
    bodyStructure: { type: 'text/plain', part: '1' },
  };
  const m = metaOf(msg, 'cabra@mirlo.mx');
  assert.equal(m.uid, 42);
  assert.equal(m.fromMe, true);          // case-insensitive match
  assert.equal(m.seen, true);
  assert.equal(m.fromDomain, 'mirlo.mx');
});
