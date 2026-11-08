// The practitioner's iCloud calendar (worker/calendar.js): reading busy times, writing a
// booking, and the Worker using both – against a small stand-in CalDAV server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bookingIcs, busyFromIcs, zonedToUtc } from '../worker/calendar.js';
import { createWorker } from '../worker/index.js';
import { fakeD1 } from './support/fake-d1.js';

const TZ = 'Asia/Jerusalem';
const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
const silent = { info() {}, error() {}, warn() {} };

const cal = (...events) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iCloud//EN\r\n${events
    .map((e) => `BEGIN:VEVENT\r\nDTSTAMP:20261001T000000Z\r\n${e}\r\nEND:VEVENT\r\n`)
    .join('')}END:VCALENDAR\r\n`;

test('Israel time to UTC, summer and winter', () => {
  assert.equal(zonedToUtc('2026-07-01', '10:00', TZ).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(zonedToUtc('2026-11-05', '10:00', TZ).toISOString(), '2026-11-05T08:00:00.000Z');
  assert.equal(zonedToUtc('2027-03-26', '12:00', TZ).toISOString(), '2027-03-26T09:00:00.000Z'); // the day summer time starts
});

test('busy times: what blocks, what does not', () => {
  const busy = busyFromIcs(
    [
      cal('UID:a\r\nDTSTART;TZID=Asia/Jerusalem:20261104T103000\r\nDTEND;TZID=Asia/Jerusalem:20261104T120000'),
      cal('UID:b\r\nDTSTART:20261103T200000Z\r\nDTEND:20261103T230000Z'), // 22:00–01:00 in Israel
      cal('UID:c\r\nDTSTART:20261104T150000Z\r\nDURATION:PT45M'),
      cal('UID:d\r\nDTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261112'), // a busy all-day event: closed
      cal('UID:e\r\nDTSTART;VALUE=DATE:20261115\r\nDTEND;VALUE=DATE:20261116\r\nTRANSP:TRANSPARENT'), // shown as free
      cal('UID:f\r\nDTSTART;TZID=Asia/Jerusalem:20261105T090000\r\nDTEND;TZID=Asia/Jerusalem:20261105T100000\r\nTRANSP:TRANSPARENT'),
      cal('UID:g\r\nDTSTART;TZID=Asia/Jerusalem:20261105T130000\r\nDTEND;TZID=Asia/Jerusalem:20261105T140000\r\nSTATUS:CANCELLED'),
      cal('UID:h\r\nDTSTART;TZID=Asia/Jerusalem:20261106T100000\r\nDTEND;TZID=Asia/Jerusalem:20261106T110000\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nEND:VALARM'),
      'not a calendar at all',
    ],
    { from: '2026-11-01', to: '2026-11-30', tz: TZ },
  );
  assert.deepEqual(new Set(busy['2026-11-04'].map((r) => `${r.start}-${r.end}`)), new Set(['0-60', '630-720', '1020-1065']));
  assert.deepEqual(busy['2026-11-03'], [{ start: 1320, end: 1440 }]);
  assert.equal(busy['2026-11-10'], 'all');
  assert.equal(busy['2026-11-11'], 'all');
  assert.equal(busy['2026-11-12'], undefined);
  assert.equal(busy['2026-11-15'], undefined);
  assert.equal(busy['2026-11-05'], undefined);
  assert.deepEqual(busy['2026-11-06'], [{ start: 600, end: 660 }]);
});

test('busy times: repeats the server did not expand (daily since years, weekly with a skipped and a moved day)', () => {
  const busy = busyFromIcs(
    [
      cal('UID:daily\r\nDTSTART;TZID=Asia/Jerusalem:20160103T080000\r\nDTEND;TZID=Asia/Jerusalem:20160103T083000\r\nRRULE:FREQ=DAILY'),
      cal(
        'UID:wk\r\nDTSTART;TZID=Asia/Jerusalem:20250106T180000\r\nDTEND;TZID=Asia/Jerusalem:20250106T190000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEXDATE;TZID=Asia/Jerusalem:20261104T180000',
        'UID:wk\r\nRECURRENCE-ID;TZID=Asia/Jerusalem:20261109T180000\r\nDTSTART;TZID=Asia/Jerusalem:20261109T200000\r\nDTEND;TZID=Asia/Jerusalem:20261109T210000',
      ),
      cal('UID:few\r\nDTSTART;TZID=Asia/Jerusalem:20261101T120000\r\nDTEND;TZID=Asia/Jerusalem:20261101T130000\r\nRRULE:FREQ=DAILY;COUNT=3'),
    ],
    { from: '2026-11-01', to: '2026-11-30', tz: TZ },
  );
  const has = (d, s, e) => (busy[d] || []).some((r) => r.start === s && r.end === e);
  for (const d of ['2026-11-01', '2026-11-15', '2026-11-30']) assert.ok(has(d, 480, 510), `daily on ${d}`);
  assert.ok(has('2026-11-02', 1080, 1140), 'Monday');
  assert.ok(!has('2026-11-04', 1080, 1140), 'the skipped Wednesday');
  assert.ok(has('2026-11-11', 1080, 1140), 'Wednesday');
  assert.ok(!has('2026-11-09', 1080, 1140) && has('2026-11-09', 1200, 1260), 'the moved Monday');
  assert.ok(!has('2026-11-10', 1080, 1140), 'Tuesday is free');
  assert.ok(has('2026-11-03', 720, 780) && !has('2026-11-04', 720, 780), 'COUNT=3 ends after three days');
});

test('a booking as an iCalendar event: UTC times, escaped text, folded lines', () => {
  const ics = bookingIcs({
    booking: { ref: 'ABC234', date: '2026-11-05', time: '10:00', duration: 60, name: 'דנה לוי', phone: '0501234567', email: 'dana@example.com', notes: 'כאב גב, בעיקר בבוקר; ' + 'מ'.repeat(60), price: 350 },
    serviceName: 'דיקור מערבי יבש',
    tz: TZ,
    now: new Date('2026-10-01T05:00:00Z'),
  });
  assert.match(ics, /\r\nDTSTART:20261105T080000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261105T090000Z\r\n/);
  assert.match(ics, /\r\nUID:booking-ABC234@clinic\r\n/);
  assert.match(ics, /SUMMARY:דנה לוי – דיקור מערבי יבש/);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /הערות: כאב גב\\, בעיקר בבוקר\\; /);
  assert.match(unfolded, /\\nשולם באתר: 350 ₪\\nמספר אישור: ABC234/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
});

// ---------- The Worker with a stand-in CalDAV server ----------

function fakeCalDav({ user, password, events = [] }) {
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const calendars = new Map([['/1/calendars/home/', 'בית']]);
  const puts = new Map();
  const calls = [];
  const multistatus = (inner) =>
    new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, {
      status: 207,
      headers: { 'Content-Type': 'application/xml' },
    });
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, host: u.host, path: u.pathname });
    if (u.host === 'evil.test') return new Response('', { status: 500 });
    if (init.headers?.Authorization !== auth) return new Response('', { status: 401 });
    if (method === 'PROPFIND' && u.pathname === '/') {
      return multistatus('<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/1/principal/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>');
    }
    if (method === 'PROPFIND' && u.pathname === '/1/principal/') {
      return multistatus('<d:response><d:href>/1/principal/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/1/calendars/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>');
    }
    if (method === 'PROPFIND' && u.pathname === '/1/calendars/') {
      const rows = [
        '<d:response><d:href>/1/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>',
        '<d:response><d:href>/1/calendars/tasks/</d:href><d:propstat><d:prop><d:displayname>תזכורות</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>',
        ...[...calendars].map(([href, name]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>`),
      ];
      return multistatus(rows.join(''));
    }
    if (method === 'MKCALENDAR') throw new TypeError('Invalid HTTP method string: MKCALENDAR'); // as on Cloudflare
    if (method === 'MKCOL') {
      if (!/<c:calendar\/>/.test(init.body)) return new Response('', { status: 403 });
      const name = /<d:displayname>([^<]*)<\/d:displayname>/.exec(init.body)?.[1];
      calendars.set(u.pathname, name);
      return new Response('', { status: 201 });
    }
    if (method === 'REPORT') {
      const own = u.pathname === '/1/calendars/home/' ? events : [...puts].filter(([p]) => p.startsWith(u.pathname)).map(([, b]) => b);
      return multistatus(own.map((text, i) => `<d:response><d:href>${u.pathname}${i}.ics</d:href><d:propstat><d:prop><cal:calendar-data>${escape(text)}</cal:calendar-data></d:prop></d:propstat></d:response>`).join(''));
    }
    if (method === 'PUT') {
      if (puts.has(u.pathname)) return new Response('', { status: 412 });
      puts.set(u.pathname, init.body);
      return new Response('', { status: 201 });
    }
    return new Response('', { status: 405 });
  }
  return { fetchImpl, calendars, puts, calls };
}

