// The messages David still has to send (the admin panel's "הודעות לשליחה"): his appointment
// message once a booking is confirmed, a reminder the day before, the cancel message once he
// cancels; each until he marks it sent (and back, if he didn't after all).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };

function setup(vars = {}, fetchImpl) {
  const time = { now: Date.parse('2026-10-01T05:00:00Z') }; // Thursday 1 Oct, 08:00 in Israel
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer', ...vars };
  const worker = createWorker({ config, clock: () => new Date(time.now), log: silent, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
  const ready = hashCode('session-token').then((h) =>
    env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(h, '2026-12-31T00:00:00.000Z'),
  );
  const call = async (path, { method = 'GET', body, admin = true } = {}) => {
    await ready;
    const res = await worker.fetch(
      new Request(`https://clinic.example${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Cookie: '__Host-admin=session-token' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const book = async (o = {}) => {
    const r = await call('/api/bookings', {
      method: 'POST',
      admin: false,
      body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan: 'single', ...o },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return env.DB.raw.prepare('SELECT id FROM bookings WHERE ref = ?').get(r.body.booking.ref).id;
  };
  const approve = (id) => call(`/api/admin/bookings/${id}/approve`, { method: 'POST', body: {} });
  const cancel = (id) => call(`/api/admin/bookings/${id}/cancel`, { method: 'POST', body: {} });
  const due = async () => (await call('/api/admin/outbox')).body.items.map((i) => `${i.kind} ${i.booking.id}${i.cardLeft != null ? ` card ${i.cardLeft}` : ''}`);
  const mark = (id, kind, done = true) => call(`/api/admin/outbox/${id}/${kind}`, { method: 'POST', body: { done } });
  const at = (iso) => (time.now = Date.parse(iso));
  return { env, worker, time, call, book, approve, cancel, due, mark, at };
}

test('his appointment message: due once he approves, until he marks it sent (or back again)', async () => {
  const { book, approve, due, mark, call } = setup();
  const id = await book();
  assert.deepEqual(await due(), [], 'nothing while it waits for payment');
  await approve(id);
  assert.deepEqual(await due(), [`invite ${id}`]);
  const [item] = (await call('/api/admin/outbox')).body.items;
  assert.equal(item.booking.name, 'נועה כהן');
  assert.equal(item.booking.phone, '050-123-4567');
  assert.equal(item.booking.date, '2026-10-04');
  assert.equal((await mark(id, 'invite')).status, 200);
  assert.deepEqual(await due(), []);
  // He didn't send it after all: back on the list.
  await mark(id, 'invite', false);
  assert.deepEqual(await due(), [`invite ${id}`]);
});

test('a reminder the day before (and on the day, until the time), unless his message only went then', async () => {
  const { book, approve, due, mark, at } = setup();
  const early = await book({ time: '12:30' }); // Sunday 4 Oct
  await approve(early);
  await mark(early, 'invite'); // sent on Thursday 1 Oct
  assert.deepEqual(await due(), [], 'Thursday: nothing yet');
  at('2026-10-03T06:00:00Z'); // Saturday, the day before
  const late = await book({ time: '15:30' }); // same Sunday, booked and approved only now
  await approve(late);
  await mark(late, 'invite');
  assert.deepEqual(await due(), [`reminder ${early}`], 'only the one whose message went days ago');
  at('2026-10-04T06:00:00Z'); // Sunday morning: still there, he hasn't sent it
  assert.deepEqual(await due(), [`reminder ${early}`]);
  await mark(early, 'reminder');
  assert.deepEqual(await due(), []);
  // Not sent, and the time has passed: gone by itself.
  await mark(early, 'reminder', false);
  at('2026-10-04T10:00:00Z'); // 13:00 in Israel, after 12:30
  assert.deepEqual(await due(), []);
});

test('bookings confirmed before the list existed: no appointment message asked for, but the reminder is', async () => {
  const { env, book, due, at } = setup();
  at('2026-10-03T05:00:00Z'); // Saturday
  const id = await book({ date: '2026-10-04', time: '12:30' }); // tomorrow
  env.DB.raw.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(id); // (as approved long ago)
  assert.deepEqual(await due(), [`reminder ${id}`]);
  at('2026-10-04T10:00:00Z');
  assert.deepEqual(await due(), [], 'past');
});

test('the cancel message: due once he cancels, with the session back on the card when it went back', async () => {
  const { book, approve, cancel, due, mark } = setup();
  const waiting = await book({ time: '12:30' });
  await cancel(waiting); // never paid: still, she's told
  assert.deepEqual(await due(), [`cancel ${waiting}`]);
  await mark(waiting, 'cancel');
  const card = await book({ time: '14:00', plan: 'pack' });
  await approve(card);
  await mark(card, 'invite');
  assert.equal((await cancel(card)).body.cardLeft, 4);
  assert.deepEqual(await due(), [`cancel ${card} card 4`]);
});

test('the order: what to send at once first, then the reminders; each by the appointment', async () => {
  const { book, approve, cancel, due, mark, env, at } = setup();
  at('2026-10-03T05:00:00Z'); // Saturday
  const reminder = await book({ date: '2026-10-04', time: '17:00' });
  env.DB.raw.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(reminder);
  const later = await book({ date: '2026-10-08', time: '12:30' });
  const sooner = await book({ date: '2026-10-04', time: '12:30' });
  await approve(later);
  await approve(sooner);
  const gone = await book({ date: '2026-10-05', time: '12:30' });
  await cancel(gone);
  assert.deepEqual(await due(), [`invite ${sooner}`, `cancel ${gone}`, `invite ${later}`, `reminder ${reminder}`]);
  await mark(reminder, 'reminder');
  at('2026-10-06T05:00:00Z'); // the cancelled one is past: gone
  assert.deepEqual(await due(), [`invite ${later}`]);
});

test('sent by WhatsApp by itself (when connected): nothing for him to send', async () => {
  const fetchImpl = async (url) =>
    String(url).startsWith('https://graph.facebook.com/') ? Response.json({ messages: [{ id: 'wamid.1' }] }) : new Response('nope', { status: 404 });
  const { book, approve, due } = setup({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '109876543210' }, fetchImpl);
  const id = await book();
  assert.equal((await approve(id)).body.whatsapp, 'sent');
  assert.deepEqual(await due(), []);
});

test('only David: the list and the marks need his sign-in; marks only for real bookings and kinds', async () => {
  const { book, approve, call, mark } = setup();
  const id = await book();
  await approve(id);
  assert.equal((await call('/api/admin/outbox', { admin: false })).status, 401);
  assert.equal((await call(`/api/admin/outbox/${id}/invite`, { method: 'POST', body: { done: true }, admin: false })).status, 401);
  assert.equal((await mark(id, 'spam')).status, 404);
  assert.equal((await mark(99999, 'invite')).status, 404);
  assert.equal((await call(`/api/admin/outbox/${id}/invite`, { method: 'POST', body: { done: 'yes' } })).status, 400);
});

test('records of appointments more than a week past are forgotten (the daily run)', async () => {
  const { book, approve, worker, env, at } = setup();
  const id = await book();
  await approve(id);
  const rows = () => env.DB.raw.prepare("SELECT key FROM settings WHERE key LIKE 'sent:%'").all().length;
  assert.equal(rows(), 1);
  at('2026-10-10T02:05:00Z');
  await worker.scheduled({}, env);
  assert.equal(rows(), 1, 'six days after: kept');
  at('2026-10-12T02:05:00Z');
  await worker.scheduled({}, env);
  assert.equal(rows(), 0, 'more than a week after: gone');
});
