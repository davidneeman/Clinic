// David's appointment message, sent on WhatsApp by itself once a booking is confirmed: against a
// stand-in for Meta's WhatsApp Cloud API (JSON in, { messages: [{ id }] } or { error } out).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { hashCode } from '../worker/passkeys.js';
import { inviteValues, waNumber, whatsappSettings } from '../worker/whatsapp.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const SITE = 'https://clinic.example';
const GRAPH = 'https://graph.facebook.com/v26.0';
const GROW = 'https://grow.test/api/light/server/1.0';
const CONNECTED = { WHATSAPP_TOKEN: 'test-token-123', WHATSAPP_PHONE_ID: '109876543210' };

/** Meta's side: records each message; answers as the Cloud API does (or refuses, when told to). */
function fakeServices() {
  const sent = [];
  const state = { refuse: null, down: false };
  const pages = new Map();
  let next = 734750;
  async function fetchImpl(url, init = {}) {
    const u = String(url);
    if (u.startsWith(`${GRAPH}/`)) {
      if (state.down) throw new TypeError('fetch failed');
      sent.push({ url: u, auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(init.body) });
      if (state.refuse) return Response.json({ error: { message: '(#132001) Template name does not exist in the translation', code: state.refuse } }, { status: 400 });
      return Response.json({ messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.${sent.length}` }] });
    }
    if (u.startsWith(`${GROW}/`)) {
      const method = u.slice(GROW.length + 1);
      const fields = Object.fromEntries(await new Request(u, init).formData());
      if (method === 'createPaymentProcess') {
        const processId = String(next++);
        pages.set(processId, { paid: 0 });
        return Response.json({ status: 1, err: '', data: { processId, processToken: `pt${processId}`, url: `https://grow.test/p/${processId}` } });
      }
      if (method === 'getPaymentProcessInfo') {
        const page = pages.get(fields.processId);
        const transactions = page?.paid
          ? [{ asmachta: '1', statusCode: '2', sum: String(page.paid), transactionId: `t${fields.processId}`, transactionToken: `tt${fields.processId}`, cardSuffix: '1', cardBrand: 'x', paymentsNum: '0' }]
          : [];
        return Response.json({ status: 1, err: '', data: { processId: fields.processId, processToken: fields.processToken, transactions } });
      }
      if (method === 'approveTransaction') return Response.json({ status: 1, err: '', data: {} });
    }
    return new Response('not found', { status: 404 });
  }
  return { fetchImpl, sent, state, pay: (id, sum) => (pages.get(id).paid = sum), pages };
}

function setup(vars = {}) {
  const services = fakeServices();
  const errors = [];
  const log = { info() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) };
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer', ...vars };
  const worker = createWorker({ config, clock: () => new Date('2026-10-01T05:00:00Z'), fetch: services.fetchImpl, log });
  env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
  const ready = hashCode('session-token').then((h) =>
    env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(h, '2026-12-01T00:00:00.000Z'),
  );
  const call = async (path, { method = 'GET', body, admin = false, form } = {}) => {
    await ready;
    const res = await worker.fetch(
      new Request(`${SITE}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Cookie: '__Host-admin=session-token' } : {}) },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      }),
      env,
      { waitUntil() {} },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const book = (b = {}) =>
    call('/api/bookings', {
      method: 'POST',
      body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan: 'single', ...b },
    });
  const bookingId = (ref) => env.DB.raw.prepare('SELECT id FROM bookings WHERE ref = ?').get(ref).id;
  const approve = async (ref) => call(`/api/admin/bookings/${bookingId(ref)}/approve`, { method: 'POST', body: {}, admin: true });
  return { env, worker, services, errors, call, book, approve };
}

test('the settings: both secrets, or nothing; a test server only on this machine', () => {
  assert.equal(whatsappSettings({}), null);
  assert.equal(whatsappSettings({ WHATSAPP_TOKEN: 'x' }), null);
  assert.equal(whatsappSettings({ WHATSAPP_PHONE_ID: '109876543210' }), null);
  assert.equal(whatsappSettings({ ...CONNECTED, WHATSAPP_PHONE_ID: 'not-a-number' }), null);
  assert.deepEqual(whatsappSettings(CONNECTED), { token: 'test-token-123', phoneId: '109876543210', base: GRAPH });
  assert.equal(whatsappSettings({ ...CONNECTED, WHATSAPP_API_BASE: 'http://127.0.0.1:8790/v26.0/' }).base, 'http://127.0.0.1:8790/v26.0');
  assert.equal(whatsappSettings({ ...CONNECTED, WHATSAPP_API_BASE: 'http://evil.example/v26.0' }), null);
});

test('numbers as WhatsApp takes them, and the four values in each language', () => {
  assert.equal(waNumber('050-123-4567'), '972501234567');
  assert.equal(waNumber('+972 50-123-4567'), '972501234567');
  assert.equal(waNumber('+972 050 123 4567'), '972501234567');
  assert.equal(waNumber('00972501234567'), '972501234567');
  assert.equal(waNumber('+44 7700 900123'), '447700900123');
  assert.equal(waNumber('123'), '');
  assert.equal(waNumber(''), '');
  // 4 Oct 2026 is a Sunday; 10 Oct a Saturday.
  assert.deepEqual(inviteValues({ name: 'נועה כהן', date: '2026-10-04', time: '12:30', lang: 'he' }), ['נועה', 'ראשון', '4.10', '12:30']);
  assert.deepEqual(inviteValues({ name: 'Dana Levi', date: '2026-10-10', time: '09:00', lang: 'en' }), ['Dana', 'Saturday', '10 October', '09:00']);
  assert.deepEqual(inviteValues({ name: '  יוסי\nלוי ', date: '2026-12-31', time: '18:00', lang: 'he' }), ['יוסי', 'חמישי', '31.12', '18:00']);
});

test('not connected: approving sends nothing, and the panel is told so (null)', async () => {
  const { book, approve, services } = setup();
  const { body } = await book();
  const r = await approve(body.booking.ref);
  assert.equal(r.status, 200);
  assert.equal(r.body.whatsapp, null);
  assert.equal(services.sent.length, 0);
});

test('connected: David approves, and his message goes to the client at once, in Hebrew', async () => {
  const { book, approve, services, call } = setup(CONNECTED);
  const { body } = await book();
  assert.equal(services.sent.length, 0, 'nothing while the booking waits for payment');
  const r = await approve(body.booking.ref);
  assert.equal(r.status, 200);
  assert.equal(r.body.whatsapp, 'sent');
  assert.equal(r.body.booking.status, 'confirmed');
  assert.equal(services.sent.length, 1);
  const [m] = services.sent;
  assert.equal(m.url, `${GRAPH}/109876543210/messages`);
  assert.equal(m.auth, 'Bearer test-token-123');
  assert.deepEqual(m.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '972501234567',
    type: 'template',
    template: {
      name: 'appointment_confirmed',
      language: { code: 'he' },
      components: [{ type: 'body', parameters: ['נועה', 'ראשון', '4.10', '12:30'].map((text) => ({ type: 'text', text })) }],
    },
  });
  // Approved once only: asking again changes nothing and sends nothing.
  assert.equal((await approve(body.booking.ref)).status, 409);
  assert.equal(services.sent.length, 1);
  // Cancelling sends nothing by itself either (the panel offers that message by hand).
  const id = r.body.booking.id;
  assert.equal((await call(`/api/admin/bookings/${id}/cancel`, { method: 'POST', body: {}, admin: true })).status, 200);
  assert.equal(services.sent.length, 1);
});

test('a client who booked in English gets the English one, on their own number', async () => {
  const { book, approve, services } = setup(CONNECTED);
  const { body } = await book({ name: 'Dana Levi', phone: '+44 7700 900123', lang: 'en', time: '14:00' });
  assert.equal((await approve(body.booking.ref)).body.whatsapp, 'sent');
  assert.equal(services.sent[0].body.to, '447700900123');
  assert.deepEqual(services.sent[0].body.template.language, { code: 'en' });
  assert.deepEqual(
    services.sent[0].body.template.components[0].parameters.map((p) => p.text),
    ['Dana', 'Sunday', '4 October', '14:00'],
  );
});

test('Meta refuses, or is out of reach: the booking is approved all the same, the panel hears "failed", and the log keeps nothing personal', async () => {
  const { book, approve, services, errors } = setup(CONNECTED);
  services.state.refuse = 132001; // e.g. the template isn't approved yet
  const first = await book();
  const r = await approve(first.body.booking.ref);
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, 'confirmed');
  assert.equal(r.body.whatsapp, 'failed');
  services.state.refuse = null;
  services.state.down = true;
  const second = await book({ time: '15:00' });
  assert.equal((await approve(second.body.booking.ref)).body.whatsapp, 'failed');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /refused 132001/);
  assert.match(errors[1], /network/);
  for (const e of errors) for (const secret of ['0501234567', '972501234567', 'נועה', 'test-token-123']) assert.ok(!e.includes(secret), `the log has ${secret}`);
});

test('paid through Grow: sent once, when Grow confirms; not again for its repeated notices or the scheduled checks', async () => {
  const { book, services, call, worker, env } = setup({ ...CONNECTED, BOOKING_MODE: 'pay', GROW_USER_ID: 'user-1', GROW_PAGE_CODE: 'page-1', GROW_API_BASE: GROW });
  const { body } = await book({ serviceId: 'dry-needling', plan: undefined });
  assert.equal(body.booking.ref.length > 0, true);
  const [processId] = [...services.pages.keys()];
  const notify = () => {
    const form = new FormData();
    form.append('err', '');
    form.append('status', '1');
    form.append('data[processId]', processId);
    form.append('data[processToken]', `pt${processId}`);
    return call('/api/payments/grow/notify', { method: 'POST', form });
  };
  await notify();
  assert.equal(services.sent.length, 0, 'not paid yet: nothing');
  services.pay(processId, 350);
  await notify();
  assert.equal((await call(`/api/bookings/status?ref=${body.booking.ref}`)).body.status, 'confirmed');
  assert.equal(services.sent.length, 1);
  assert.equal(services.sent[0].body.to, '972501234567');
  await notify();
  await worker.scheduled({}, env);
  assert.equal(services.sent.length, 1);
});