function setup(user, events) {
  const dav = fakeCalDav({ user, password: 'abcd-efgh-ijkl-mnop', events });
  const env = {
    DB: fakeD1(),
    BOOKING_MODE: 'online',
    ICLOUD_USER: user,
    ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
    CALDAV_URL: 'https://caldav.test',
    CALENDAR_NAME: 'קליניקה',
  };
  const worker = createWorker({ config, clock: () => new Date('2026-10-01T05:00:00Z'), fetch: dav.fetchImpl, log: silent });
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await worker.fetch(
      new Request(`https://clinic.example${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
      ctx,
    );
    return { status: res.status, body: await res.json() };
  };
  return { dav, env, worker, call, settle: () => Promise.all(waits) };
}

test('times taken in his calendar are not offered', async () => {
  // Sunday 4 Oct: a personal appointment 14:00–15:00 (11:00–12:00 UTC).
  const { call } = setup('busy@example.com', [cal('UID:p1\r\nDTSTART:20261004T110000Z\r\nDTEND:20261004T120000Z')]);
  const { body } = await call('/api/availability?service=dry-needling&from=2026-10-04&to=2026-10-04');
  const slots = body.days['2026-10-04'];
  assert.ok(slots.includes('12:30'));
  for (const t of ['13:00', '13:30', '14:00', '14:30', '15:00']) assert.ok(!slots.includes(t), `${t} overlaps the appointment or its break`);
  assert.ok(slots.includes('15:30'));
});

test('a confirmed booking goes into a "קליניקה" calendar, made the first time', async () => {
  const { call, dav, env, settle } = setup('writer@example.com', []);
  const r = await call('/api/bookings', {
    method: 'POST',
    body: { serviceId: 'stress', date: '2026-10-04', time: '12:30', name: 'Dana Levi', phone: '0501234567', consent: true },
  });
  assert.equal(r.status, 201);
  await settle();
  assert.equal(dav.calendars.get('/1/calendars/clinic-bookings/'), 'קליניקה');
  const ics = dav.puts.get(`/1/calendars/clinic-bookings/booking-${r.body.booking.ref}.ics`);
  assert.match(ics, /DTSTART:20261004T093000Z/);
  assert.match(ics, /SUMMARY:Dana Levi – דיקור סטרס/);
  const row = env.DB.raw.prepare('SELECT calendar_at FROM bookings WHERE ref = ?').get(r.body.booking.ref);
  assert.ok(row.calendar_at, 'marked as written to the calendar');
});

test('the password is only ever sent to the calendar server itself', async () => {
  const { calendarSettings, busyTimes } = await import('../worker/calendar.js');
  const settings = calendarSettings({ ICLOUD_USER: 'redirect@example.com', ICLOUD_APP_PASSWORD: 'x', CALDAV_URL: 'https://caldav.test' });
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ host: new URL(url).host, auth: Boolean(init.headers.Authorization) });
    return new Response('', { status: 302, headers: { Location: 'https://evil.test/steal' } });
  };
  await assert.rejects(busyTimes(settings, { from: '2026-10-04', to: '2026-10-04', tz: TZ }, fetchImpl), /refusing/);
  assert.deepEqual(sent, [{ host: 'caldav.test', auth: true }]);
  assert.equal(calendarSettings({ ICLOUD_USER: 'a', ICLOUD_APP_PASSWORD: 'b', CALDAV_URL: 'http://caldav.test' }), null);
});
