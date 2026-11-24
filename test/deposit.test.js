// A deposit for a first treatment (BOOKING_MODE "transfer"): the client transfers only the deposit
// (100 ₪ as the site comes) and pays the rest at the session; David approves it like the others.
// He sees when the number is already in his client list; the booking page never tells anyone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };

function setup() {
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer' };
  const worker = createWorker({ config, clock: () => new Date('2026-10-01T05:00:00Z'), log: silent });
  env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
  const ready = hashCode('session-token').then((h) =>
    env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(h, '2026-12-01T00:00:00.000Z'),
  );
  const call = async (path, { method = 'GET', body, admin = false } = {}) => {
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
  const book = (o = {}) =>
    call('/api/bookings', {
      method: 'POST',
      body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan: 'deposit', ...o },
    });
  const list = async () => (await call('/api/admin/bookings?scope=upcoming', { admin: true })).body.bookings;
  const byRef = async (ref) => (await list()).find((b) => b.ref === ref);
  const approve = async (ref) => call(`/api/admin/bookings/${(await byRef(ref)).id}/approve`, { method: 'POST', body: {}, admin: true });
  const savePrices = (prices) => call('/api/admin/content', { method: 'PUT', body: { prices }, admin: true });
  return { env, call, book, list, byRef, approve, savePrices };
}

test('the site comes with a 100 ₪ deposit, given to the booking page with the other prices', async () => {
  assert.equal(config.prices.deposit.price, 100);
  const { call } = setup();
  assert.deepEqual((await call('/api/config')).body.prices.deposit, { price: 100 });
  assert.equal((await call('/api/admin/content', { admin: true })).body.defaults.prices.deposit, 100);
});

test('a first treatment: only the deposit now, held until David approves, and nothing on any card', async () => {
  const { book, byRef, approve, call } = setup();
  const r = await book();
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.plan, 'deposit');
  assert.equal(r.body.booking.price, 100, 'the amount to transfer now');
  assert.equal(r.body.transfer.phone, '058-434-4047');
  const row = await byRef(r.body.booking.ref);
  assert.equal(row.status, 'pending');
  assert.equal(row.plan, 'deposit');
  assert.equal(row.known_client, false, 'a new number');
  const approved = await approve(r.body.booking.ref);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.booking.status, 'confirmed');
  assert.equal(approved.body.cardLeft, null, 'nothing on a card');
  const clients = (await call('/api/admin/clients', { admin: true })).body.clients;
  assert.equal(clients.length, 1);
  assert.equal(clients[0].card_left, 0);
  // Cancelled later: nothing goes back on any card either.
  const cancelled = await call(`/api/admin/bookings/${approved.body.booking.id}/cancel`, { method: 'POST', body: {}, admin: true });
  assert.equal(cancelled.body.cardLeft, null);
});

test('a number already in his list: David sees it before approving; the booking page answers the same either way', async () => {
  const { book, byRef, approve } = setup();
  const first = await book({ plan: 'single', time: '12:30' });
  await approve(first.body.booking.ref); // now in his list
  const again = await book({ time: '14:00', name: 'נועה' });
  const stranger = await book({ time: '15:30', name: 'אבי לוי', phone: '052-765-4321' });
  assert.equal(again.status, 201);
  // What the visitor gets back: the same shape, nothing about who is known.
  assert.deepEqual(Object.keys(again.body).sort(), Object.keys(stranger.body).sort());
  assert.deepEqual(Object.keys(again.body.booking).sort(), Object.keys(stranger.body.booking).sort());
  assert.ok(!JSON.stringify(again.body).includes('known'));
  assert.equal((await byRef(again.body.booking.ref)).known_client, true);
  assert.equal((await byRef(stranger.body.booking.ref)).known_client, false);
  // Once approved, the flag goes (he decided).
  await approve(again.body.booking.ref);
  assert.equal((await byRef(again.body.booking.ref)).known_client, undefined);
});

test('his deposit: set with the prices; 0 turns the choice off; never more than a session', async () => {
  const { book, savePrices, call } = setup();
  const prices = { session: 350, packSessions: 4, pack: 1200 };
  assert.equal((await savePrices({ ...prices, deposit: 150 })).status, 200);
  assert.deepEqual((await call('/api/config')).body.prices.deposit, { price: 150 });
  assert.equal((await book()).body.booking.price, 150);
  // Off: the choice is refused.
  assert.equal((await savePrices({ ...prices, deposit: 0 })).status, 200);
  const off = await book({ time: '14:00' });
  assert.equal(off.status, 400);
  assert.deepEqual(off.body.fields, ['plan']);
  // A deposit can't be more than the session, nor a non-number.
  assert.deepEqual((await savePrices({ ...prices, deposit: 400 })).body.fields, ['prices.deposit']);
  assert.deepEqual((await savePrices({ ...prices, deposit: 'מאה' })).body.fields, ['prices.deposit']);
  assert.deepEqual((await savePrices({ ...prices, deposit: -5 })).body.fields, ['prices.deposit']);
  // As much as the session: no point in a deposit, so it isn't offered.
  assert.equal((await savePrices({ ...prices, deposit: 350 })).status, 200);
  assert.equal((await book({ time: '15:30' })).status, 400);
  // Prices saved without one (before there was a deposit): the site's own 100.
  assert.equal((await savePrices(prices)).status, 200);
  assert.deepEqual((await call('/api/config')).body.prices.deposit, { price: 100 });
  assert.equal((await book({ time: '17:00' })).body.booking.price, 100);
  // And back to the original prices.
  assert.equal((await savePrices(null)).status, 200);
  assert.deepEqual((await call('/api/config')).body.prices.deposit, { price: 100 });
});
