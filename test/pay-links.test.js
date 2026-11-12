// David's own Bit and PayBox links (the admin panel's "האתר" tab): the booking page's buttons
// open them after a booking paid by Bit or PayBox. Only https links are kept.

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

async function setup() {
  const env = { DB: fakeD1(), BOOKING_MODE: 'transfer' };
  const worker = createWorker({ config, clock: () => new Date('2026-10-01T05:00:00Z'), log: silent });
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

test('without links: the booking page shows the phone number only, as before', async () => {
  const { call, book } = await setup();
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

  // One taken off: only the other stays. Both: none.
  assert.deepEqual((await save({ paybox: PAYBOX, bit: '' })).body.content.payLinks, { paybox: PAYBOX });
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047', paybox: PAYBOX });
  assert.equal((await save(null)).body.content.payLinks, undefined);
  assert.deepEqual((await call('/api/config')).body.transfer, { phone: '058-434-4047' });
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
