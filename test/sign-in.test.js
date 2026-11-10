// Signing in on the site: clients with Google or with a code sent by SMS (their card and
// bookings, and a session from the card confirmed at once), and managers with Google too.
// Google and Twilio are played by stand-ins here (the Worker's fetch), with a real RSA key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { b64url, hashCode } from '../worker/passkeys.js';
import { emailKey } from '../worker/google.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error: (...a) => process.env.DEBUG_SIGNIN && console.error(...a), warn() {} };
const ORIGIN = 'https://clinic.example';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const SERVICE = `VA${'a'.repeat(32)}`;
const json64 = (o) => b64url.encode(new TextEncoder().encode(JSON.stringify(o)));
const sha = (text) => createHash('sha256').update(text).digest('base64url');

/** Google, as far as the Worker sees it: its token address and its signing keys. */
async function fakeGoogle(clock) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const kid = `k${Math.random().toString(36).slice(2)}`;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map(); // one-time code → what the person picked on Google's page
  const sign = async (claims, { header = { alg: 'RS256', kid, typ: 'JWT' }, key = keys.privateKey } = {}) => {
    const body = `${json64(header)}.${json64(claims)}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
    return `${body}.${b64url.encode(sig)}`;
  };
  return {
    jwk,
    sign,
    /** The person picks a Google account on Google's page, which sends them back with a code. */
    pick(authUrl, person, { tamper = (c) => c, raw = null } = {}) {
      const q = new URL(authUrl).searchParams;
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { q, person, tamper, raw });
      return `/api/auth/google/callback?code=${code}&state=${q.get('state')}`;
    },
    async token(body) {
      const form = new URLSearchParams(body);
      const entry = codes.get(form.get('code'));
      codes.delete(form.get('code')); // each code works once
      if (!entry) return { status: 400, data: { error: 'invalid_grant' } };
      const { q, person, tamper, raw } = entry;
      // Google checks the code goes with this site, its secret, its way back and its PKCE secret.
      const right =
        form.get('client_id') === CLIENT_ID &&
        form.get('client_secret') === 'google-secret' &&
        form.get('redirect_uri') === q.get('redirect_uri') &&
        form.get('grant_type') === 'authorization_code' &&
        sha(form.get('code_verifier') || '') === q.get('code_challenge');
      if (!right) return { status: 400, data: { error: 'invalid_grant' } };
      const t = Math.floor(clock().getTime() / 1000);
      const claims = tamper({
        iss: 'https://accounts.google.com',
        azp: CLIENT_ID,
        aud: CLIENT_ID,
        sub: person.sub,
        email: person.email,
        email_verified: true,
        name: person.name,
        nonce: q.get('nonce'),
        iat: t,
        exp: t + 3600,
      });
      return { status: 200, data: { id_token: raw ?? (await sign(claims)), access_token: 'unused', token_type: 'Bearer' } };
    },
  };
}

/** Twilio Verify: a code per number, good for one right answer. */
function fakeTwilio() {
  const sent = [];
  const pending = new Map();
  return {
    sent,
    codeFor: (to) => pending.get(to),
    handle(path, form) {
      const to = form.get('To');
      if (path.endsWith('/Verifications')) {
        if (!/^\+9725\d{8}$/.test(to)) return { status: 400, data: { code: 60200, message: 'Invalid parameter `To`' } };
        const code = String(100000 + sent.length);
        pending.set(to, code);
        sent.push({ to, channel: form.get('Channel'), locale: form.get('Locale') });
        return { status: 201, data: { status: 'pending', to } };
      }
      if (path.endsWith('/VerificationCheck')) {
        if (!pending.has(to)) return { status: 404, data: { code: 20404, message: 'not found' } };
        if (pending.get(to) !== form.get('Code')) return { status: 200, data: { status: 'pending', valid: false } };
        pending.delete(to);
        return { status: 200, data: { status: 'approved', valid: true } };
      }
      return { status: 404, data: {} };
    },
  };
}

async function setup({ secrets = true, tables = true, limit = Infinity } = {}) {
  let now = new Date('2026-10-01T05:00:00Z'); // Thursday 1 Oct 2026, 08:00 in Israel
  const google = await fakeGoogle(() => now);
  const twilio = fakeTwilio();
  const calls = [];
  const counts = new Map();
  const env = {
    DB: fakeD1(),
    BOOKING_MODE: 'transfer',
    // A limiter that lets `limit` requests through per key.
    FORMS_LIMIT: { limit: async ({ key }) => ({ success: (counts.set(key, (counts.get(key) || 0) + 1), counts.get(key) <= limit) }) },
    ...(secrets
      ? {
          GOOGLE_CLIENT_ID: CLIENT_ID,
          GOOGLE_CLIENT_SECRET: 'google-secret',
          TWILIO_ACCOUNT_SID: `AC${'b'.repeat(32)}`,
          TWILIO_AUTH_TOKEN: 'twilio-token',
          TWILIO_VERIFY_SERVICE: SERVICE,
        }
      : {}),
  };
  if (!tables) for (const t of ['account_sessions', 'accounts', 'client_google', 'admin_google']) env.DB.raw.exec(`DROP TABLE ${t}`);
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    const reply = ({ status, data }) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') return reply(await google.token(String(init.body)));
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return reply({ status: 200, data: { keys: [google.jwk] } });
    if (url.startsWith(`https://verify.twilio.com/v2/Services/${SERVICE}/`)) {
      assert.equal(init.headers.Authorization, `Basic ${btoa(`AC${'b'.repeat(32)}:twilio-token`)}`);
      return reply(twilio.handle(new URL(url).pathname, new URLSearchParams(String(init.body))));
    }
    return reply({ status: 404, data: {} });
  };
  const worker = createWorker({ config, clock: () => now, fetch: fetchImpl, log: silent });
  const waits = [];

  /** A browser: keeps the cookies the site sets, as a browser would. */
  const browser = () => {
    const jar = new Map();
    const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
        }),
        env,
        { waitUntil: (p) => waits.push(p) },
      );
      const setCookies = res.headers.getSetCookie();
      for (const c of setCookies) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        const [name, value] = [pair.slice(0, i), pair.slice(i + 1)];
        if (/Max-Age=0/.test(c) || !value) jar.delete(name);
        else jar.set(name, value);
      }
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { status: res.status, body: data, location: res.headers.get('Location'), setCookies, headers: res.headers };
    };
    return { call, jar };
  };

  /** Signs in with Google in this browser, as `person`. → where Google's page sent it back. */
  const viaGoogle = async (b, person, purpose = 'client', options) => {
    const start = await b.call('/api/auth/google/start', { method: 'POST', body: { for: purpose, lang: 'he' } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return b.call(google.pick(start.body.url, person, options));
  };
  const viaPhone = async (b, phone) => {
    assert.equal((await b.call('/api/account/phone/start', { method: 'POST', body: { phone, lang: 'he' } })).status, 200);
    const to = `+972${phone.replace(/\D/g, '').slice(1)}`;
    return b.call('/api/account/phone/check', { method: 'POST', body: { phone, code: twilio.codeFor(to) } });
  };
  // David in the admin panel; `fresh`: he signed in just now.
  const admin = async ({ fresh = true, name = 'דוד' } = {}) => {
    const id = Number(env.DB.raw.prepare('INSERT INTO admins (name, handle) VALUES (?, ?) RETURNING id').get(name, `h-${name}`).id);
    const token = `session-${id}`;
    const expires = new Date(now.getTime() + (fresh ? 12 : 2) * 3_600_000).toISOString();
    env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(await hashCode(token), id, expires);
    const b = browser();
    b.jar.set('__Host-admin', token);
    return { id, b };
  };
  const addClient = (name, phone, cardLeft) =>
    Number(env.DB.raw.prepare('INSERT INTO clients (name, phone, card_left) VALUES (?, ?, ?) RETURNING id').get(name, phone, cardLeft).id);
  const cardOf = (id) => env.DB.raw.prepare('SELECT card_left FROM clients WHERE id = ?').get(id)?.card_left;
  const book = (b, extra = {}) =>
    b.call('/api/bookings', {
      method: 'POST',
      body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan: 'card', ...extra },
    });
  const advance = (hours) => {
    now = new Date(now.getTime() + hours * 3_600_000);
  };
  const seconds = () => Math.floor(now.getTime() / 1000);
  return { env, google, twilio, calls, browser, viaGoogle, viaPhone, admin, addClient, cardOf, book, advance, seconds, settle: () => Promise.all(waits) };
}

