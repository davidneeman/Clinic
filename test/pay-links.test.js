// David's own Bit and PayBox links: the booking page's buttons open them after a booking paid by
// Bit or PayBox. The site comes with his Bit link (config/site.json → payLinks); what he saves in
// the admin panel's "האתר" tab replaces it (none at all, too). Only https links are kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { hashCode } from '../worker/passkeys.js';
import { fakeD1 } from './support/fake-d1.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };
const BIT = 'https://www.bitpay.co.il/app/me/ABCDEF12';
const PAYBOX = 'https://payboxapp.com/paylink/david-neeman';
const SITE_BIT = config.payLinks.bit; // the one the site comes with

async function setup({ site = config } = {}) {
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer' };
  const worker = createWorker({ config: site, clock: () => new Date('2026-10-01T05:00:00Z'), log: silent });
  env.DB.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
  env.DB.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(await hashCode('session-token'), '2026-12-01T00:00:00.000Z');
  const call = async (path, { method = 'GET', body, admin = false } = {}) => {
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
  const save = (payLinks) => call('/api/admin/content', { method: 'PUT', body: { payLinks }, admin: true });
  const book = (time, plan = 'single') =>
    call('/api/bookings', {
      method: 'POST',
      body: { serviceId: 'stress', date: '2026-10-04', time, name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan },
    });
  return { env, call, save, book };
}

test('the site comes with his Bit link: the button shows until he changes it', async () => {
  assert.match(SITE_BIT, /^https:\/\/www\.bitpay\.co\.il\/app\/me\/[\w-]+$/);
  const { call, book } = await setup();
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', bit: SITE_BIT });
  assert.deepEqual((await book('12:30')).body.transfer, { phone: '058-434-4047', bit: SITE_BIT });
  // The admin panel shows it as the original, with nothing of his saved yet.
  const admin = (await call('/api/admin/content', { admin: true })).body;
  assert.deepEqual(admin.defaults.payLinks, { bit: SITE_BIT });
  assert.equal(admin.content.payLinks, undefined);
});

test('a site without links of its own: the phone number only, as before', async () => {
  const { payLinks, ...site } = config;
  const { call, book } = await setup({ site });
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047' });
  assert.deepEqual((await book('12:30')).body.transfer, { phone: '058-434-4047' });
});

test('his links: kept, and given with the payment details (with the phone number still there)', async () => {
  const { call, save, book } = await setup();
  const saved = await save({ bit: `  ${BIT}  `, paybox: PAYBOX });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.content.payLinks, { bit: BIT, paybox: PAYBOX });
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', bit: BIT, paybox: PAYBOX });
  const single = await book('12:30');
  assert.deepEqual(single.body.transfer, { phone: '058-434-4047', bit: BIT, paybox: PAYBOX });
  assert.equal(single.body.booking.price, 350);
  assert.equal((await book('14:00', 'pack')).body.transfer.bit, BIT);
  // The admin panel reads them back as saved.
  assert.deepEqual((await call('/api/admin/content', { admin: true })).body.content.payLinks, { bit: BIT, paybox: PAYBOX });

  // One taken off: only the other stays (the site's own Bit link doesn't come back by itself).
  assert.deepEqual((await save({ paybox: PAYBOX, bit: '' })).body.content.payLinks, { paybox: PAYBOX });
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', paybox: PAYBOX });
  // Both taken off: none at all, as he chose.
  assert.deepEqual((await save({})).body.content.payLinks, {});
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047' });
  // "Back to the original": the site's own again.
  assert.equal((await save(null)).body.content.payLinks, undefined);
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', bit: SITE_BIT });
});

test('only a real https link is kept; anything else is refused and nothing changes', async () => {
  const { call, save } = await setup();
  await save({ bit: BIT });
  for (const [links, field] of [
    [{ bit: 'http://www.bitpay.co.il/app/me/X' }, 'payLinks.bit'],
    [{ bit: 'javascript:alert(1)' }, 'payLinks.bit'],
    [{ paybox: 'data:text/html,<script>alert(1)</script>' }, 'payLinks.paybox'],
    [{ paybox: 'https://user:secret@payboxapp.com/x' }, 'payLinks.paybox'],
    [{ paybox: 'https://192.168.1.1/pay' }, 'payLinks.paybox'],
    [{ paybox: 'https://localhost/pay' }, 'payLinks.paybox'],
    [{ bit: 'bitpay.co.il/app/me/X' }, 'payLinks.bit'],
    [{ bit: `https://bitpay.co.il/${'x'.repeat(600)}` }, 'payLinks.bit'],
    [{ bit: 42 }, 'payLinks.bit'],
    [{ venmo: 'https://venmo.com/david' }, 'payLinks.venmo'],
  ]) {
    const r = await save(links);
    assert.equal(r.status, 400, JSON.stringify(links));
    assert.deepEqual(r.body.fields, [field]);
  }
  assert.equal((await save('https://www.bitpay.co.il/')).status, 400);
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', bit: BIT });
  // And only David may change them.
  assert.equal((await call('/api/admin/content', { method: 'PUT', body: { payLinks: { bit: 'https://evil.example/pay' } } })).status, 401);
  assert.equal((await call('/api/config')).body.transfer.bit, BIT);
});

test('a link kept before the rules (or edited in the database) that is not https never reaches the page', async () => {
  const { env, call } = await setup();
  env.DB.raw.prepare("INSERT INTO settings (key, value) VALUES ('content', ?)").run(JSON.stringify({ payLinks: { bit: 'javascript:alert(1)', paybox: PAYBOX } }));
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', paybox: PAYBOX });
});
