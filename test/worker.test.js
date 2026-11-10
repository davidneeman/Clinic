// The Cloudflare Worker (worker/), run in Node against a stand-in for D1 built on node:sqlite
// with the real migrations (test/support/fake-d1.js). The same checks as api.test.js for the Node server, plus what's
// new on Cloudflare: WhatsApp mode, Cloudflare Access for the admin panel, the limits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
// Fixed clock: Thursday 1 Oct 2026, 08:00 Israel time.
const clock = () => new Date('2026-10-01T05:00:00Z');
const NOW_S = Math.floor(clock().getTime() / 1000);
const silent = { info() {}, error() {}, warn() {} };

// ---------- Cloudflare Access stand-in: a signing key and its public "certs" ----------

const TEAM = 'https://clinic-test.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f6';
const keys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const otherKeys = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
let certsAsked = 0;
const fakeFetch = async (url) => {
  if (String(url) !== `${TEAM}/cdn-cgi/access/certs`) return new Response('not found', { status: 404 });
  certsAsked++;
  return Response.json({ keys: [jwk] });
};

const b64url = (data) =>
  Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url');

async function token(claims = {}, { kid = 'key-1', alg = 'RS256', signWith = keys.privateKey } = {}) {
  const head = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ aud: [AUD], iss: TEAM, email: 'david@example.com', iat: NOW_S, nbf: NOW_S, exp: NOW_S + 3600, ...claims }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signWith, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---------- Helpers ----------