const noa = { sub: '1001', email: 'Noa.Cohen@gmail.com', name: 'Noa Cohen' };

test('before migrations/0006 or the secrets: no signing in, and everything else works as before', async () => {
  for (const options of [{ tables: false }, { secrets: false }]) {
    const t = await setup(options);
    const b = t.browser();
    assert.deepEqual((await b.call('/api/account')).body, { google: false, sms: false, signedIn: false });
    assert.equal((await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } })).status, 404);
    assert.equal((await b.call('/api/account/phone/start', { method: 'POST', body: { phone: '0501234567' } })).status, 404);
    // A forged cookie changes nothing.
    b.jar.set('__Host-client', 'made-up');
    assert.equal((await b.call('/api/account')).body.signedIn, false);
    // Booking from a card waits for David, as before.
    const booked = await t.book(b);
    assert.equal(booked.status, 201);
    assert.equal(booked.body.transfer.phone, '058-434-4047');

    const { id, b: david } = await t.admin();
    const session = (await david.call('/api/admin/session')).body;
    assert.equal(session.google, false);
    assert.equal(session.clientGoogle, false);
    const client = t.addClient('נועה כהן', '0501234567', 2);
    const card = await david.call(`/api/admin/clients/${client}`);
    assert.equal(card.status, 200);
    assert.equal(card.body.client.google, options.tables === false ? undefined : ''); // (nothing to connect yet)
    assert.equal((await david.call(`/api/admin/clients/${client}`, { method: 'PUT', body: { name: 'נועה', phone: '0501234567', cardLeft: 2, google: 'noa@gmail.com' } })).status, 200);
    assert.deepEqual((await david.call('/api/admin/admins')).body.admins.map((a) => a.google), [null]);
    assert.equal((await david.call(`/api/admin/clients/${client}`, { method: 'DELETE', body: {} })).status, 200);
    const other = await t.admin({ name: 'רותם' });
    assert.equal((await david.call(`/api/admin/admins/${other.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.ok(id);
  }
  const t = await setup({ tables: false });
  await createWorker({ config, log: silent }).scheduled({}, t.env); // the scheduled clean-up too
});

test('Google: the sign-in page asks for this site, with PKCE, a state and a nonce; the session cookie', async () => {
  const t = await setup();
  const b = t.browser();
  assert.deepEqual((await b.call('/api/account')).body, { google: true, sms: true, signedIn: false });
  const start = await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'client', lang: 'he' } });
  const to = new URL(start.body.url);
  assert.equal(to.origin + to.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = to.searchParams;
  assert.equal(q.get('client_id'), CLIENT_ID);
  assert.equal(q.get('redirect_uri'), `${ORIGIN}/api/auth/google/callback`);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email profile');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.match(q.get('code_challenge'), /^[\w-]{43}$/);
  assert.match(q.get('state'), /^c[\w-]{22}$/);
  assert.match(q.get('nonce'), /^[\w-]{43}$/);
  assert.equal(q.get('hl'), 'he');
  // The browser is tied to this sign-in by a short cookie Google's way back can carry.
  assert.match(start.setCookies[0], /^__Host-oauth=[\w-]{22}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  // Nothing secret goes to Google: not the sign-in's secret, not the cookie.
  assert.ok(!to.href.includes(b.jar.get('__Host-oauth')));

  const back = await b.call(t.google.pick(start.body.url, noa));
  assert.equal(back.status, 303);
  assert.equal(back.location, `${ORIGIN}/book#signin=ok`);
  assert.equal(back.headers.get('Referrer-Policy'), 'no-referrer');
  assert.ok(back.setCookies.some((c) => /^__Host-oauth=; .*Max-Age=0/.test(c)));
  const session = back.setCookies.find((c) => c.startsWith('__Host-client='));
  assert.match(session, /^__Host-client=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=7776000$/);
  // Only a hash of the cookie is kept.
  const stored = t.env.DB.raw.prepare('SELECT id_hash FROM account_sessions').all();
  assert.deepEqual(stored.map((r) => r.id_hash), [await hashCode(b.jar.get('__Host-client'))]);

  const me = (await b.call('/api/account')).body;
  assert.equal(me.signedIn, true);
  assert.equal(me.via, 'google');
  assert.equal(me.name, 'Noa Cohen');
  assert.equal(me.email, 'noa.cohen@gmail.com');
  assert.equal(me.client, null); // no card until it's connected
  assert.equal(me.phoneProven, false);
  assert.deepEqual(me.bookings, []);

  // Signing out ends it here and on the server.
  const out = await b.call('/api/account/logout', { method: 'POST', body: {} });
  assert.match(out.setCookies[0], /^__Host-client=; .*Max-Age=0/);
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 0);
  assert.equal((await b.call('/api/account')).body.signedIn, false);
});

