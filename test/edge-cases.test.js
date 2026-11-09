// Edge cases across the site's server, in the mode the site runs in (paid by Bit or PayBox and
// approved by David): the edges of today and of how far ahead one can book, the summer-time
// change, leap days and the turn of the year, opening hours entered twice over, notices to the
// minute, cards that run out, approving or cancelling twice, phone numbers typed every way, text
// that tries to break out of the page, odd requests, and how long a sign-in and an invite last.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { bookingIcs } from '../worker/calendar.js';
import { hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';
import { fakeKV } from './support/fake-kv.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };
const SITE = 'https://clinic.example';
const PAGE = '<!doctype html><html><head><title>x</title></head><body></body></html>';

/** The site as it runs, its clock at `at` (it can be moved), with David signed in until `until`. */
async function setup(at = '2026-11-09T06:00:00Z', { until = '2099-01-01T00:00:00.000Z' } = {}) {
  let now = new Date(at);
  const env = {
    DB: fakeD1(),
    MEDIA: fakeKV(),
    BOOKING_MODE: 'transfer',
    ASSETS: { fetch: async () => new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) },
  };
  const worker = createWorker({ config, clock: () => now, log: silent });
  env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
  env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(await hashCode('session-token'), until);
  const call = async (path, { method = 'GET', body, admin = false, headers = {} } = {}) => {
    const h = { ...headers, ...(admin ? { Cookie: '__Host-admin=session-token' } : {}) };
    if (body !== undefined) h['Content-Type'] ??= 'application/json';
    const res = await worker.fetch(
      new Request(`${SITE}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
      env,
      { waitUntil() {} },
    );
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* a page */
    }
    return { status: res.status, body: data, headers: res.headers };
  };
  const slots = async (date) => (await call(`/api/availability?service=dry-needling&from=${date}&to=${date}`)).body.days?.[date] ?? [];
  const book = (date, time, more = {}) =>
    call('/api/bookings', { method: 'POST', body: { serviceId: 'dry-needling', date, time, name: 'דנה לוי', phone: '050-1234567', consent: true, plan: 'single', ...more } });
  const admin = (path, method = 'GET', body) => call(path, { method, body, admin: true });
  const set = (iso) => {
    now = new Date(iso);
  };
  const advance = (minutes) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };
  return { env, worker, call, slots, book, admin, set, advance };
}

// The opening hours (config/site.json): Sunday 12:30–19:00, Monday 08:00–14:30, Wednesday
// 13:00–19:00, Thursday 10:00–19:00; an hour each, every half hour, 15 minutes between; up to
// 30 days ahead. 9 Nov 2026 is a Monday.

test('today: only times still ahead, the last one ending by closing time; the date turns at midnight in Israel', async () => {
  const { slots, book, call, set } = await setup('2026-11-09T11:10:00Z'); // Monday 13:10
  assert.deepEqual(await slots('2026-11-09'), ['13:30']); // 14:00 would end after 14:30
  set('2026-11-09T11:30:00Z'); // 13:30
  assert.deepEqual(await slots('2026-11-09'), ['13:30']);
  set('2026-11-09T11:31:00Z'); // 13:31: nothing left today
  assert.deepEqual(await slots('2026-11-09'), []);
  assert.equal((await book('2026-11-09', '13:30')).status, 409);
  set('2026-11-09T21:59:00Z'); // 23:59
  assert.equal((await call('/api/config')).body.today, '2026-11-09');
  set('2026-11-09T22:00:00Z'); // midnight
  assert.equal((await call('/api/config')).body.today, '2026-11-10');
  assert.deepEqual(await slots('2026-11-09'), []);
});

test('how far ahead: the 30th day can be booked, the 31st can’t', async () => {
  const { slots, book, call } = await setup('2026-11-09T06:00:00Z');
  assert.equal((await slots('2026-12-09'))[0], '13:00'); // Wednesday, day 30
  const both = (await call('/api/availability?service=dry-needling&from=2026-12-09&to=2026-12-10')).body.days;
  assert.deepEqual(Object.keys(both), ['2026-12-09']); // Thursday, day 31, isn't offered
  assert.equal((await book('2026-12-10', '10:00')).status, 409);
  assert.equal((await book('2026-12-09', '13:00')).status, 201);
});

test('a booking only goes in at a time the booking page offers', async () => {
  const { book, admin } = await setup('2026-11-09T06:00:00Z');
  assert.equal((await book('2026-11-11', '13:15')).status, 409); // between two times
  assert.equal((await book('2026-11-11', '03:00')).status, 409); // the middle of the night
  assert.equal((await book('2026-11-11', '18:30')).status, 409); // would end after 19:00
  assert.equal((await book('2026-11-13', '10:00')).status, 409); // Friday: closed
  assert.equal((await book('2026-11-08', '13:00')).status, 409); // yesterday
  assert.equal((await admin('/api/admin/notices', 'POST', { kind: 'alert', text: 'סגור היום', closeFrom: '2026-11-11', closeTo: '2026-11-11' })).status, 201);
  assert.equal((await book('2026-11-11', '13:00')).status, 409); // closed by a notice
  assert.equal((await book('2026-11-12', '10:00')).status, 201);
});

test('dates: leap days, days that don’t exist, and the turn of the year', async () => {
  const { call, slots, book, admin } = await setup('2026-12-28T08:00:00Z'); // Monday 28 Dec, 10:00
  assert.equal((await call('/api/availability?service=dry-needling&from=2027-02-29&to=2027-02-29')).status, 400);
  assert.equal((await call('/api/availability?service=dry-needling&from=2028-02-29&to=2028-02-29')).status, 200);
  assert.deepEqual((await book('2026-02-30', '10:00')).body.fields, ['date']);
  assert.deepEqual((await book('2026-12-31', '24:00')).body.fields, ['time']);
  assert.deepEqual((await book('2026-12-31', '9:00')).body.fields, ['time']);
  const days = (await call('/api/availability?service=dry-needling&from=2026-12-28&to=2027-01-05')).body.days;
  assert.equal(Object.keys(days).length, 9);
  assert.ok(days['2026-12-31'].length > 0); // Thursday
  assert.deepEqual(days['2027-01-01'], []); // Friday
  assert.ok(days['2027-01-03'].length > 0); // Sunday
  // Closed from New Year's Eve to the first Sunday, in one go
  assert.equal((await admin('/api/admin/blocked', 'POST', { from: '2026-12-31', to: '2027-01-03', note: 'חופשה' })).status, 201);
  assert.deepEqual(await slots('2026-12-31'), []);
  assert.deepEqual(await slots('2027-01-03'), []);
  assert.ok((await slots('2027-01-04')).length > 0);
  assert.equal((await book('2027-01-04', '08:00')).status, 201);
});

test('the clock change: times stay in Israel time, and each booking is held until its own hour', async () => {
  // Thursday 21 Oct 2027, 09:00 summer time; the clocks go back on Sunday 31 Oct at 02:00
  const { book, env, admin, call, set } = await setup('2027-10-21T06:00:00Z');
  const held = (ref) => env.DB.raw.prepare('SELECT hold_until FROM bookings WHERE ref = ?').get(ref).hold_until;
  const before = await book('2027-10-28', '10:00'); // summer time (UTC+3)
  const after = await book('2027-10-31', '12:30', { phone: '052-7654321' }); // winter time (UTC+2)
  assert.equal(before.status, 201);
  assert.equal(after.status, 201);
  assert.equal(held(before.body.booking.ref), '2027-10-28T07:00:00.000Z');
  assert.equal(held(after.body.booking.ref), '2027-10-31T10:30:00.000Z');
  // Notices set by the clock on the wall, either side of the change
  const n1 = await admin('/api/admin/notices', 'POST', { kind: 'info', text: 'לפני השינוי', startsAt: '2027-10-30T10:00' });
  const n2 = await admin('/api/admin/notices', 'POST', { kind: 'info', text: 'אחרי השינוי', startsAt: '2027-10-31T10:00' });
  assert.equal(n1.body.notice.starts_at, '2027-10-30T07:00:00.000Z');
  assert.equal(n2.body.notice.starts_at, '2027-10-31T08:00:00.000Z');
  // The hour that happens twice (01:00–02:00 on 31 Oct) and the one that never happens (02:00–03:00 on 26 Mar)
  const twice = await admin('/api/admin/notices', 'POST', { kind: 'info', text: 'שעה כפולה', startsAt: '2027-10-31T01:30' });
  assert.equal(twice.status, 201);
  set('2027-03-20T08:00:00Z');
  const never = await admin('/api/admin/notices', 'POST', { kind: 'info', text: 'שעה שלא קיימת', startsAt: '2027-03-26T02:30' });
  assert.equal(never.status, 201);
  assert.ok(!Number.isNaN(Date.parse(never.body.notice.starts_at)));
  // The date turns at midnight on the wall clock, on both sides of the change
  set('2027-10-30T20:59:00Z'); // 23:59 summer time
  assert.equal((await call('/api/config')).body.today, '2027-10-30');
  set('2027-10-30T21:00:00Z');
  assert.equal((await call('/api/config')).body.today, '2027-10-31');
  set('2027-10-31T21:59:00Z'); // 23:59 winter time
  assert.equal((await call('/api/config')).body.today, '2027-10-31');
  set('2027-10-31T22:00:00Z');
  assert.equal((await call('/api/config')).body.today, '2027-11-01');
});

test('a notice shows from the minute it starts and is gone the minute it ends', async () => {
  const { admin, call, set } = await setup('2026-11-09T06:00:00Z');
  const made = await admin('/api/admin/notices', 'POST', { kind: 'news', text: 'שעות חדשות מהיום', startsAt: '2026-11-09T10:00', endsAt: '2026-11-09T23:59' });
  assert.equal(made.status, 201);
  const shown = async () => (await call('/api/site')).body.notices.map((n) => n.text);
  const onPage = async () => (await call('/')).body.includes('שעות חדשות מהיום');
  set('2026-11-09T07:59:00Z'); // 09:59
  assert.deepEqual(await shown(), []);
  assert.equal(await onPage(), false);
  set('2026-11-09T08:00:00Z'); // 10:00
  assert.deepEqual(await shown(), ['שעות חדשות מהיום']);
  assert.equal(await onPage(), true);
  set('2026-11-09T21:58:00Z'); // 23:58
  assert.deepEqual(await shown(), ['שעות חדשות מהיום']);
  set('2026-11-09T21:59:00Z'); // 23:59
  assert.deepEqual(await shown(), []);
  assert.equal(await onPage(), false);
});

test('opening hours entered twice over the same hours don’t offer a time twice', async () => {
  const { admin, slots } = await setup('2026-11-09T06:00:00Z');
  const schedule = (await admin('/api/admin/schedule')).body.schedule;
  const saved = await admin('/api/admin/schedule', 'PUT', { ...schedule, weeklyHours: { ...schedule.weeklyHours, 1: [['08:00', '12:00'], ['11:00', '14:30']] } });
  assert.equal(saved.status, 200);
  const monday = await slots('2026-11-16');
  assert.equal(new Set(monday).size, monday.length, `no time twice: ${monday}`);
  assert.deepEqual(monday, [...monday].sort());
  assert.equal(monday[0], '08:00');
  assert.equal(monday.at(-1), '13:30');
});

test('cards: a session from an empty card shows 0 left and never goes below it; a new card adds its sessions', async () => {
  const { admin, book } = await setup('2026-11-09T06:00:00Z');
  assert.equal((await admin('/api/admin/clients', 'POST', { name: 'נועה כהן', phone: '050-1234567', cardLeft: 0 })).status, 201);
  const waiting = async (ref) => (await admin('/api/admin/bookings')).body.bookings.find((b) => b.ref === ref);
  const fromCard = await book('2026-11-11', '13:00', { plan: 'card' });
  assert.equal(fromCard.status, 201);
  assert.equal(fromCard.body.booking.price, 0);
  const row = await waiting(fromCard.body.booking.ref);
  assert.equal(row.card_left, 0); // David sees the card is empty before approving
  const approved = await admin(`/api/admin/bookings/${row.id}/approve`, 'POST', {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.cardLeft, 0); // not -1
  const pack = await book('2026-11-12', '10:00', { plan: 'pack' });
  assert.equal(pack.body.booking.price, 1200);
  const packRow = await waiting(pack.body.booking.ref);
  assert.equal((await admin(`/api/admin/bookings/${packRow.id}/approve`, 'POST', {})).body.cardLeft, 3); // this one and 3 more
  const stranger = await book('2026-11-12', '12:00', { plan: 'card', phone: '054-9999999', name: 'אדם אחר' });
  assert.equal((await waiting(stranger.body.booking.ref)).card_left, null); // "no card found" in the panel
});

test('approving or cancelling twice, or in the wrong order, is refused; a cancelled time is free again', async () => {
  const { admin, book, slots } = await setup('2026-11-09T06:00:00Z');
  assert.equal((await book('2026-11-11', '13:00')).status, 201);
  assert.ok(!(await slots('2026-11-11')).includes('13:00')); // held while it waits for David
  const id = (await admin('/api/admin/bookings')).body.bookings[0].id;
  assert.equal((await admin(`/api/admin/bookings/${id}/approve`, 'POST', {})).status, 200);
  assert.equal((await admin(`/api/admin/bookings/${id}/approve`, 'POST', {})).status, 409);
  assert.equal((await admin(`/api/admin/bookings/${id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await admin(`/api/admin/bookings/${id}/cancel`, 'POST', {})).status, 404);
  assert.equal((await admin(`/api/admin/bookings/${id}/approve`, 'POST', {})).status, 409);
  assert.ok((await slots('2026-11-11')).includes('13:00'));
  assert.equal((await admin('/api/admin/bookings/999999/approve', 'POST', {})).status, 404);
  assert.equal((await admin('/api/admin/bookings/999999/cancel', 'POST', {})).status, 404);
  assert.equal((await book('2026-11-11', '13:00', { phone: '052-7654321' })).status, 201);
});

test('clients: the same phone number typed any way is the same client; search takes % and _ as letters', async () => {
  const { admin } = await setup();
  assert.equal((await admin('/api/admin/clients', 'POST', { name: 'נועה כהן', phone: '050-123-4567' })).status, 201);
  for (const phone of ['+972 50 123 4567', '972501234567', '(050) 1234567', '0501234567', '+972-50-1234567']) {
    assert.equal((await admin('/api/admin/clients', 'POST', { name: 'שוב נועה', phone })).status, 409, phone);
  }
  for (const phone of ['abc', '123456', '1234567890123456']) {
    assert.deepEqual((await admin('/api/admin/clients', 'POST', { name: 'מישהו', phone })).body.fields, ['phone'], phone);
  }
  for (const cardLeft of ['3', 3.5, -1, 101]) {
    assert.deepEqual((await admin('/api/admin/clients', 'POST', { name: 'מישהו', phone: '052-1111111', cardLeft })).body.fields, ['cardLeft'], String(cardLeft));
  }
  assert.equal((await admin('/api/admin/clients', 'POST', { name: '100%_הנחה', phone: '052-1111111', cardLeft: 100 })).status, 201);
  const search = async (q) => (await admin(`/api/admin/clients?q=${encodeURIComponent(q)}`)).body.clients.map((c) => c.name).sort();
  assert.deepEqual(await search('%'), ['100%_הנחה']);
  assert.deepEqual(await search('_'), ['100%_הנחה']);
  assert.deepEqual(await search('נוע'), ['נועה כהן']);
  assert.deepEqual(await search('4567'), ['נועה כהן']);
  assert.deepEqual(await search('+972 50 123'), ['נועה כהן']);
  assert.equal((await search('')).length, 2);
});

test('bookings: names, phones and notes as people type them; anything odd is refused by name', async () => {
  const { book, env } = await setup('2026-11-09T06:00:00Z');
  const row = (ref) => env.DB.raw.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
  // Thursday 12 Nov: 10:00, 11:30, 13:00, 14:30 are far enough apart
  const ok = await book('2026-11-12', '10:00', { name: '  דנה  ', phone: '+972-50-123-4567', notes: 'x'.repeat(3000), email: '', lang: 'fr' });
  assert.equal(ok.status, 201);
  assert.equal(row(ok.body.booking.ref).name, 'דנה');
  assert.equal(row(ok.body.booking.ref).notes.length, 1000);
  assert.equal(row(ok.body.booking.ref).lang, 'he');
  const long = await book('2026-11-12', '11:30', { name: 'א'.repeat(200) });
  assert.equal(row(long.body.booking.ref).name.length, 80);
  assert.equal((await book('2026-11-12', '13:00', { name: '👩‍⚕️ דנה' })).status, 201);
  // Kept as plain text (the panel shows it as text: checked in the browser)
  assert.equal((await book('2026-11-12', '14:30', { name: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)>' })).status, 201);
  const refused = async (more) => (await book('2026-11-12', '16:00', more)).body.fields;
  assert.deepEqual(await refused({ name: 'א' }), ['name']);
  assert.deepEqual(await refused({ name: '     ' }), ['name']);
  assert.deepEqual(await refused({ phone: '05O-1234567' }), ['phone']);
  assert.deepEqual(await refused({ phone: '123' }), ['phone']);
  assert.deepEqual(await refused({ email: 'dana@' }), ['email']);
  assert.deepEqual(await refused({ email: 'a@b' }), ['email']);
  assert.deepEqual(await refused({ consent: 'true' }), ['consent']);
  assert.deepEqual(await refused({ consent: undefined }), ['consent']);
  assert.deepEqual(await refused({ plan: 'free' }), ['plan']);
  assert.deepEqual(await refused({ plan: undefined }), ['plan']);
  assert.deepEqual(await refused({ serviceId: 'massage' }), ['serviceId']);
});

test('closed days: up to a year in one go; backwards, impossible or empty requests are refused', async () => {
  const { admin } = await setup('2026-11-09T06:00:00Z');
  assert.equal((await admin('/api/admin/blocked', 'POST', { from: '2026-11-20', to: '2027-11-20' })).status, 201); // 366 days
  assert.equal((await admin('/api/admin/blocked', 'POST', { from: '2026-11-20', to: '2027-11-21' })).status, 400);
  assert.equal((await admin('/api/admin/blocked', 'POST', { from: '2026-11-25', to: '2026-11-20' })).status, 400);
  assert.equal((await admin('/api/admin/blocked', 'POST', { from: '2026-11-31' })).status, 400);
  assert.equal((await admin('/api/admin/blocked', 'POST', {})).status, 400);
  assert.equal((await admin('/api/admin/blocked/2026-11-25/2026-11-20', 'DELETE', {})).status, 400);
  assert.equal((await admin('/api/admin/blocked/2026-11-30/2026-11-31', 'DELETE', {})).status, 400);
  assert.equal((await admin('/api/admin/blocked/2026-11-20/2027-11-20', 'DELETE', {})).body.blocked.length, 0);
  assert.equal((await admin('/api/admin/blocked/2026-11-20/2027-11-20', 'DELETE', {})).status, 404); // nothing left to open
  const note = (await admin('/api/admin/blocked', 'POST', { date: '2026-11-22', note: 'ה'.repeat(500) })).body.blocked[0].note;
  assert.equal(note.length, 120);
});

test('opening hours and settings: every limit holds', async () => {
  const { admin } = await setup();
  const base = (await admin('/api/admin/schedule')).body.schedule;
  const put = (change) => admin('/api/admin/schedule', 'PUT', { ...base, ...change });
  const fields = async (change) => (await put(change)).body.fields;
  const day = (ranges) => ({ weeklyHours: { ...base.weeklyHours, 1: ranges } });
  for (const ok of [{ slotInterval: 5 }, { slotInterval: 240 }, { bufferMinutes: 0 }, { bufferMinutes: 240 }, { minNoticeHours: 336 }, { maxDaysAhead: 1 }, { maxDaysAhead: 365 }]) {
    assert.equal((await put(ok)).status, 200, JSON.stringify(ok));
  }
  assert.deepEqual(await fields({ slotInterval: 4 }), ['slotInterval']);
  assert.deepEqual(await fields({ slotInterval: 241 }), ['slotInterval']);
  assert.deepEqual(await fields({ slotInterval: 30.5 }), ['slotInterval']);
  assert.deepEqual(await fields({ slotInterval: '30' }), ['slotInterval']);
  assert.deepEqual(await fields({ bufferMinutes: -1 }), ['bufferMinutes']);
  assert.deepEqual(await fields({ minNoticeHours: 337 }), ['minNoticeHours']);
  assert.deepEqual(await fields({ maxDaysAhead: 0 }), ['maxDaysAhead']);
  assert.deepEqual(await fields({ maxDaysAhead: 366 }), ['maxDaysAhead']);
  assert.deepEqual(await fields(day([['09:00', '09:00']])), ['weeklyHours.1']);
  assert.deepEqual(await fields(day([['10:00', '09:00']])), ['weeklyHours.1']);
  assert.deepEqual(await fields(day([['9:00', '12:00']])), ['weeklyHours.1']);
  assert.deepEqual(await fields(day([['24:00', '25:00']])), ['weeklyHours.1']);
  assert.deepEqual(await fields(day('closed')), ['weeklyHours.1']);
  assert.deepEqual(await fields(day(Array.from({ length: 7 }, (_, i) => [`0${i}:00`, `0${i}:30`]))), ['weeklyHours.1']);
  assert.equal((await put(day(null))).status, 200); // nothing for a day: closed that day
});

test('a sign-in lasts 12 hours', async () => {
  const { call, advance } = await setup('2026-11-09T06:00:00Z', { until: '2026-11-09T18:00:00.000Z' });
  const clients = () => call('/api/admin/clients', { admin: true });
  advance(12 * 60 - 1);
  assert.equal((await clients()).status, 200);
  advance(1);
  assert.equal((await clients()).status, 401);
});

test('an invite link works for 48 hours, and a made-up one never', async () => {
  const { admin, call, advance } = await setup();
  const link = (await admin('/api/admin/invites', 'POST', { name: 'רותם' })).body.link;
  const code = link.split('#invite=')[1];
  const start = (invite) => call('/api/admin/passkey/register/start', { method: 'POST', body: invite === undefined ? {} : { invite } });
  advance(48 * 60 - 1);
  assert.equal((await start(code)).status, 200);
  advance(2);
  assert.equal((await start(code)).status, 403);
  assert.equal((await start('made-up-code')).status, 403);
  assert.equal((await start()).status, 403);
});

test('text that tries to end the page’s data block stays text', async () => {
  const { admin, call } = await setup('2026-11-09T06:00:00Z');
  const notice = await admin('/api/admin/notices', 'POST', { kind: 'alert', text: '</script><script>alert(1)</script><!-- \u2028 שלום' });
  assert.equal(notice.status, 201);
  assert.equal((await admin('/api/admin/content', 'PUT', { texts: { 'contact.title': '</SCRIPT ><img src=x onerror=alert(2)>' } })).status, 200);
  const html = (await call('/')).body;
  assert.equal(html.match(/<\/script/gi).length, 1); // only the data block's own end
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!/<img src=x/i.test(html));
  const data = JSON.parse(/<script type="application\/json" id="site-data">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(data.notices[0].text, notice.body.notice.text);
  assert.equal(data.content.texts['contact.title'], '</SCRIPT ><img src=x onerror=alert(2)>');
});

test('odd requests: other sites, other formats, wrong methods, made-up paths', async () => {
  const { call, book } = await setup('2026-11-09T06:00:00Z');
  const body = { serviceId: 'dry-needling', date: '2026-11-11', time: '13:00', name: 'דנה', phone: '0501234567', consent: true, plan: 'single' };
  assert.equal((await call('/api/bookings', { method: 'POST', body, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/bookings', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/bookings', { method: 'POST', body: '{"name":' })).status, 400);
  assert.equal((await call('/api/bookings', { method: 'POST', body: [body] })).status, 400); // a list: as if nothing was sent
  assert.equal((await call('/api/bookings', { method: 'POST', body: { ...body, notes: 'x'.repeat(25_000) } })).status, 413);
  const polluted = await call('/api/bookings', { method: 'POST', body: '{"__proto__":{"consent":true},"constructor":{"prototype":{"admin":true}}}' });
  assert.equal(polluted.status, 400);
  assert.equal({}.consent, undefined);
  assert.equal({}.admin, undefined);
  assert.equal((await call('/api/config', { method: 'DELETE', body: {} })).status, 404);
  assert.equal((await call('/api/nothing-here')).status, 404);
  assert.equal((await call('/api/admin/clients/abc')).status, 401); // not signed in: nothing about what exists
  assert.equal((await call('/api/admin/clients/abc', { admin: true })).status, 404);
  assert.equal((await call(`/api/bookings/status?ref=${'A'.repeat(500)}`)).status, 404);
  const made = await book('2026-11-11', '13:00');
  assert.deepEqual((await call(`/api/bookings/status?ref=${made.body.booking.ref}`)).body, { status: 'pending' }); // nothing else about it
});

test('characters a keyboard doesn’t type are left out of a booking, and a long name never ends in half an emoji', async () => {
  const { book, env } = await setup('2026-11-09T06:00:00Z');
  const row = (ref) => ({ ...env.DB.raw.prepare('SELECT name, notes FROM bookings WHERE ref = ?').get(ref) });
  const odd = await book('2026-11-12', '10:00', { name: 'דנה\u0000 \u202eלוי\ud83d', notes: 'שורה\r\nשנייה\u0007\tסוף' });
  assert.equal(odd.status, 201);
  assert.deepEqual(row(odd.body.booking.ref), { name: 'דנה לוי', notes: 'שורה\nשנייה סוף' });
  const long = await book('2026-11-12', '11:30', { name: `${'א'.repeat(79)}🙂🙂` });
  assert.equal(row(long.body.booking.ref).name, `${'א'.repeat(79)}🙂`);
  // A booking that came in before this, with such characters, still makes an event the calendar takes
  const ics = bookingIcs({
    booking: { ref: 'ABC234', date: '2026-11-12', time: '10:00', duration: 60, name: 'דנה\u0000\u001b לוי', phone: '0501234567', notes: 'א\rב\u0007', price: 350 },
    serviceName: 'דיקור',
    tz: 'Asia/Jerusalem',
    now: new Date('2026-11-09T06:00:00Z'),
  });
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(ics), 'no control characters in the event');
  assert.ok(!/\r(?!\n)/.test(ics), 'no lone carriage returns');
  assert.match(ics, /SUMMARY:דנה לוי – דיקור/);
});

test('only over https: a page asked for over plain http moves there, and the API takes nothing over plain http', async () => {
  const { env, worker } = await setup('2026-11-09T06:00:00Z');
  const ask = (url, init) => worker.fetch(new Request(url, init), env, { waitUntil() {} });
  for (const path of ['/', '/book?x=1', '/media/abcdefghijklmnop-1080.jpg']) {
    const res = await ask(`http://clinic.example${path}`);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), `https://clinic.example${path}`);
  }
  const booking = await ask('http://clinic.example/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(booking.status, 403);
  assert.equal((await booking.json()).error, 'https_required');
  assert.equal((await ask('http://clinic.example/api/config')).status, 403);
  // On this computer, while developing, plain http works
  assert.equal((await ask('http://localhost:8787/api/config')).status, 200);
  assert.equal((await ask('https://clinic.example/api/config')).status, 200);
});

test('two people editing the site at the same time: each change is kept (only the same text twice takes the later one)', async () => {
  const { admin, call } = await setup('2026-11-09T06:00:00Z');
  // David (phone) and רותם (computer) both opened the editor before either saved
  assert.equal((await admin('/api/admin/content', 'PUT', { texts: { 'contact.title': 'דברו איתי' } })).status, 200);
  assert.equal((await admin('/api/admin/content', 'PUT', { texts: { 'hero.titleA': 'טיפול שמרגישים' } })).status, 200);
  let texts = (await call('/api/site')).body.content.texts;
  assert.equal(texts['contact.title'], 'דברו איתי');
  assert.equal(texts['hero.titleA'], 'טיפול שמרגישים');
  assert.equal((await admin('/api/admin/content', 'PUT', { texts: { 'contact.title': 'צרו קשר' } })).status, 200);
  texts = (await call('/api/site')).body.content.texts;
  assert.equal(texts['contact.title'], 'צרו קשר');
  assert.equal(texts['hero.titleA'], 'טיפול שמרגישים');
});
