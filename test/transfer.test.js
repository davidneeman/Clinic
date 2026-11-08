// Paying by Bit or PayBox to the practitioner's phone (BOOKING_MODE "transfer"): the client
// picks one session, the 4-session card or a session from a card they have; the time is held
// until David approves the booking in the admin panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };

function setup() {
  let now = new Date('2026-10-01T05:00:00Z'); // Thursday 1 Oct 2026, 08:00 in Israel
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer' };
  const worker = createWorker({ config, clock: () => now, log: silent });
  const waits = [];
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await worker.fetch(
      new Request(`https://clinic.example${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      { waitUntil: (p) => waits.push(p) },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // David, signed in (a session as the passkey sign-in makes it).
  const signIn = async () => {
    env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
    env.DB.raw
      .prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)')
      .run(await hashCode('session-token'), '2026-12-01T00:00:00.000Z');
    return '__Host-admin=session-token';
  };
  const advance = (hours) => {
    now = new Date(now.getTime() + hours * 3_600_000);
  };
  return { env, call, signIn, advance, settle: () => Promise.all(waits) };
}

const book = (call, plan, extra = {}) =>
  call('/api/bookings', {
    method: 'POST',
    body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan, ...extra },
  });
const slotsOn = async (call, date) =>
  (await call(`/api/availability?service=stress&from=${date}&to=${date}`)).body.days[date];

test('transfer mode: the config tells the booking page where to pay; messages still go to WhatsApp', async () => {
  const { call } = setup();
  const { body } = await call('/api/config');
  assert.deepEqual(body.transfer, { phone: '058-434-4047' });
  assert.equal(body.handoff, 'whatsapp');
  assert.equal(body.payments, undefined);
  assert.equal(body.services.find((s) => s.id === 'stress').name.he, 'דיקור סטרס');
  assert.equal((await call('/api/contact', { method: 'POST', body: { name: 'Avi', phone: '0521234567', message: 'Hi' } })).status, 404);
});

test('a booking needs a plan, and each plan has its price', async () => {
  const { call } = setup();
  const none = await book(call, undefined);
  assert.equal(none.status, 400);
  assert.ok(none.body.fields.includes('plan'));
  assert.equal((await book(call, 'everything')).status, 400);

  const single = await book(call, 'single');
  assert.equal(single.status, 201);
  assert.equal(single.body.booking.price, 350);
  assert.equal(single.body.booking.plan, 'single');
  assert.deepEqual(single.body.transfer, { phone: '058-434-4047' });
  assert.match(single.body.booking.ref, /^[A-Z2-9]{6}$/);

  const pack = await book(call, 'pack', { time: '14:00' });
  assert.equal(pack.body.booking.price, 1200);
  const card = await book(call, 'card', { time: '15:30' });
  assert.equal(card.body.booking.price, 0);
});

test('the time stays held while waiting for David, even days later, until he approves or cancels', async () => {
  const { call, signIn, advance } = setup();
  const { body } = await book(call, 'single');
  assert.ok(!(await slotsOn(call, '2026-10-04')).includes('12:30'), 'held right away');
  assert.equal((await book(call, 'single')).status, 409, 'nobody else can take it');
  assert.equal((await call(`/api/bookings/status?ref=${body.booking.ref}`)).body.status, 'pending');

  advance(48); // two days later, still not approved
  assert.ok(!(await slotsOn(call, '2026-10-04')).includes('12:30'), 'still held two days later');

  const me = await signIn();
  const list = (await call('/api/admin/bookings?scope=upcoming', { cookie: me })).body.bookings;
  assert.deepEqual(list.map((b) => [b.ref, b.status, b.plan, b.price]), [[body.booking.ref, 'pending', 'single', 350]]);

  const cancelled = await call(`/api/admin/bookings/${list[0].id}/cancel`, { method: 'POST', body: {}, cookie: me });
  assert.equal(cancelled.status, 200);
  assert.ok((await slotsOn(call, '2026-10-04')).includes('12:30'), 'free again once cancelled');
  assert.equal((await call(`/api/bookings/status?ref=${body.booking.ref}`)).body.status, 'cancelled');
});

test('David approves: the booking is confirmed, the client is in his list, and the card counts sessions', async () => {
  const { call, signIn, settle } = setup();
  const me = await signIn();
  const approve = async (ref) => {
    const b = (await call('/api/admin/bookings?scope=upcoming', { cookie: me })).body.bookings.find((x) => x.ref === ref);
    return call(`/api/admin/bookings/${b.id}/approve`, { method: 'POST', body: {}, cookie: me });
  };
  const client = async () => (await call('/api/admin/clients', { cookie: me })).body.clients[0];

  // One session.
  const single = (await book(call, 'single')).body.booking;
  const ok = await approve(single.ref);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.booking.status, 'confirmed');
  assert.equal((await call(`/api/bookings/status?ref=${single.ref}`)).body.status, 'confirmed');
  assert.deepEqual([(await client()).name, (await client()).card_left], ['נועה כהן', 0]);

  // A new card: this session and three more.
  const pack = (await book(call, 'pack', { time: '14:00' })).body.booking;
  const packed = await approve(pack.ref);
  assert.equal(packed.body.cardLeft, 3);
  assert.equal((await client()).card_left, 3);

  // A session from the card: the list shows what's left before approving, then one less.
  const fromCard = (await book(call, 'card', { time: '15:30', phone: '+972 50 123 4567' })).body.booking;
  const waiting = (await call('/api/admin/bookings?scope=upcoming', { cookie: me })).body.bookings.find((b) => b.ref === fromCard.ref);
  assert.equal(waiting.card_left, 3);
  assert.equal((await approve(fromCard.ref)).body.cardLeft, 2);
  assert.equal((await client()).card_left, 2);

  // Approving twice changes nothing.
  assert.equal((await approve(fromCard.ref)).status, 409);
  assert.equal((await client()).card_left, 2);
  await settle();
  const clients = (await call('/api/admin/clients', { cookie: me })).body.clients;
  assert.equal(clients.length, 1, 'one client, found by phone number each time');
});

test('approving needs David signed in, and only for bookings paid by hand', async () => {
  const { call, signIn, env } = setup();
  const single = (await book(call, 'single')).body.booking;
  const id = env.DB.raw.prepare('SELECT id FROM bookings WHERE ref = ?').get(single.ref).id;
  assert.equal((await call(`/api/admin/bookings/${id}/approve`, { method: 'POST', body: {} })).status, 401);
  const me = await signIn();
  // A booking made another way (no plan) isn't approved here.
  env.DB.raw.prepare('UPDATE bookings SET plan = NULL WHERE id = ?').run(id);
  assert.equal((await call(`/api/admin/bookings/${id}/approve`, { method: 'POST', body: {}, cookie: me })).status, 409);
  assert.equal((await call('/api/admin/bookings/999/approve', { method: 'POST', body: {}, cookie: me })).status, 404);
});

test('a booking never approved stops holding once its time has passed', async () => {
  const { call, advance, env } = setup();
  const { body } = await book(call, 'single');
  advance(4 * 24); // past Sunday 4 Oct, 12:30
  const worker = createWorker({ config, clock: () => new Date('2026-10-05T05:00:00Z'), log: silent });
  await worker.scheduled({}, env);
  assert.equal(env.DB.raw.prepare('SELECT status FROM bookings WHERE ref = ?').get(body.booking.ref).status, 'expired');
});
