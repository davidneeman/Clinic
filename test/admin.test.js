// The admin panel on Cloudflare: signing in with a passkey (worker/passkeys.js), the people
// who may sign in, and David's client list. A software passkey stands in for a phone: it
// signs exactly as a phone does (ECDSA P-256, DER signatures, WebAuthn's byte layout).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { b64url, hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };
const SITE = 'https://clinic.example';
const RP_ID = 'clinic.example';
const utf8 = new TextEncoder();

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u16 = (n) => Uint8Array.of(n >> 8, n & 255);
const u32 = (n) => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
const sha = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8.encode(data) : data));

function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat([Uint8Array.of(0), v]);
    return concat([Uint8Array.of(0x02, v.length), v]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat([Uint8Array.of(0x30, r.length + s.length), r, s]);
}

/** A software passkey: what an iPhone's Face ID passkey does, in code. */
async function softPasskey({ counting = false } = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  let counter = 0;
  const authData = async ({ rpId = RP_ID, flags = 0x05, attested = false, count = 0 }) =>
    concat([
      await sha(rpId),
      Uint8Array.of(flags | (attested ? 0x40 : 0)),
      u32(count),
      ...(attested ? [new Uint8Array(16), u16(credId.length), credId, new Uint8Array(77)] : []),
    ]);
  const client = (type, challenge, origin) => utf8.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64url.encode(credId),
    async create(options, { origin = SITE, rpId = options.rp.id, flags } = {}) {
      return {
        id: b64url.encode(credId),
        rawId: b64url.encode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url.encode(client('webauthn.create', options.challenge, origin)),
          authenticatorData: b64url.encode(await authData({ rpId, flags, attested: true })),
          publicKey: b64url.encode(spki),
          publicKeyAlgorithm: -7,
        },
      };
    },
    async get(options, { origin = SITE, rpId = options.rpId, flags, tamper = false, repeatCounter = false } = {}) {
      if (counting && !repeatCounter) counter++;
      const auth = await authData({ rpId, flags, count: counting ? counter : 0 });
      const clientData = client('webauthn.get', options.challenge, origin);
      const signed = concat([auth, await sha(clientData)]);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed));
      if (tamper) raw[5] ^= 1;
      return {
        id: b64url.encode(credId),
        rawId: b64url.encode(credId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url.encode(clientData),
          authenticatorData: b64url.encode(auth),
          signature: b64url.encode(rawToDer(raw)),
          userHandle: null,
        },
      };
    },
  };
}