test('Google: an answer that is not for this very sign-in, or not right, signs no one in', async () => {
  const t = await setup();
  const signedIn = (r) => r.setCookies.some((c) => c.startsWith('__Host-client=') && !/Max-Age=0/.test(c));
  const expect = async (r, status) => {
    assert.equal(r.location, `${ORIGIN}/book#signin=${status}`);
    assert.ok(!signedIn(r), status);
  };

  // Google's way back opened in another browser (or sent by someone else): no cookie of its own.
  const a = t.browser();
  const start = await a.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
  const link = t.google.pick(start.body.url, noa);
  await expect(await t.browser().call(link), 'expired');
  // …and that used it up: the right browser can't use it after.
  await expect(await a.call(link), 'expired');

  // The same way back twice: only the first counts.
  const b = t.browser();
  const s2 = await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
  const once = t.google.pick(s2.body.url, noa);
  const cookie = b.jar.get('__Host-oauth');
  assert.equal((await b.call(once)).location, `${ORIGIN}/book#signin=ok`);
  b.jar.set('__Host-oauth', cookie);
  await expect(await b.call(once), 'expired');

  // A made-up state, or none.
  await expect(await t.browser().call('/api/auth/google/callback?code=x&state=cAAAAAAAAAAAAAAAAAAAAAA'), 'expired');
  assert.equal((await t.browser().call('/api/auth/google/callback?code=x')).location, `${ORIGIN}/book#signin=failed`);

  // Cancelled on Google's page.
  const c = t.browser();
  const s3 = await c.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
  await expect(await c.call(`/api/auth/google/callback?error=access_denied&state=${new URL(s3.body.url).searchParams.get('state')}`), 'cancelled');

  // Google's statement, changed in any way: for another site, another sign-in, out of date,
  // an address Google didn't check, a key that isn't Google's, another issuer.
  const t0 = t.seconds();
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const cases = [
    [{ tamper: (c0) => ({ ...c0, aud: 'someone-else.apps.googleusercontent.com' }) }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, azp: 'someone-else' }) }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, nonce: 'another-sign-in' }) }, 'failed'],
    [{ tamper: ({ nonce, ...c0 }) => c0 }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, exp: t0 - 3600, iat: t0 - 7200 }) }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, iat: t0 + 3600 }) }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, iss: 'https://evil.example' }) }, 'failed'],
    [{ tamper: (c0) => ({ ...c0, email_verified: false }) }, 'unverified'],
    [{ tamper: ({ email, ...c0 }) => c0 }, 'unverified'],
    [{ tamper: ({ sub, ...c0 }) => c0 }, 'failed'],
  ];
  for (const [options, status] of cases) {
    const d = t.browser();
    const s = await d.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
    await expect(await d.call(t.google.pick(s.body.url, noa, options)), status);
  }
  // Signed with another key, or with no signature at all ("alg": "none").
  for (const raw of [
    await t.google.sign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'x@gmail.com', email_verified: true, iat: t0, exp: t0 + 60 }, { key: other.privateKey }),
    `${json64({ alg: 'none' })}.${json64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'x@gmail.com', email_verified: true, iat: t0, exp: t0 + 60 })}.`,
    'not-a-token',
  ]) {
    const d = t.browser();
    const s = await d.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
    await expect(await d.call(t.google.pick(s.body.url, noa, { raw })), 'failed');
  }
  // A code Google doesn't know, or without the sign-in's secret: Google refuses the trade.
  const e = t.browser();
  const s4 = await e.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
  await expect(await e.call(`/api/auth/google/callback?code=guessed&state=${new URL(s4.body.url).searchParams.get('state')}`), 'failed');
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1); // only the one above
  // Ten minutes at most between leaving for Google's page and coming back.
  const f = t.browser();
  const s5 = await f.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } });
  const late = t.google.pick(s5.body.url, noa);
  t.advance(0.2);
  await expect(await f.call(late), 'expired');
  assert.equal((await t.browser().call('/api/auth/google/start', { method: 'POST', body: { for: 'everything' } })).status, 400);
});