function setup(vars = {}) {
  const env = {
    DB: fakeD1(),
    ASSETS: { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) },
    BOOKING_MODE: 'online',
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: 'David@example.com, rotem@example.com',
    ...vars,
  };
  const worker = createWorker({ config, clock, fetch: fakeFetch, log: silent });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await worker.fetch(
      new Request(`https://clinic.example${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
    );
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, body: data, headers: res.headers };
  };
  return { env, call };
}

const booking = {
  serviceId: 'dry-needling', date: '2026-10-04', time: '12:30',
  name: 'Dana Levi', phone: '050-1234567', email: 'dana@example.com', consent: true, lang: 'he',
};

// ---------- Public API ----------

test('config: today in Israel time, the prices, and WhatsApp unless online', async () => {
  const whatsapp = await setup({ BOOKING_MODE: undefined }).call('/api/config');
  assert.equal(whatsapp.status, 200);
  assert.equal(whatsapp.body.today, '2026-10-01');
  assert.equal(whatsapp.body.handoff, 'whatsapp');
  assert.equal(whatsapp.body.prices.session.price, 350);
  assert.equal(whatsapp.body.prices.pack.sessions, 4);
  assert.equal(whatsapp.headers.get('cache-control'), 'no-store');
  assert.match(whatsapp.headers.get('content-security-policy'), /default-src 'none'/);

  const online = await setup().call('/api/config');
  assert.equal(online.body.handoff, undefined);
});

test('WhatsApp mode: no bookings or messages are taken or stored', async () => {
  const { call } = setup({ BOOKING_MODE: 'whatsapp' });
  assert.equal((await call('/api/bookings', { method: 'POST', body: booking })).status, 404);
  assert.equal((await call('/api/contact', { method: 'POST', body: { name: 'Avi', phone: '0521234567', message: 'Hi' } })).status, 404);
  const { body } = await call('/api/availability?service=dry-needling&from=2026-10-04&to=2026-10-04');
  assert.equal(body.days['2026-10-04'][0], '12:30');
});

test('availability lists slots per day and checks its input', async () => {
  const { call } = setup();
  const { body } = await call('/api/availability?service=dry-needling&from=2026-10-04&to=2026-10-05');
  assert.equal(body.days['2026-10-04'][0], '12:30');
  assert.ok(body.days['2026-10-05'].length > 0);
  assert.equal((await call('/api/availability?service=nope&from=2026-10-04&to=2026-10-05')).status, 400);
  assert.equal((await call('/api/availability?service=dry-needling&from=2026-10-05&to=2026-10-04')).status, 400);
  assert.deepEqual((await call('/api/availability?service=dry-needling&from=2027-06-01&to=2027-06-02')).body, { days: {} });
});

test('booking a slot works once, then the slot (and the break around it) is taken', async () => {
  const { call } = setup();
  const first = await call('/api/bookings', { method: 'POST', body: booking });
  assert.equal(first.status, 201);
  assert.match(first.body.booking.ref, /^[A-Z2-9]{6}$/);
  assert.equal(first.body.booking.time, '12:30');

  assert.equal((await call('/api/bookings', { method: 'POST', body: booking })).status, 409);
  assert.equal((await call('/api/bookings', { method: 'POST', body: { ...booking, time: '13:00' } })).status, 409);

  const { body } = await call('/api/availability?service=dry-needling&from=2026-10-04&to=2026-10-04');
  assert.ok(!body.days['2026-10-04'].includes('12:30'));
  assert.ok(!body.days['2026-10-04'].includes('13:30')); // 13:30 is inside the 15-min break
  assert.ok(body.days['2026-10-04'].includes('14:00'));
});

test('two people booking the same time together: only one gets it', async () => {
  const { call } = setup();
  const both = await Promise.all([
    call('/api/bookings', { method: 'POST', body: booking }),
    call('/api/bookings', { method: 'POST', body: { ...booking, name: 'Someone Else', time: '13:00' } }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);
});

test('the database itself refuses an overlapping booking that lands at the same moment', async () => {
  const { env, call } = setup();
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.includes('INSERT INTO bookings')) {
      // Someone else's 13:00 booking is written after this request checked the times, just
      // before this one is.
      env.DB.raw
        .prepare("INSERT INTO bookings (ref, service_id, date, time, duration, name, phone) VALUES ('RACE22', 'stress', '2026-10-04', '13:00', 60, 'Other', '0501111111')")
        .run();
      env.DB.prepare = prepare;
    }
    return prepare(sql);
  };
  const r = await call('/api/bookings', { method: 'POST', body: booking });
  assert.equal(r.status, 409);
  const rows = env.DB.raw.prepare('SELECT ref FROM bookings').all();
  assert.deepEqual(rows.map((x) => x.ref), ['RACE22']);
});

test('invalid bookings are rejected with field names', async () => {
  const { call } = setup();
  const { status, body } = await call('/api/bookings', {
    method: 'POST',
    body: { ...booking, time: '13:00', phone: 'abc', consent: false },
  });
  assert.equal(status, 400);
  assert.deepEqual(body.fields.sort(), ['consent', 'phone']);
  const past = await call('/api/bookings', { method: 'POST', body: { ...booking, date: '2026-09-27' } });
  assert.equal(past.status, 409);
});

test('contact form stores a message; the honeypot is ignored', async () => {
  const { call } = setup();
  assert.equal((await call('/api/contact', { method: 'POST', body: { name: 'Avi', phone: '0521234567', message: 'Hello!' } })).status, 201);
  assert.equal((await call('/api/contact', { method: 'POST', body: { name: 'Bot', phone: '0521234567', message: 'Spam', website: 'x' } })).status, 201);
  assert.equal((await call('/api/contact', { method: 'POST', body: { name: 'Avi', message: 'Hello!' } })).status, 400);
  const auth = { 'Cf-Access-Jwt-Assertion': await token() };
  const { body } = await call('/api/admin/messages', { headers: auth });
  assert.deepEqual(body.messages.map((m) => m.name), ['Avi']);
});

test('changes must come from the site itself, as JSON, and not too large', async () => {
  const { call } = setup();
  const form = await call('/api/bookings', { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const elsewhere = await call('/api/bookings', { method: 'POST', body: booking, headers: { Origin: 'https://evil.example' } });
  assert.equal(elsewhere.status, 403);
  const same = await call('/api/bookings', { method: 'POST', body: booking, headers: { Origin: 'https://clinic.example' } });
  assert.equal(same.status, 201);
  const huge = await call('/api/contact', { method: 'POST', body: { name: 'Avi', phone: '0521234567', message: 'x'.repeat(30_000) } });
  assert.equal(huge.status, 413);
  assert.equal((await call('/api/contact', { method: 'POST', body: '{nope' })).status, 400);
});

test('limits answer 429 once a visitor goes over them', async () => {
  const deny = { limit: async () => ({ success: false }) };
  const allow = { limit: async () => ({ success: true }) };
  const forms = setup({ FORMS_LIMIT: deny, API_LIMIT: allow });
  assert.equal((await forms.call('/api/bookings', { method: 'POST', body: booking })).status, 429);
  assert.equal((await forms.call('/api/config')).status, 200);
  const api = setup({ API_LIMIT: deny });
  const r = await api.call('/api/config');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  const broken = setup({ API_LIMIT: { limit: async () => { throw new Error('down'); } } });
  assert.equal((await broken.call('/api/config')).status, 200);
});

// ---------- Admin (Cloudflare Access) ----------

test('admin: closed until Access is set up, and to anyone without a valid token', async () => {
  const off = setup({ ACCESS_AUD: '' });
  assert.deepEqual((await off.call('/api/admin/session')).body, { enabled: true, loggedIn: false, passkeys: true, access: false, editor: true, media: false, google: false, clientGoogle: false });
  assert.equal((await off.call('/api/admin/bookings', { headers: { 'Cf-Access-Jwt-Assertion': await token() } })).status, 401);
  const plainHttp = setup({ ACCESS_TEAM_DOMAIN: 'http://clinic-test.cloudflareaccess.com' });
  assert.equal((await plainHttp.call('/api/admin/session')).body.access, false);

  const { call } = setup();
  const rejected = [
    '',
    'not-a-token',
    await token({ aud: ['another-app'] }),
    await token({ iss: 'https://someone-else.cloudflareaccess.com' }),
    await token({ exp: NOW_S - 120 }),
    await token({ nbf: NOW_S + 600 }),
    await token({ email: 'stranger@example.com' }),
    await token({}, { signWith: otherKeys.privateKey }),
    await token({}, { kid: 'unknown-key' }),
    await token({}, { alg: 'none' }),
  ];
  for (const t of rejected) {
    const r = await call('/api/admin/bookings', { headers: { 'Cf-Access-Jwt-Assertion': t } });
    assert.equal(r.status, 401, `token accepted: ${t.slice(0, 40)}`);
  }
  // A token with its claims edited after signing.
  const good = await token();
  const [h, , s] = good.split('.');
  const forged = `${h}.${b64url(JSON.stringify({ aud: [AUD], iss: TEAM, email: 'stranger@example.com', exp: NOW_S + 3600 }))}.${s}`;
  assert.equal((await call('/api/admin/bookings', { headers: { 'Cf-Access-Jwt-Assertion': forged } })).status, 401);
  assert.deepEqual((await call('/api/admin/session')).body, { enabled: true, loggedIn: false, passkeys: true, access: true, editor: true, media: false, google: false, clientGoogle: false });
});

test('admin: with a valid Access token (header or cookie) everything works', async () => {
  const { env, call } = setup();
  const auth = { 'Cf-Access-Jwt-Assertion': await token() };
  const asked = certsAsked;
  assert.deepEqual((await call('/api/admin/session', { headers: auth })).body, { enabled: true, loggedIn: true, passkeys: true, name: 'david@example.com', access: true, editor: true, media: false, google: false, clientGoogle: false });
  const viaCookie = await call('/api/admin/session', { headers: { Cookie: `theme=dark; CF_Authorization=${await token({ email: 'rotem@example.com' })}` } });
  assert.equal(viaCookie.body.loggedIn, true);
  assert.ok(certsAsked - asked <= 1, 'the signing keys are fetched once, then kept');

  assert.equal((await call('/api/bookings', { method: 'POST', body: booking })).status, 201);
  const { body } = await call('/api/admin/bookings?scope=upcoming', { headers: auth });
  assert.equal(body.bookings.length, 1);
  assert.equal(body.bookings[0].name, 'Dana Levi');

  // Close a day: no free times that day.
  const blocked = await call('/api/admin/blocked', { method: 'POST', body: { date: '2026-10-05', note: 'Holiday' }, headers: auth });
  assert.equal(blocked.status, 201);
  assert.deepEqual(blocked.body.blocked, [{ date: '2026-10-05', note: 'Holiday', notice_id: null }]);
  const av = await call('/api/availability?service=dry-needling&from=2026-10-05&to=2026-10-05');
  assert.deepEqual(av.body.days['2026-10-05'], []);
  assert.equal((await call('/api/admin/blocked/2026-10-05', { method: 'DELETE', body: {}, headers: auth })).status, 200);
  assert.equal((await call('/api/admin/blocked/2026-10-05', { method: 'DELETE', body: {}, headers: auth })).status, 404);

  // Cancelling frees the time again.
  const cancel = await call(`/api/admin/bookings/${body.bookings[0].id}/cancel`, { method: 'POST', body: {}, headers: auth });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.booking.status, 'cancelled');
  assert.equal((await call(`/api/admin/bookings/${body.bookings[0].id}/cancel`, { method: 'POST', body: {}, headers: auth })).status, 404);
  assert.equal((await call('/api/bookings', { method: 'POST', body: booking })).status, 201);
  assert.equal((await call('/api/admin/bookings?scope=cancelled', { headers: auth })).body.bookings.length, 1);
  env.DB.raw
    .prepare("INSERT INTO bookings (ref, service_id, date, time, duration, name, phone) VALUES ('PAST22', 'stress', '2026-09-20', '13:00', 60, 'Earlier', '0501111111')")
    .run();
  assert.deepEqual((await call('/api/admin/bookings?scope=past', { headers: auth })).body.bookings.map((x) => x.ref), ['PAST22']);
  assert.equal((await call('/api/admin/bookings?scope=upcoming', { headers: auth })).body.bookings.length, 1);

  // Opening hours.
  const badSchedule = await call('/api/admin/schedule', {
    method: 'PUT',
    headers: auth,
    body: { weeklyHours: { 0: [['12:00', '09:00']] }, slotInterval: 30, bufferMinutes: 0, minNoticeHours: 0, maxDaysAhead: 30 },
  });
  assert.equal(badSchedule.status, 400);
  const schedule = { weeklyHours: { 0: [['09:00', '11:00']] }, slotInterval: 60, bufferMinutes: 0, minNoticeHours: 0, maxDaysAhead: 30 };
  assert.equal((await call('/api/admin/schedule', { method: 'PUT', headers: auth, body: schedule })).status, 200);
  const sunday = await call('/api/availability?service=stress&from=2026-10-11&to=2026-10-11');
  assert.deepEqual(sunday.body.days['2026-10-11'], ['09:00', '10:00']);
  assert.equal((await call('/api/admin/schedule', { headers: auth })).body.schedule.slotInterval, 60);

  // Messages.
  await call('/api/contact', { method: 'POST', body: { name: 'Avi', email: 'avi@example.com', message: 'Hello!' } });
  const [msg] = (await call('/api/admin/messages', { headers: auth })).body.messages;
  assert.equal(msg.is_read, 0);
  assert.equal((await call(`/api/admin/messages/${msg.id}/read`, { method: 'POST', body: {}, headers: auth })).status, 200);
  assert.equal((await call(`/api/admin/messages/${msg.id}`, { method: 'DELETE', body: {}, headers: auth })).status, 200);
  assert.equal((await call(`/api/admin/messages/${msg.id}`, { method: 'DELETE', body: {}, headers: auth })).status, 404);

  // Changes need JSON here too, and logging out ends the Access session.
  assert.equal((await call('/api/admin/blocked', { method: 'POST', body: 'date=2026-10-06', headers: { ...auth, 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual((await call('/api/admin/logout', { method: 'POST', body: {}, headers: auth })).body, { ok: true, redirect: '/cdn-cgi/access/logout' });
  assert.deepEqual((await call('/api/admin/logout', { method: 'POST', body: {} })).body, { ok: true });
});

test('pages go to the static files; unknown API paths are 404', async () => {
  const { call } = setup();
  assert.equal((await call('/book')).body, 'asset /book');
  assert.deepEqual((await call('/healthz')).body, { ok: true });
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'x' } })).status, 401);
});