function setup(vars = {}) {
  const env = { DB: fakeD1(), BOOKING_MODE: 'online', ...vars };
  let now = new Date('2026-10-01T05:00:00Z');
  const worker = createWorker({ config, clock: () => now, log: silent });
  const advance = (minutes) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const res = await worker.fetch(
      new Request(`${SITE}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const invite = async (code = `invite-${Math.random()}`, name = 'Rotem', expires = '2026-10-03T00:00:00.000Z') => {
    env.DB.raw.prepare('INSERT INTO invites (code_hash, name, expires_at) VALUES (?, ?, ?)').run(await hashCode(code), name, expires);
    return code;
  };
  /** Adds a passkey with an invite, like the admin page does. → the session cookie. */
  const register = async (key, code, name) => {
    const start = await call('/api/admin/passkey/register/start', { method: 'POST', body: { invite: code } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const finish = await call('/api/admin/passkey/register/finish', {
      method: 'POST',
      body: { id: start.body.id, credential: await key.create(start.body.publicKey), name },
    });
    return finish;
  };
  const login = async (key, opts) => {
    const start = await call('/api/admin/passkey/login/start', { method: 'POST', body: {} });
    return call('/api/admin/passkey/login/finish', { method: 'POST', body: { id: start.body.id, credential: await key.get(start.body.publicKey, opts) } });
  };
  const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];
  return { env, call, invite, register, login, cookieOf, advance, settle: () => Promise.all(waits) };
}

test('Face ID: a one-time link adds a passkey, then the passkey signs in', async () => {
  const { call, invite, register, login, cookieOf } = setup();
  const key = await softPasskey();
  const code = await invite();

  const start = await call('/api/admin/passkey/register/start', { method: 'POST', body: { invite: code } });
  assert.equal(start.body.publicKey.rp.id, RP_ID);
  assert.equal(start.body.publicKey.authenticatorSelection.userVerification, 'required');
  const added = await call('/api/admin/passkey/register/finish', {
    method: 'POST',
    body: { id: start.body.id, credential: await key.create(start.body.publicKey), name: 'רותם' },
  });
  assert.equal(added.status, 201);
  const setCookie = added.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-admin=[\w-]{40,}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const cookie = cookieOf(added);
  assert.deepEqual((await call('/api/admin/session', { cookie })).body, { enabled: true, loggedIn: true, passkeys: true, name: 'רותם', access: false, editor: true, media: false });

  // The link worked once.
  assert.equal((await call('/api/admin/passkey/register/start', { method: 'POST', body: { invite: code } })).status, 403);

  // Logging out ends the session.
  const out = await call('/api/admin/logout', { method: 'POST', body: {}, cookie });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('/api/admin/bookings', { cookie })).status, 401);

  // Face ID again: a new session.
  const back = await login(key);
  assert.equal(back.status, 200);
  assert.equal(back.body.name, 'רותם');
  assert.equal((await call('/api/admin/bookings', { cookie: cookieOf(back) })).status, 200);
});

test('a passkey only signs in for this site, with Face ID, on a fresh challenge', async () => {
  const { call, invite, register, login } = setup();
  const key = await softPasskey({ counting: true });
  assert.equal((await register(key, await invite())).status, 201);

  assert.equal((await login(key, { origin: 'https://clinic-example.evil' })).status, 401);
  assert.equal((await login(key, { rpId: 'evil.example' })).status, 401);
  assert.equal((await login(key, { flags: 0x01 })).status, 401); // present, but not verified (no Face ID)
  assert.equal((await login(key, { tamper: true })).status, 401);
  assert.equal((await login(await softPasskey())).status, 401); // a passkey the site doesn't know
  assert.equal((await login(key)).status, 200);
  assert.equal((await login(key, { repeatCounter: true })).status, 401); // a copied passkey

  // A challenge works once.
  const start = await call('/api/admin/passkey/login/start', { method: 'POST', body: {} });
  const credential = await key.get(start.body.publicKey);
  assert.equal((await call('/api/admin/passkey/login/finish', { method: 'POST', body: { id: start.body.id, credential } })).status, 200);
  assert.equal((await call('/api/admin/passkey/login/finish', { method: 'POST', body: { id: start.body.id, credential } })).status, 400);

  // New passkeys need a valid link, made for this site.
  assert.equal((await call('/api/admin/passkey/register/start', { method: 'POST', body: { invite: 'guess' } })).status, 403);
  assert.equal((await register(await softPasskey(), await invite('old', 'x', '2026-09-30T00:00:00.000Z')).catch(() => ({ status: 403 }))).status, 403);
  const code = await invite();
  const reg = await call('/api/admin/passkey/register/start', { method: 'POST', body: { invite: code } });
  const fake = await (await softPasskey()).create(reg.body.publicKey, { origin: 'https://evil.example' });
  assert.equal((await call('/api/admin/passkey/register/finish', { method: 'POST', body: { id: reg.body.id, credential: fake } })).status, 400);
});

test('people: invite another person, list them, remove them (their passkey stops working)', async () => {
  const { call, invite, register, login, cookieOf } = setup();
  const mine = await softPasskey();
  const me = cookieOf(await register(mine, await invite(), 'רותם'));

  const made = await call('/api/admin/invites', { method: 'POST', body: { name: 'דוד' }, cookie: me });
  assert.equal(made.status, 201);
  const link = new URL(made.body.link);
  assert.equal(link.pathname, '/admin');
  const david = await softPasskey();
  assert.equal((await register(david, link.hash.replace('#invite=', ''), 'דוד')).status, 201);

  const { body } = await call('/api/admin/admins', { cookie: me });
  assert.deepEqual(body.admins.map((a) => [a.name, a.passkeys]), [['רותם', 1], ['דוד', 1]]);
  // Adding Face ID signs the person in, so it shows as their latest sign-in.
  assert.ok(body.admins.every((a) => typeof a.last_used === 'string' && a.last_used.length > 0));
  assert.equal((await call(`/api/admin/admins/${body.me}`, { method: 'DELETE', body: {}, cookie: me })).status, 409);
  const davidId = body.admins.find((a) => a.name === 'דוד').id;
  assert.equal((await call(`/api/admin/admins/${davidId}`, { method: 'DELETE', body: {}, cookie: me })).status, 200);
  assert.equal((await login(david)).status, 401);
  assert.equal((await login(mine)).status, 200);
});

test('saving the sign-in on a computer: the same person gets a second passkey, only right after signing in', async () => {
  const { call, invite, register, login, cookieOf, advance } = setup();
  const phone = await softPasskey();
  const me = cookieOf(await register(phone, await invite(), 'דוד'));
  const add = async (key, cookie) => {
    const start = await call('/api/admin/passkey/add/start', { method: 'POST', body: {}, cookie });
    if (start.status !== 200) return start;
    return call('/api/admin/passkey/add/finish', { method: 'POST', body: { id: start.body.id, credential: await key.create(start.body.publicKey) }, cookie });
  };

  const start = await call('/api/admin/passkey/add/start', { method: 'POST', body: {}, cookie: me });
  assert.equal(start.status, 200);
  // The phone already holds a passkey, and this asks for the computer's own one.
  assert.deepEqual(start.body.publicKey.excludeCredentials, [{ type: 'public-key', id: phone.id }]);
  assert.equal(start.body.publicKey.authenticatorSelection.authenticatorAttachment, 'platform');

  const computer = await softPasskey();
  assert.equal((await add(computer, me)).status, 201);
  const { body } = await call('/api/admin/admins', { cookie: me });
  assert.deepEqual(body.admins.map((a) => [a.name, a.passkeys]), [['דוד', 2]]);
  const viaComputer = await login(computer);
  assert.equal(viaComputer.status, 200);
  assert.equal(viaComputer.body.name, 'דוד');
  assert.equal((await login(phone)).status, 200);

  // The same device twice: refused.
  assert.equal((await add(computer, me)).status, 409);

  // One person's challenge can't add a passkey to someone else.
  const other = cookieOf(await register(await softPasskey(), await invite(), 'שני'));
  const mine = await call('/api/admin/passkey/add/start', { method: 'POST', body: {}, cookie: me });
  const crossed = await call('/api/admin/passkey/add/finish', {
    method: 'POST',
    body: { id: mine.body.id, credential: await (await softPasskey()).create(mine.body.publicKey) },
    cookie: other,
  });
  assert.equal(crossed.status, 400);

  // Later in the session: sign in again first. And never without signing in.
  advance(20);
  const late = await call('/api/admin/passkey/add/start', { method: 'POST', body: {}, cookie: me });
  assert.equal(late.status, 403);
  assert.equal(late.body.error, 'reauth_required');
  assert.equal((await call('/api/admin/passkey/add/start', { method: 'POST', body: {} })).status, 401);
  assert.equal((await call('/api/admin/passkey/add/finish', { method: 'POST', body: { id: 'x', credential: {} } })).status, 401);
});

test('without signing in, none of the admin data is reachable', async () => {
  const { call } = setup();
  for (const [method, path] of [['GET', '/api/admin/clients'], ['GET', '/api/admin/admins'], ['POST', '/api/admin/invites'], ['GET', '/api/admin/clients/1']]) {
    assert.equal((await call(path, { method, body: method === 'GET' ? undefined : {} })).status, 401, path);
  }
  assert.equal((await call('/api/admin/clients', { cookie: '__Host-admin=forged-session-value' })).status, 401);
});

test("David's clients: from bookings by phone number, searchable, editable, forgettable", async () => {
  const { call, invite, register, cookieOf, settle, env } = setup();
  const cookie = cookieOf(await register(await softPasskey(), await invite(), 'דוד'));
  const book = (b) =>
    call('/api/bookings', { method: 'POST', body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'Dana Levi', phone: '050-123 4567', email: 'dana@example.com', consent: true, ...b } });

  assert.equal((await book({})).status, 201);
  assert.equal((await book({ time: '15:00', phone: '+972 50 123 4567', name: 'Dana L.' })).status, 201);
  await settle();
  let list = (await call('/api/admin/clients', { cookie })).body.clients;
  assert.equal(list.length, 1, 'the same phone number is the same client');
  assert.equal(list[0].phone, '0501234567');
  assert.equal(list[0].name, 'Dana Levi');
  assert.equal(list[0].next_visit, '2026-10-04 12:30');

  // David adds a client himself, and notes a card of 4 sessions.
  const added = await call('/api/admin/clients', { method: 'POST', body: { name: 'Avi Cohen', phone: '052-7654321', notes: 'מעדיף בוקר' }, cookie });
  assert.equal(added.status, 201);
  assert.equal((await call('/api/admin/clients', { method: 'POST', body: { name: 'Twice', phone: '0527654321' }, cookie })).status, 409);
  const id = added.body.client.id;
  const edited = await call(`/api/admin/clients/${id}`, { method: 'PUT', body: { name: 'Avi Cohen', phone: '0527654321', notes: 'מעדיף בוקר', cardLeft: 4 }, cookie });
  assert.equal(edited.body.client.card_left, 4);
  assert.equal((await call(`/api/admin/clients/${id}`, { method: 'PUT', body: { name: 'A', phone: '1', cardLeft: -1 }, cookie })).status, 400);

  assert.deepEqual((await call('/api/admin/clients?q=avi', { cookie })).body.clients.map((c) => c.name), ['Avi Cohen']);
  assert.deepEqual((await call('/api/admin/clients?q=050-123', { cookie })).body.clients.map((c) => c.name), ['Dana Levi']);

  // A client's history, then forgetting her: her details leave the bookings too.
  const dana = list[0].id;
  assert.equal((await call(`/api/admin/clients/${dana}`, { cookie })).body.bookings.length, 2);
  assert.equal((await call(`/api/admin/clients/${dana}`, { method: 'DELETE', body: {}, cookie })).status, 200);
  const left = env.DB.raw.prepare("SELECT name, phone, email FROM bookings WHERE date = '2026-10-04'").all();
  assert.deepEqual(left.map((r) => ({ ...r })), [{ name: '—', phone: '', email: null }, { name: '—', phone: '', email: null }]);
  list = (await call('/api/admin/clients', { cookie })).body.clients;
  assert.deepEqual(list.map((c) => c.name), ['Avi Cohen']);
});