test('a Google account sees a card once David connects its Gmail, or once its phone number is proven', async () => {
  const t = await setup();
  const noaId = t.addClient('נועה כהן', '0501234567', 3);
  t.addClient('דנה לוי', '0527654321', 0);
  const b = t.browser();
  await t.viaGoogle(b, noa);
  assert.equal((await b.call('/api/account')).body.client, null);

  // David writes her Gmail on her card (as she told him, dots or not): her card shows.
  const { b: david } = await t.admin();
  const saved = await david.call(`/api/admin/clients/${noaId}`, { method: 'PUT', body: { name: 'נועה כהן', phone: '0501234567', cardLeft: 3, google: 'noacohen@gmail.com' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.client.google, 'noacohen@gmail.com');
  let me = (await b.call('/api/account')).body;
  assert.deepEqual(me.client, { cardLeft: 3 });
  assert.equal(me.name, 'נועה כהן'); // as on David's list
  assert.equal(me.phone, '0501234567');
  // Another client can't have the same Gmail address.
  const dana = (await david.call('/api/admin/clients?q=דנה')).body.clients[0].id;
  const twice = await david.call(`/api/admin/clients/${dana}`, { method: 'PUT', body: { name: 'דנה לוי', phone: '0527654321', cardLeft: 0, google: 'NOA.COHEN+x@googlemail.com' } });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, 'google_taken');
  assert.equal((await david.call('/api/admin/clients', { method: 'POST', body: { name: 'חדשה', phone: '0541111111', google: 'noacohen@gmail.com' } })).status, 409);
  assert.equal((await david.call('/api/admin/clients?q=חדשה')).body.clients.length, 0); // not added either
  assert.equal((await david.call(`/api/admin/clients/${dana}`, { method: 'PUT', body: { name: 'דנה', phone: '0527654321', cardLeft: 0, google: 'not an email' } })).status, 400);
  // The client form shows when she last signed in.
  assert.match((await david.call(`/api/admin/clients/${noaId}`)).body.client.lastSignIn, /^2026-10-01T05:00/);
  // Disconnected: the card no longer shows.
  await david.call(`/api/admin/clients/${noaId}`, { method: 'PUT', body: { name: 'נועה כהן', phone: '0501234567', cardLeft: 3, google: '' } });
  assert.equal((await b.call('/api/account')).body.client, null);
  // Saving without the field (an older page) leaves it as it was.
  await david.call(`/api/admin/clients/${noaId}`, { method: 'PUT', body: { name: 'נועה כהן', phone: '0501234567', cardLeft: 3, google: 'noacohen@gmail.com' } });
  await david.call(`/api/admin/clients/${noaId}`, { method: 'PUT', body: { name: 'נועה כהן', phone: '0501234567', cardLeft: 3 } });
  assert.deepEqual((await b.call('/api/account')).body.client, { cardLeft: 3 });

  // Another Google account proves Dana's number with a code: her card shows there.
  const c = t.browser();
  await t.viaGoogle(c, { sub: '2002', email: 'dana@example.com', name: 'Dana' });
  assert.equal((await c.call('/api/account')).body.client, null);
  const proved = await t.viaPhone(c, '052-7654321');
  assert.equal(proved.status, 200);
  assert.equal(proved.setCookies.length, 0); // still the same sign-in
  me = (await c.call('/api/account')).body;
  assert.equal(me.via, 'google');
  assert.equal(me.phoneProven, true);
  assert.deepEqual(me.client, { cardLeft: 0 });
  assert.equal(emailKey('John.Doe+news@GoogleMail.com'), 'johndoe@gmail.com');
  assert.equal(emailKey('John.Doe@example.com'), 'john.doe@example.com');
});

test('signing in with Google where the phone was signed in: the earlier sign-in ends', async () => {
  const t = await setup();
  const b = t.browser();
  await t.viaPhone(b, '0501234567');
  const phoneSession = b.jar.get('__Host-client');
  await t.viaGoogle(b, noa);
  assert.equal((await b.call('/api/account')).body.via, 'google');
  const sessions = t.env.DB.raw.prepare('SELECT id_hash FROM account_sessions').all().map((r) => r.id_hash);
  assert.deepEqual(sessions, [await hashCode(b.jar.get('__Host-client'))]);
  assert.ok(!sessions.includes(await hashCode(phoneSession)));
});

test('the phone: a code by SMS to an Israeli mobile number only, checked by Twilio', async () => {
  const t = await setup();
  const b = t.browser();
  for (const phone of ['03-1234567', '1234567', '+1 202 555 0100', '', '05012345678']) {
    const r = await b.call('/api/account/phone/start', { method: 'POST', body: { phone } });
    assert.equal(r.status, 400, phone);
    assert.deepEqual(r.body.fields, ['phone']);
  }
  assert.equal(t.twilio.sent.length, 0);
  assert.equal((await b.call('/api/account/phone/start', { method: 'POST', body: { phone: '+972 50-123-4567', lang: 'en' } })).status, 200);
  assert.deepEqual(t.twilio.sent, [{ to: '+972501234567', channel: 'sms', locale: 'en' }]);

  const check = (code) => b.call('/api/account/phone/check', { method: 'POST', body: { phone: '050-123-4567', code } });
  assert.equal((await check('12')).status, 400); // not a code at all
  const wrong = await check('999999');
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'code_wrong');
  assert.equal(wrong.setCookies.length, 0);
  const right = await check(t.twilio.codeFor('+972501234567'));
  assert.equal(right.status, 200);
  assert.match(right.setCookies[0], /^__Host-client=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  // A code works once.
  const again = await check(t.twilio.codeFor('+972501234567') ?? '100000');
  assert.equal(again.body.error, 'code_expired');

  // Signed in with the phone: no card yet (not one of David's clients), then the card by that number.
  let me = (await b.call('/api/account')).body;
  assert.equal(me.via, 'phone');
  assert.equal(me.phone, '0501234567');
  assert.equal(me.client, null);
  const id = t.addClient('נועה כהן', '0501234567', 4);
  me = (await b.call('/api/account')).body;
  assert.deepEqual(me.client, { cardLeft: 4 });
  // The same number again later: the same account.
  const c = t.browser();
  await t.viaPhone(c, '0501234567');
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 1);
  assert.deepEqual((await c.call('/api/account')).body.client, { cardLeft: 4 });
  assert.ok(id);
});

