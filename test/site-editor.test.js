// The admin panel's "האתר" tab on Cloudflare: David's texts, treatments, prices and photos
// (worker/content.js, public/js/site-content.js), the photos he uploads, the notices at the
// top of the site, and how all of it gets into the pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWorker } from '../worker/index.js';
import { cleanJpeg } from '../worker/content.js';
import { hashCode } from '../worker/passkeys.js';
import { DEFAULT_GALLERY } from '../public/js/site-content.js';
import { fakeD1 } from './support/fake-d1.js';
import { fakeKV } from './support/fake-kv.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };
const SITE = 'https://clinic.example';
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

const PAGES = {
  '/': `<!doctype html><html><head><title>x</title></head><body>
<img data-photo="hero" src="images/room.jpg" srcset="images/room-640.jpg 640w, images/room.jpg 960w, images/room-1440.jpg 1440w" sizes="46vw" alt="" width="960" height="1200" loading="lazy">
<img data-photo="about" src="images/about.jpg" srcset="images/about.jpg 900w" alt="דוד נאמן בקליניקה" width="900" height="1125" loading="lazy">
</body></html>`,
  '/book': '<!doctype html><html><head><title>book</title></head><body>book</body></html>',
};

function setup({ db = fakeD1(), media = fakeKV() } = {}) {
  let now = new Date('2026-10-01T05:00:00Z'); // Thursday 1 Oct 2026, 08:00 in Israel
  const assets = [];
  const env = {
    DB: db,
    MEDIA: media,
    BOOKING_MODE: 'transfer',
    ASSETS: {
      async fetch(request) {
        const req = request instanceof Request ? request : new Request(request);
        assets.push(req);
        // A browser's "I have this version" would get a 304 without a body.
        if (req.headers.get('If-None-Match')) return new Response(null, { status: 304 });
        const body = PAGES[new URL(req.url).pathname];
        return body
          ? new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"v1"', 'Cache-Control': 'public, max-age=0, must-revalidate' } })
          : new Response('not found', { status: 404 });
      },
    },
  };
  const worker = createWorker({ config, clock: () => now, log: silent });
  const call = async (path, { method = 'GET', body, cookie, headers = {}, raw } = {}) => {
    const h = { ...headers, ...(cookie ? { Cookie: cookie } : {}) };
    if (body !== undefined) h['Content-Type'] ??= 'application/json';
    const res = await worker.fetch(
      new Request(`${SITE}${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
      env,
      { waitUntil() {} },
    );
    const type = res.headers.get('Content-Type') || '';
    const data = /json/.test(type) ? await res.json() : /image/.test(type) ? new Uint8Array(await res.arrayBuffer()) : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  };
  const signIn = async () => {
    db.raw.prepare("INSERT INTO admins (name, handle) VALUES ('דוד', 'h1')").run();
    db.raw.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, 1, ?)').run(await hashCode('session-token'), '2026-12-01T00:00:00.000Z');
    return '__Host-admin=session-token';
  };
  const save = (cookie, patch) => call('/api/admin/content', { method: 'PUT', body: patch, cookie });
  const upload = (cookie, slot, id, width, bytes, headers = {}) =>
    call(`/api/admin/media/${slot}/${id}/${width}`, { method: 'PUT', raw: bytes, cookie, headers: { 'Content-Type': 'image/jpeg', Origin: SITE, ...headers } });
  return {
    env,
    call,
    signIn,
    save,
    upload,
    assets,
    worker,
    advance: (hours) => (now = new Date(now.getTime() + hours * 3_600_000)),
    at: (iso) => (now = new Date(iso)),
  };
}

/** A small JPEG as a phone makes it: EXIF with the location, IPTC, a comment, a second image after the end. */
function phoneJpeg(width, height, { extra = true } = {}) {
  const seg = (marker, payload) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(extra ? seg(0xe1, [...ascii('Exif\0\0'), ...ascii('GPS 32.0853N 34.7818E iPhone 15 Pro')]) : []),
    ...seg(0xe2, [...ascii('ICC_PROFILE\0'), 1, 1, 9, 9, 9]),
    ...(extra ? seg(0xe2, [...ascii('MPF\0'), 1, 2, 3]) : []),
    ...(extra ? seg(0xed, [...ascii('Photoshop 3.0\0'), ...ascii('IPTC city')]) : []),
    ...(extra ? seg(0xfe, ascii('taken at home')) : []),
    ...seg(0xdb, [0, ...Array(64).fill(1)]),
    ...seg(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...seg(0xc4, [0, ...Array(16).fill(0)]),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a,
    0xff, 0xd9,
    ...(extra ? [...ascii('MPF gain map'), 0xff, 0xd8, 0xff, 0xd9] : []),
  ]);
}

const ID = 'abcdefghijklmnop';
const ID2 = 'qrstuvwxyz234567';
const sizes = { hero: [[640, 800], [1080, 1350], [1600, 2000]], service: [[300, 300], [700, 700], [1200, 1200]], gallery: [[720, 900], [1080, 1350], [1600, 2000]] };
async function uploadAll(ctx, cookie, slot, id) {
  for (const [w, h] of sizes[slot]) assert.equal((await ctx.upload(cookie, slot, id, w, phoneJpeg(w, h))).status, 201);
}
const pageData = (html) => JSON.parse(/<script type="application\/json" id="site-data">([^<]*)<\/script>/.exec(html)[1]);

// ---------------------------------------------------------------------------

test('JPEG cleaning: the location, the camera and anything after the picture are left out', () => {
  const out = cleanJpeg(phoneJpeg(640, 800));
  assert.deepEqual([out.width, out.height], [640, 800]);
  for (const gone of ['Exif', 'GPS', 'iPhone', 'Photoshop', 'IPTC', 'taken at home', 'MPF']) assert.ok(!has(out.bytes, gone), `${gone} is gone`);
  assert.ok(has(out.bytes, 'ICC_PROFILE') && has(out.bytes, 'JFIF'), 'the color profile and JFIF stay');
  assert.deepEqual([...out.bytes.slice(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...out.bytes.slice(-2)], [0xff, 0xd9]);
  // The picture's own data is untouched (a stuffed FF and a restart marker included).
  assert.ok(Buffer.from(out.bytes).includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a, 0xff, 0xd9])));
  // A clean one comes out the same.
  const clean = phoneJpeg(640, 800, { extra: false });
  assert.deepEqual(cleanJpeg(clean).bytes, clean);
  // Not a JPEG, cut short, or without a picture in it: refused.
  assert.equal(cleanJpeg(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(cleanJpeg(phoneJpeg(640, 800).slice(0, 60)), null);
  assert.equal(cleanJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null);
});

test('the editor needs David signed in, and uploads come only from the site itself', async () => {
  const ctx = setup();
  for (const [path, method] of [
    ['/api/admin/content', 'GET'],
    ['/api/admin/content', 'PUT'],
    ['/api/admin/notices', 'GET'],
    ['/api/admin/notices', 'POST'],
    ['/api/admin/notices/1', 'PUT'],
    ['/api/admin/notices/1', 'DELETE'],
  ]) {
    assert.equal((await ctx.call(path, { method, body: method === 'GET' ? undefined : {} })).status, 401, `${method} ${path}`);
  }
  assert.equal((await ctx.upload(null, 'hero', ID, 640, phoneJpeg(640, 800))).status, 401);
  const me = await ctx.signIn();
  assert.equal((await ctx.upload(me, 'hero', ID, 640, phoneJpeg(640, 800), { Origin: 'https://evil.example' })).status, 403);
  assert.equal(ctx.env.MEDIA.items.size, 0);
  // Changing content sends JSON (a page on another site can't, without asking first).
  assert.equal((await ctx.call('/api/admin/content', { method: 'PUT', raw: 'texts=1', cookie: me, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
});

test('texts: kept cleaned up and checked; null puts the original back; only what is sent changes', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  // Nothing is kept when one field is wrong.
  const bad = await ctx.save(me, { texts: { 'about.quote': 'ציטוט', 'hero.titleA': 'א'.repeat(31), 'meta.description': 'x', 'about.title': '   ' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.fields.sort(), ['texts.about.title', 'texts.hero.titleA', 'texts.meta.description']);
  assert.deepEqual((await ctx.call('/api/admin/content', { cookie: me })).body.content, {});

  const ok = await ctx.save(me, { texts: { 'about.quote': '  ״חשוב   לי״\n\n\n\nשורה‮ שנייה  ', 'hero.titleA': 'טיפולי\nגוף', 'about.p3': '' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.content.texts, { 'about.quote': '״חשוב לי״\n\nשורה שנייה', 'hero.titleA': 'טיפולי גוף', 'about.p3': '' });
  // Another save of one text leaves the others.
  await ctx.save(me, { texts: { 'contact.title': 'דברו איתי' } });
  const kept = (await ctx.call('/api/admin/content', { cookie: me })).body;
  assert.equal(kept.content.texts['about.quote'], '״חשוב לי״\n\nשורה שנייה');
  assert.equal(kept.content.texts['contact.title'], 'דברו איתי');
  assert.equal(kept.defaults.prices.pack, 1200);
  assert.equal(kept.media, true);
  // null: back to the original.
  await ctx.save(me, { texts: { 'about.quote': null, 'hero.titleA': null, 'about.p3': null, 'contact.title': null } });
  assert.deepEqual((await ctx.call('/api/admin/content', { cookie: me })).body.content, {});
});

test('treatments and prices: on the site, in the booking and in what the client is asked to pay', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  assert.equal((await ctx.save(me, { services: { nope: { name: 'x' } } })).status, 400);
  assert.deepEqual((await ctx.save(me, { prices: { session: -1, packSessions: 4, pack: 1200 } })).body.fields, ['prices.session']);
  assert.deepEqual((await ctx.save(me, { prices: { session: 380 } })).body.fields, ['prices.packSessions', 'prices.pack']);
  assert.deepEqual((await ctx.save(me, { services: { stress: { name: 'א' } } })).body.fields, ['services.stress.name']);

  const saved = await ctx.save(me, {
    services: { stress: { name: 'דיקור סטרס וחרדה', description: 'תיאור חדש.\nשורה שנייה' } },
    prices: { session: 380, packSessions: 5, pack: 1500 },
  });
  assert.equal(saved.status, 200);
  const cfg = (await ctx.call('/api/config')).body;
  const stress = cfg.services.find((s) => s.id === 'stress');
  assert.equal(stress.name.he, 'דיקור סטרס וחרדה');
  assert.equal(stress.name.en, 'Acupuncture for stress', 'the English name stays');
  assert.equal(stress.description.he, 'תיאור חדש.\nשורה שנייה');
  assert.ok(cfg.services.every((s) => s.price === 380));
  assert.deepEqual(cfg.prices.pack, { sessions: 5, price: 1500 });
  assert.equal(cfg.prices.session.price, 380);

  const book = (plan, time) =>
    ctx.call('/api/bookings', {
      method: 'POST',
      body: { serviceId: 'stress', date: '2026-10-04', time, name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan },
    });
  assert.equal((await book('single', '12:30')).body.booking.price, 380);
  const pack = (await book('pack', '14:00')).body.booking;
  assert.equal(pack.price, 1500);
  const list = (await ctx.call('/api/admin/bookings?scope=upcoming', { cookie: me })).body.bookings;
  const approved = await ctx.call(`/api/admin/bookings/${list.find((b) => b.ref === pack.ref).id}/approve`, { method: 'POST', body: {}, cookie: me });
  assert.equal(approved.body.cardLeft, 4, 'his card of 5: this session and 4 more');

  // Back to the original.
  await ctx.save(me, { services: { stress: { name: null, description: null } }, prices: null });
  const again = (await ctx.call('/api/config')).body;
  assert.equal(again.services.find((s) => s.id === 'stress').name.he, 'דיקור סטרס');
  assert.deepEqual(again.prices.pack, { sessions: 4, price: 1200 });
});

test('photos: the site’s own that fit the place, or uploads that are there in every size', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  assert.equal((await ctx.save(me, { photos: { hero: { builtin: 'gal-1' } } })).status, 400, 'a gallery photo is not an arch photo');
  assert.equal((await ctx.save(me, { photos: { hero: { upload: 'short' } } })).status, 400);
  assert.equal((await ctx.save(me, { photos: { hero: { upload: ID, src: 'https://evil.example/x.jpg' } } })).status, 400);
  assert.equal((await ctx.save(me, { photos: { footer: { builtin: 'room' } } })).status, 400);

  assert.equal((await ctx.save(me, { photos: { hero: { builtin: 'david-2' } } })).status, 200);
  let html = (await ctx.call('/')).body;
  assert.match(html, /<img data-photo="hero" src="images\/david-2\.jpg" srcset="images\/david-2-640\.jpg 640w, images\/david-2\.jpg 960w, images\/david-2-1440\.jpg 1440w"/);

  // An upload must be there in all three sizes before the site uses it.
  assert.deepEqual((await ctx.save(me, { photos: { hero: { upload: ID } } })).body.fields, ['photo_missing']);
  assert.equal((await ctx.upload(me, 'hero', ID, 640, phoneJpeg(640, 800))).status, 201);
  assert.equal((await ctx.upload(me, 'hero', ID, 1080, phoneJpeg(1080, 1350))).status, 201);
  assert.deepEqual((await ctx.save(me, { photos: { hero: { upload: ID } } })).body.fields, ['photo_missing']);
  assert.equal((await ctx.upload(me, 'hero', ID, 1600, phoneJpeg(1600, 2000))).status, 201);
  assert.equal((await ctx.save(me, { photos: { hero: { upload: ID } }, aboutAlt: 'דוד "בקליניקה" <b>' })).status, 200);

  html = (await ctx.call('/')).body;
  assert.match(html, new RegExp(`<img data-photo="hero" src="/media/${ID}-1080\\.jpg" srcset="/media/${ID}-640\\.jpg 640w, /media/${ID}-1080\\.jpg 1080w, /media/${ID}-1600\\.jpg 1600w" sizes="46vw" alt="" width="1080" height="1350"`));
  assert.match(html, /alt="דוד &quot;בקליניקה&quot; &lt;b&gt;"/, 'the description is written safely');
  // A treatment photo goes into its card's sizes.
  await uploadAll(ctx, me, 'service', ID2);
  await ctx.save(me, { services: { 'dry-needling': { photo: { upload: ID2 } } } });
  const dry = (await ctx.call('/api/config')).body.services.find((s) => s.id === 'dry-needling');
  assert.equal(dry.image, `/media/${ID2}-700.jpg`);
  assert.deepEqual(dry.imageSet, { 300: `/media/${ID2}-300.jpg`, 700: `/media/${ID2}-700.jpg`, 1200: `/media/${ID2}-1200.jpg` });
});

test('uploads: JPEGs only, in the size the place takes, kept without the phone’s metadata', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  assert.equal((await ctx.upload(me, 'hero', ID, 640, phoneJpeg(640, 800), { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await ctx.upload(me, 'hero', ID, 640, new TextEncoder().encode('<svg onload=alert(1)>'))).status, 400);
  assert.deepEqual((await ctx.upload(me, 'hero', ID, 640, phoneJpeg(640, 640))).body.fields, ['size']);
  assert.equal((await ctx.upload(me, 'hero', ID, 700, phoneJpeg(700, 875))).status, 400, 'not a size the arch uses');
  // (a place that doesn't exist isn't an upload: it's refused like any request that isn't JSON)
  assert.equal((await ctx.call(`/api/admin/media/footer/${ID}/640`, { method: 'PUT', raw: phoneJpeg(640, 800), cookie: me, headers: { 'Content-Type': 'image/jpeg' } })).status, 415);
  const huge = new Uint8Array(2_000_000);
  huge.set(phoneJpeg(640, 800));
  assert.equal((await ctx.upload(me, 'hero', ID, 640, huge)).status, 413);
  assert.equal(ctx.env.MEDIA.items.size, 0);

  const ok = await ctx.upload(me, 'hero', ID, 640, phoneJpeg(640, 800));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.url, `/media/${ID}-640.jpg`);
  const kept = ctx.env.MEDIA.items.get(`${ID}-640`);
  assert.ok(!has(kept.bytes, 'GPS') && !has(kept.bytes, 'Exif') && !has(kept.bytes, 'MPF'));
  assert.equal(kept.metadata.w, 640);
  assert.equal(kept.metadata.created, '2026-10-01T05:00:00.000Z');

  const photo = await ctx.call(`/media/${ID}-640.jpg`);
  assert.equal(photo.status, 200);
  assert.deepEqual(photo.body, kept.bytes);
  assert.equal(photo.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(photo.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(photo.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(photo.headers.get('Content-Security-Policy'), /sandbox/);
  const head = await ctx.call(`/media/${ID}-640.jpg`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await ctx.call(`/media/${ID2}-640.jpg`)).status, 404);
});

test('gallery: his order, descriptions and photos; null puts the original back', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  assert.equal((await ctx.save(me, { gallery: [] })).status, 400);
  assert.equal((await ctx.save(me, { gallery: Array.from({ length: 25 }, () => ({ photo: { builtin: 'gal-1' }, alt: '' })) })).status, 400);
  assert.deepEqual((await ctx.save(me, { gallery: [{ photo: { builtin: 'room' }, alt: 'x' }] })).body.fields, ['gallery.0']);
  assert.deepEqual((await ctx.save(me, { gallery: [{ photo: { builtin: 'gal-1' }, alt: 'א'.repeat(161) }] })).body.fields, ['gallery.0']);

  await uploadAll(ctx, me, 'gallery', ID);
  const saved = await ctx.save(me, { gallery: [{ photo: { builtin: 'gal-3' }, alt: '  דיקור בגב ' }, { photo: { upload: ID } }] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.content.gallery, [
    { photo: { builtin: 'gal-3' }, alt: 'דיקור בגב' },
    { photo: { upload: ID }, alt: '' },
  ]);
  assert.deepEqual(pageData((await ctx.call('/')).body).content.gallery, saved.body.content.gallery);
  assert.deepEqual((await ctx.save(me, { gallery: null })).body.content, {});
});

test('the pages: his content goes in before </head> as data that can’t run, never cached old', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  await ctx.save(me, { texts: { 'about.quote': '</script><script>alert(1)</script><!--' } });
  const page = await ctx.call('/', { headers: { 'If-None-Match': '"v1"' } });
  assert.equal(page.status, 200, 'his newest content, even to a browser that has an older page');
  assert.ok(!ctx.assets.at(-1).headers.has('If-None-Match'));
  assert.equal(page.headers.get('Cache-Control'), 'no-cache');
  assert.equal(page.headers.get('ETag'), null);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.ok(!page.body.includes('</script><script>alert(1)'), 'the text can’t close the data block');
  assert.equal(pageData(page.body).content.texts['about.quote'], '</script><script>alert(1)</script><!--');
  assert.ok(page.body.indexOf('id="site-data"') < page.body.indexOf('</head>'));

  const book = await ctx.call('/book');
  assert.deepEqual(pageData(book.body).content.texts, { 'about.quote': '</script><script>alert(1)</script><!--' });
  const head = await ctx.call('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  // Other paths are the site's files as they are.
  assert.equal((await ctx.call('/admin')).status, 404);
});

test('the pages still open when the database doesn’t answer', async () => {
  const broken = fakeD1();
  broken.batch = async () => {
    throw new Error('D1 is down');
  };
  const ctx = setup({ db: broken });
  const page = await ctx.call('/');
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes('site-data'));
  assert.match(page.body, /<img data-photo="hero" src="images\/room\.jpg"/);
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

const notice = (ctx, cookie, body) => ctx.call('/api/admin/notices', { method: 'POST', body: { kind: 'info', active: true, ...body }, cookie });

test('notices: checked when saved', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  const fields = async (body) => (await notice(ctx, me, body)).body.fields;
  assert.deepEqual(await fields({ kind: 'party', text: 'שלום' }), ['kind']);
  assert.deepEqual(await fields({ text: 'א' }), ['text']);
  assert.deepEqual(await fields({ text: 'א'.repeat(281) }), ['text']);
  assert.deepEqual(await fields({ text: 'שלום', startsAt: '2026-10-05 10:00' }), ['startsAt']);
  assert.deepEqual(await fields({ text: 'שלום', startsAt: '2026-10-05T10:00', endsAt: '2026-10-05T09:00' }), ['endsAt']);
  assert.deepEqual(await fields({ text: 'שלום', startsAt: '2029-10-05T10:00' }), ['startsAt']);
  assert.deepEqual(await fields({ text: 'שלום', closeFrom: '2026-10-05' }), ['closeTo']);
  assert.deepEqual(await fields({ text: 'שלום', closeFrom: '2026-10-05', closeTo: '2026-10-04' }), ['closeTo']);
  assert.deepEqual(await fields({ text: 'שלום', closeFrom: '2026-10-05', closeTo: '2027-10-06' }), ['closeTo']);
  assert.equal((await ctx.call('/api/admin/notices/99', { method: 'PUT', body: { kind: 'info', text: 'שלום' }, cookie: me })).status, 404);
  assert.equal((await ctx.call('/api/admin/notices/99', { method: 'DELETE', body: {}, cookie: me })).status, 404);
  assert.deepEqual((await ctx.call('/api/admin/notices', { cookie: me })).body.notices, []);

  // The times are the clinic's (Israel), kept in UTC.
  const made = await notice(ctx, me, { kind: 'news', text: '  חדש:\nעיסוי   לימפטי ', startsAt: '2026-10-05T10:00', endsAt: '2026-10-20T18:30' });
  assert.equal(made.status, 201);
  assert.equal(made.body.notice.text, 'חדש: עיסוי לימפטי');
  assert.equal(made.body.notice.starts_at, '2026-10-05T07:00:00.000Z');
  assert.equal(made.body.notice.ends_at, '2026-10-20T15:30:00.000Z');
});

test('notices: shown while they’re on, the important ones first, three at most', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  const shown = async () => (await ctx.call('/api/site')).body.notices.map((n) => n.text);
  await notice(ctx, me, { text: 'עדכון רגיל' });
  await notice(ctx, me, { kind: 'news', text: 'חדש מחר', startsAt: '2026-10-02T08:00' });
  await notice(ctx, me, { kind: 'alert', text: 'סגור עד הצהריים', endsAt: '2026-10-01T10:00' });
  await notice(ctx, me, { text: 'מושהית', active: false });
  assert.deepEqual(await shown(), ['סגור עד הצהריים', 'עדכון רגיל']);
  assert.deepEqual(pageData((await ctx.call('/')).body).notices.map((n) => [n.kind, n.text]), [['alert', 'סגור עד הצהריים'], ['info', 'עדכון רגיל']]);
  ctx.advance(3); // 11:00 in Israel: the alert ended
  assert.deepEqual(await shown(), ['עדכון רגיל']);
  ctx.advance(24); // the next day: the news is on
  assert.deepEqual(await shown(), ['חדש מחר', 'עדכון רגיל']);
  await notice(ctx, me, { text: 'עוד אחת' });
  await notice(ctx, me, { text: 'ועוד אחת' });
  assert.equal((await shown()).length, 3);

  // Paused and edited: a notice keeps its id, its text changes, and so does its version (so a
  // visitor who closed the old one sees the new one).
  const list = (await ctx.call('/api/admin/notices', { cookie: me })).body.notices;
  assert.deepEqual(list.map((n) => n.text), ['ועוד אחת', 'עוד אחת', 'מושהית', 'סגור עד הצהריים', 'חדש מחר', 'עדכון רגיל'], 'newest first');
  const regular = list.find((n) => n.text === 'עדכון רגיל');
  const edited = await ctx.call(`/api/admin/notices/${regular.id}`, { method: 'PUT', body: { kind: 'alert', text: 'עדכון חדש', active: true }, cookie: me });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.notice.id, regular.id);
  assert.ok(edited.body.notice.updated_at >= regular.updated_at);
  assert.equal((await shown())[0], 'עדכון חדש', 'now important: first');
  assert.equal((await ctx.call(`/api/admin/notices/${regular.id}`, { method: 'DELETE', body: {}, cookie: me })).status, 200);
  assert.ok(!(await shown()).includes('עדכון חדש'));
});

test('a notice can close the calendar on chosen days; they open again with it', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  const slots = async (date) => (await ctx.call(`/api/availability?service=stress&from=${date}&to=${date}`)).body.days[date];
  assert.ok((await slots('2026-10-04')).length > 0);
  // A day he closed by hand stays closed, whatever the notices do.
  await ctx.call('/api/admin/blocked', { method: 'POST', body: { date: '2026-10-06', note: 'חופש' }, cookie: me });

  const closing = await notice(ctx, me, { kind: 'alert', text: 'הקליניקה סגורה עד יום שני', closeFrom: '2026-10-01', closeTo: '2026-10-06' });
  assert.equal(closing.status, 201);
  for (const d of ['2026-10-01', '2026-10-04', '2026-10-05', '2026-10-06']) assert.deepEqual(await slots(d), [], `${d} closed`);
  assert.ok((await slots('2026-10-07')).length > 0, 'the day after is open');
  const blocked = (await ctx.call('/api/admin/schedule', { cookie: me })).body.blocked;
  assert.deepEqual(
    blocked.map((b) => [b.date, b.notice_id]),
    [['2026-10-01', 1], ['2026-10-02', 1], ['2026-10-03', 1], ['2026-10-04', 1], ['2026-10-05', 1], ['2026-10-06', null]],
  );
  assert.deepEqual((await ctx.call('/api/config')).body.closedDays, ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  const booking = await ctx.call('/api/bookings', {
    method: 'POST',
    body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'נועה כהן', phone: '050-123-4567', consent: true, lang: 'he', plan: 'single' },
  });
  assert.equal(booking.status, 409, 'no booking on a closed day');

  // A second notice over some of the same days keeps them closed when the first goes.
  await notice(ctx, me, { text: 'השתלמות', closeFrom: '2026-10-05', closeTo: '2026-10-08' });
  const pause = (n, active) => ctx.call(`/api/admin/notices/${n.id}`, { method: 'PUT', body: { kind: n.kind, text: n.text, closeFrom: n.close_from, closeTo: n.close_to, active }, cookie: me });
  await pause(closing.body.notice, false);
  assert.ok((await slots('2026-10-04')).length > 0, 'paused: open again');
  assert.deepEqual(await slots('2026-10-05'), [], 'still closed by the second notice');
  await pause(closing.body.notice, true);
  assert.deepEqual(await slots('2026-10-04'), []);
  await ctx.call(`/api/admin/notices/${closing.body.notice.id}`, { method: 'DELETE', body: {}, cookie: me });
  assert.ok((await slots('2026-10-04')).length > 0, 'deleted: open again');
  assert.deepEqual(
    (await ctx.call('/api/admin/schedule', { cookie: me })).body.blocked.map((b) => [b.date, b.notice_id]),
    [['2026-10-05', 2], ['2026-10-06', null], ['2026-10-07', 2], ['2026-10-08', 2]],
  );
  // Closing one of its days by hand makes the day his.
  await ctx.call('/api/admin/blocked', { method: 'POST', body: { date: '2026-10-07', note: 'שלי' }, cookie: me });
  await ctx.call('/api/admin/notices/2', { method: 'DELETE', body: {}, cookie: me });
  assert.deepEqual((await ctx.call('/api/admin/schedule', { cookie: me })).body.blocked.map((b) => b.date), ['2026-10-06', '2026-10-07']);
});

test('the GitHub Pages copy may read the site’s content; other sites may not', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  await ctx.save(me, { texts: { 'about.quote': 'ציטוט חדש' } });
  await notice(ctx, me, { kind: 'alert', text: 'סגור', closeFrom: '2026-10-04', closeTo: '2026-10-04' });
  const ours = await ctx.call('/api/site', { headers: { Origin: 'https://davidneeman.github.io' } });
  assert.equal(ours.headers.get('Access-Control-Allow-Origin'), 'https://davidneeman.github.io');
  assert.equal(ours.body.content.texts['about.quote'], 'ציטוט חדש');
  assert.deepEqual(ours.body.notices.map((n) => n.text), ['סגור']);
  assert.deepEqual(ours.body.closed, ['2026-10-04']);
  assert.equal(ours.body.schedule.maxDaysAhead, 30);
  const theirs = await ctx.call('/api/site', { headers: { Origin: 'https://evil.example' } });
  assert.equal(theirs.headers.get('Access-Control-Allow-Origin'), null);
});

test('once a day, uploads nothing uses any more are deleted (not the ones in use, not new ones)', async () => {
  const ctx = setup();
  const me = await ctx.signIn();
  await uploadAll(ctx, me, 'hero', ID); // in use
  await ctx.save(me, { photos: { hero: { upload: ID } } });
  await uploadAll(ctx, me, 'gallery', ID2); // never used
  const scheduled = (iso) => createWorker({ config, clock: () => new Date(iso), log: silent }).scheduled({}, ctx.env);
  await scheduled('2026-10-02T02:05:00Z'); // a day later: too new to delete
  assert.equal(ctx.env.MEDIA.items.size, 6);
  await scheduled('2026-10-05T11:05:00Z'); // not the hour for it
  assert.equal(ctx.env.MEDIA.items.size, 6);
  await scheduled('2026-10-05T02:05:00Z');
  assert.deepEqual([...ctx.env.MEDIA.items.keys()].sort(), [`${ID}-1080`, `${ID}-1600`, `${ID}-640`]);
});

test('the home page’s gallery and photos match what the editor knows', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const alts = [...html.matchAll(/<button class="mosaic-item" type="button" data-large="images\/large\/(gal-\d)\.jpg"><img [^>]*alt="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(
    alts,
    DEFAULT_GALLERY.map((g) => [g.photo.builtin, g.alt]),
  );
  assert.match(html, /<img data-photo="hero" src="images\/room\.jpg" srcset="images\/room-640\.jpg 640w, images\/room\.jpg 960w, images\/room-1440\.jpg 1440w"/);
  assert.match(html, /<img data-photo="about" src="images\/about\.jpg" srcset="images\/about\.jpg 900w, images\/about-1350\.jpg 1350w, images\/about-1800\.jpg 1800w"/);
});