test('too many codes or tries from one visitor: refused before Twilio is asked', async () => {
  const t = await setup({ limit: 5 });
  const b = t.browser();
  for (let i = 0; i < 5; i++) assert.equal((await b.call('/api/account/phone/start', { method: 'POST', body: { phone: '0501234567' } })).status, 200);
  const sixth = await b.call('/api/account/phone/start', { method: 'POST', body: { phone: '0501234567' } });
  assert.equal(sixth.status, 429);
  assert.equal(t.twilio.sent.length, 5);
  for (let i = 0; i < 5; i++) await b.call('/api/account/phone/check', { method: 'POST', body: { phone: '0501234567', code: '000000' } });
  assert.equal((await b.call('/api/account/phone/check', { method: 'POST', body: { phone: '0501234567', code: '000000' } })).status, 429);
});

test('a session from the card, signed in: confirmed at once and taken off the card', async () => {
  const t = await setup();
  const id = t.addClient('נועה כהן', '0501234567', 2);
  const b = t.browser();
  await t.viaPhone(b, '050-123-4567');

  const first = await t.book(b);
  assert.equal(first.status, 201);
  assert.equal(first.body.booking.status, 'confirmed');
  assert.equal(first.body.booking.price, 0);
  assert.equal(first.body.cardLeft, 1);
  assert.equal(first.body.transfer, undefined); // nothing to pay
  assert.equal(t.cardOf(id), 1);
  await t.settle();
  const row = t.env.DB.raw.prepare('SELECT status, client_id, plan, hold_until, approved_at FROM bookings WHERE ref = ?').get(first.body.booking.ref);
  assert.deepEqual({ ...row }, { status: 'confirmed', client_id: id, plan: 'card', hold_until: null, approved_at: null });
  assert.equal((await t.browser().call(`/api/bookings/status?ref=${first.body.booking.ref}`)).body.status, 'confirmed');

  // The last session on the card, then none left: the next one waits for David, as before.
  assert.equal((await t.book(b, { time: '14:00' })).body.cardLeft, 0);
  const third = await t.book(b, { time: '15:30' });
  assert.equal(third.status, 201);
  assert.equal(third.body.booking.status, undefined);
  assert.equal(third.body.transfer.phone, '058-434-4047');
  assert.equal(t.cardOf(id), 0);

  // What she sees: her bookings, the waiting one too, and none of anyone else's.
  await t.book(t.browser(), { time: '17:00', name: 'מישהו אחר', phone: '052-9999999', plan: 'single' });
  const me = (await b.call('/api/account')).body;
  assert.deepEqual(me.client, { cardLeft: 0 });
  assert.deepEqual(me.bookings.map((x) => [x.time, x.status, x.plan]), [['12:30', 'confirmed', 'card'], ['14:00', 'confirmed', 'card'], ['15:30', 'pending', 'card']]);
  assert.ok(me.bookings.every((x) => !('notes' in x) && !('phone' in x) && !('name' in x)));
});

test('from the card at once only for the card’s own phone number, a free time, and a session left', async () => {
  const t = await setup();
  const id = t.addClient('נועה כהן', '0501234567', 3);
  const b = t.browser();
  await t.viaPhone(b, '0501234567');

  // Another phone number on the booking: David approves it, as before.
  assert.equal((await t.book(b, { phone: '052-7654321' })).body.booking.status, undefined);
  assert.equal(t.cardOf(id), 3);
  // Not signed in: as before.
  assert.equal((await t.book(t.browser(), { time: '14:00' })).body.booking.status, undefined);
  // One session, or a new card: paid by Bit or PayBox, as before.
  assert.equal((await t.book(b, { time: '15:30', plan: 'single' })).body.transfer.phone, '058-434-4047');
  assert.equal(t.cardOf(id), 3);
  // A time that's taken: refused, and the card keeps its session.
  const taken = await t.book(b, { time: '12:30' });
  assert.equal(taken.status, 409);
  assert.equal(t.cardOf(id), 3);

  // Two bookings at the same moment for the card's last session: one gets it, the other waits for David.
  t.env.DB.raw.prepare('UPDATE clients SET card_left = 1 WHERE id = ?').run(id);
  const [x, y] = await Promise.all([t.book(b, { date: '2026-10-05', time: '09:00' }), t.book(b, { date: '2026-10-05', time: '12:30' })]);
  assert.deepEqual([x.body.booking.status, y.body.booking.status].sort(), ['confirmed', undefined].sort());
  assert.equal(t.cardOf(id), 0);
});

test('cancelling a confirmed session from a card puts it back on the card', async () => {
  const t = await setup();
  const id = t.addClient('נועה כהן', '0501234567', 2);
  const b = t.browser();
  await t.viaPhone(b, '0501234567');
  const { b: david } = await t.admin();
  const idOf = (ref) => t.env.DB.raw.prepare('SELECT id FROM bookings WHERE ref = ?').get(ref).id;

  const fromCard = await t.book(b);
  assert.equal(t.cardOf(id), 1);
  const cancelled = await david.call(`/api/admin/bookings/${idOf(fromCard.body.booking.ref)}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancelled.body.cardLeft, 2);
  assert.equal(t.cardOf(id), 2);
  // Cancelling it again changes nothing.
  assert.equal((await david.call(`/api/admin/bookings/${idOf(fromCard.body.booking.ref)}/cancel`, { method: 'POST', body: {} })).status, 404);
  assert.equal(t.cardOf(id), 2);

  // Waiting for approval: nothing was taken, nothing goes back.
  const waiting = await t.book(b, { time: '14:00', phone: '052-7654321' });
  assert.equal((await david.call(`/api/admin/bookings/${idOf(waiting.body.booking.ref)}/cancel`, { method: 'POST', body: {} })).body.cardLeft, null);
  // A new card David approved: its first session goes back too (4 left of the 4 paid for).
  const pack = await t.book(b, { time: '15:30', plan: 'pack' });
  await david.call(`/api/admin/bookings/${idOf(pack.body.booking.ref)}/approve`, { method: 'POST', body: {} });
  assert.equal(t.cardOf(id), 5);
  assert.equal((await david.call(`/api/admin/bookings/${idOf(pack.body.booking.ref)}/cancel`, { method: 'POST', body: {} })).body.cardLeft, 6);
  // One session paid by itself: not on the card.
  const single = await t.book(b, { time: '17:00', plan: 'single' });
  await david.call(`/api/admin/bookings/${idOf(single.body.booking.ref)}/approve`, { method: 'POST', body: {} });
  assert.equal((await david.call(`/api/admin/bookings/${idOf(single.body.booking.ref)}/cancel`, { method: 'POST', body: {} })).body.cardLeft, null);
  assert.equal(t.cardOf(id), 6);
});

test('managers: connect a Google account right after signing in, then sign in with it', async () => {
  const t = await setup();
  const david = await t.admin();
  const googleDavid = { sub: 'g-david', email: 'david@gmail.com', name: 'David' };
  assert.equal((await david.b.call('/api/admin/session')).body.google, true);

  // Signing in with a Google account no manager connected: refused.
  const stranger = t.browser();
  const unknown = await t.viaGoogle(stranger, googleDavid, 'admin');
  assert.equal(unknown.location, `${ORIGIN}/admin#signin=unknown`);
  assert.ok(!unknown.setCookies.some((c) => c.startsWith('__Host-admin=')));

  // Connecting needs a fresh sign-in, as saving the sign-in on another device does.
  const stale = await t.admin({ fresh: false, name: 'רותם' });
  const refused = await stale.b.call('/api/auth/google/start', { method: 'POST', body: { for: 'link' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'reauth_required');
  assert.equal((await t.browser().call('/api/auth/google/start', { method: 'POST', body: { for: 'link' } })).status, 401);

  const linked = await t.viaGoogle(david.b, googleDavid, 'link');
  assert.equal(linked.location, `${ORIGIN}/admin#signin=linked`);
  const people = (await david.b.call('/api/admin/admins')).body.admins;
  assert.deepEqual(people.map((a) => [a.name, a.google]), [['דוד', 'david@gmail.com'], ['רותם', null]]);
  // The same Google account can't be another manager's too.
  const fresh = await t.admin({ name: 'שני' });
  assert.equal((await t.viaGoogle(fresh.b, googleDavid, 'link')).location, `${ORIGIN}/admin#signin=taken`);

  // Signing in with it, on another computer.
  const pc = t.browser();
  const back = await t.viaGoogle(pc, googleDavid, 'admin');
  assert.equal(back.location, `${ORIGIN}/admin#signin=ok`);
  assert.match(back.setCookies.find((c) => c.startsWith('__Host-admin=')), /HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const session = (await pc.call('/api/admin/session')).body;
  assert.equal(session.loggedIn, true);
  assert.equal(session.name, 'דוד');
  // (a client's Google sign-in is no way into the admin panel)
  const client = t.browser();
  await t.viaGoogle(client, googleDavid, 'client');
  assert.equal((await client.call('/api/admin/session')).body.loggedIn, false);

  // Disconnected: Face ID still works, Google no longer does.
  assert.equal((await david.b.call('/api/admin/google', { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await t.viaGoogle(t.browser(), googleDavid, 'admin')).location, `${ORIGIN}/admin#signin=unknown`);
  // A manager removed: their Google account goes with them.
  await t.viaGoogle(fresh.b, googleDavid, 'link');
  assert.equal((await david.b.call(`/api/admin/admins/${fresh.id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM admin_google').get().n, 0);
  // …even if that happens while they're on Google's page.
  const third = await t.admin({ name: 'גל' });
  const start = await third.b.call('/api/auth/google/start', { method: 'POST', body: { for: 'link' } });
  await david.b.call(`/api/admin/admins/${third.id}`, { method: 'DELETE', body: {} });
  assert.equal((await third.b.call(t.google.pick(start.body.url, { sub: 'g-gal', email: 'gal@gmail.com' }))).location, `${ORIGIN}/admin#signin=gone`);
});

test('forgetting a client signs them out and forgets their sign-ins too; sessions run out', async () => {
  const t = await setup();
  const id = t.addClient('נועה כהן', '0501234567', 2);
  const byPhone = t.browser();
  await t.viaPhone(byPhone, '0501234567');
  const byGoogle = t.browser();
  await t.viaGoogle(byGoogle, noa);
  const { b: david } = await t.admin();
  await david.call(`/api/admin/clients/${id}`, { method: 'PUT', body: { name: 'נועה כהן', phone: '0501234567', cardLeft: 2, google: 'noa.cohen@gmail.com' } });
  const someoneElse = t.browser();
  await t.viaPhone(someoneElse, '0527654321');
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 3);

  assert.equal((await david.call(`/api/admin/clients/${id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await byPhone.call('/api/account')).body.signedIn, false);
  assert.equal((await byGoogle.call('/api/account')).body.signedIn, false);
  assert.equal(t.env.DB.raw.prepare('SELECT COUNT(*) AS n FROM client_google').get().n, 0);
  assert.deepEqual(t.env.DB.raw.prepare('SELECT phone FROM accounts').all().map((r) => r.phone), ['0527654321']);
  assert.equal((await someoneElse.call('/api/account')).body.signedIn, true);

  // A client's sign-in lasts 90 days.
  t.advance(24 * 89);
  assert.equal((await someoneElse.call('/api/account')).body.signedIn, true);
  t.advance(24 * 2);
  assert.equal((await someoneElse.call('/api/account')).body.signedIn, false);
});

test('signing in is only for this site’s pages, and only over JSON', async () => {
  const t = await setup();
  const b = t.browser();
  const evil = await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal((await b.call('/api/account/phone/start', { method: 'POST', body: { phone: '0501234567' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(t.twilio.sent.length, 0);
  const form = await t.browser().call('/api/account/phone/check', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  // In WhatsApp mode nothing is kept on the site, so there's nothing to sign in to.
  t.env.BOOKING_MODE = 'whatsapp';
  assert.deepEqual((await b.call('/api/account')).body, { google: false, sms: false, signedIn: false });
  assert.equal((await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'client' } })).status, 404);
  // (managers still can)
  assert.equal((await b.call('/api/auth/google/start', { method: 'POST', body: { for: 'admin' } })).status, 200);
});
