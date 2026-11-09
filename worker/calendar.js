// The practitioner's calendar on iCloud (the iPhone's calendar), over CalDAV – the standard
// way Apple lets another system read and add calendar events.
//
// - Busy times: anything in his calendars blocks that time on the booking page (with the
//   usual break around it). An all-day event shown as busy (a vacation) closes the whole
//   day. An event shown as free, or cancelled, blocks nothing. Only the times are used: the
//   events' titles and details are never read into the site or kept.
// - Each confirmed booking is added to the calendar named CALENDAR_NAME ("קליניקה" unless set),
//   which is created the first time if it doesn't exist.
//
// It signs in with an app-specific password (account.apple.com → Sign-In and Security), which
// opens the calendar only – not photos, files or the account's settings – and can be revoked
// at any time. Settings: ICLOUD_USER and ICLOUD_APP_PASSWORD (secrets), CALENDAR_NAME (vars).

import { addDays, dayIndex, weekday } from '../server/time.js';

const DAV = 'DAV:';
const CALDAV = 'urn:ietf:params:xml:ns:caldav';
const DISCOVERY_MS = 60 * 60 * 1000;
const BUSY_MS = 60 * 1000;

/** The calendar's settings from the Worker's secrets, or null while they aren't set. */
export function calendarSettings(env) {
  const user = String(env.ICLOUD_USER || '').trim();
  const password = String(env.ICLOUD_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !password) return null;
  const base = String(env.CALDAV_URL || 'https://caldav.icloud.com').trim().replace(/\/+$/, '');
  // The password only ever travels over HTTPS (plain http only for a test server on this machine).
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) return null;
  return { base, user, password, name: String(env.CALENDAR_NAME || '').trim() || 'קליניקה' };
}

// ---------- A little XML: just enough to read CalDAV's answers ----------

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// Elements by local name, whatever namespace prefix the server uses.
const elements = (xml, name) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`, 'g'))].map(
    (m) => m[1] ?? '',
  );
const first = (xml, name) => elements(xml, name)[0];
const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

// ---------- Requests ----------

function client(settings, fetchImpl) {
  const auth = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${settings.user}:${settings.password}`)))}`;
  const home = new URL(settings.base).hostname;
  // The password goes only to the calendar server itself (on iCloud, Apple's *.icloud.com).
  const trusted = (url) => {
    const host = new URL(url).hostname;
    return host === home || (home.endsWith('icloud.com') && host.endsWith('.icloud.com'));
  };
  return async function dav(method, url, { body, depth, headers = {}, ok = [200, 201, 204, 207] } = {}) {
    for (let hop = 0; ; hop++) {
      if (!trusted(url)) throw new Error(`CalDAV: refusing to send the password to ${new URL(url).hostname}`);
      const res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          ...(body ? { 'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
          ...(depth != null ? { Depth: String(depth) } : {}),
          ...headers,
        },
        body,
        redirect: 'manual',
      });
      const location = res.headers.get('Location');
      if ([301, 302, 307, 308].includes(res.status) && location && hop < 3) {
        await res.body?.cancel();
        url = new URL(location, url).href;
        continue;
      }
      const text = await res.text();
      if (!ok.includes(res.status)) {
        const err = new Error(`CalDAV ${method}: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return { status: res.status, text, url };
    }
  };
}

const absolute = (href, base) => new URL(decode(href).trim(), base).href;

let discovered = { key: '', at: 0, home: '', calendars: [] };

/** Finds his calendars: principal → calendar home → each calendar that holds events. */
async function discover(settings, dav, fresh = false) {
  const key = `${settings.base}|${settings.user}`;
  if (!fresh && discovered.key === key && Date.now() - discovered.at < DISCOVERY_MS) return discovered;

  const who = await dav('PROPFIND', `${settings.base}/`, {
    depth: 0,
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV}"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
  });
  const principalHref = first(first(who.text, 'current-user-principal') || '', 'href');
  if (!principalHref) throw new Error('CalDAV: no principal');
  const principal = absolute(principalHref, who.url);

  const homeAnswer = await dav('PROPFIND', principal, {
    depth: 0,
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
  });
  const homeHref = first(first(homeAnswer.text, 'calendar-home-set') || '', 'href');
  if (!homeHref) throw new Error('CalDAV: no calendar home');
  const home = absolute(homeHref, homeAnswer.url);

  const list = await dav('PROPFIND', home, {
    depth: 1,
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`,
  });
  const calendars = [];
  for (const r of elements(list.text, 'response')) {
    const type = first(r, 'resourcetype') || '';
    if (!/<(?:[\w.-]+:)?calendar[\s/>]/.test(type)) continue;
    const comps = first(r, 'supported-calendar-component-set');
    if (comps && !/name="VEVENT"/i.test(comps)) continue; // reminders lists and the like
    calendars.push({ url: absolute(first(r, 'href'), home), name: decode(first(r, 'displayname') || '').trim() });
  }
  discovered = { key, at: Date.now(), home, calendars };
  return discovered;
}

// ---------- Busy times ----------
// A small iCalendar reader, light enough for the free plan's 10 ms of work per request. The
// server expands recurring events into single ones (iCloud does); for a server that doesn't,
// daily and weekly repeats are expanded here.

const icalUtc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const zoneFormats = new Map();
/** The wall-clock date and minute of the day of a moment, in a time zone. */
function inZone(tz, at) {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    zoneFormats.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const knownZones = new Map();
function zoneOr(tzid, fallback) {
  const name = String(tzid || '').replace(/^\/.*?\/(?=[A-Za-z]+\/)/, '');
  if (!name) return fallback;
  if (!knownZones.has(name)) {
    try {
      inZone(name, new Date());
      knownZones.set(name, true);
    } catch {
      knownZones.set(name, false);
    }
  }
  return knownZones.get(name) ? name : fallback;
}

/** A wall-clock date and time in a time zone → the moment (summer time included). */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (at) => {
    const local = inZone(tz, new Date(at));
    const [ly, lm, ld] = local.date.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld) + local.minutes * 60_000 - Math.floor(at / 60_000) * 60_000;
  };
  let t = guess - offset(guess);
  const again = guess - offset(t);
  if (again !== t) t = again;
  return new Date(t);
}

function unfold(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
}

function readLine(line) {
  let i = 0;
  for (let quoted = false; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) break;
  }
  const [name, ...rest] = line.slice(0, i).split(';');
  const params = {};
  for (const kv of rest) {
    const j = kv.indexOf('=');
    if (j > 0) params[kv.slice(0, j).toUpperCase()] = kv.slice(j + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1).trim() };
}

/** The events in iCalendar text: their times, repeats and whether they block time. */
export function readEvents(text) {
  const events = [];
  let event = null;
  let depth = 0;
  for (const line of unfold(text).split('\n')) {
    if (!line) continue;
    const { name, params, value } = readLine(line);
    if (name === 'BEGIN') {
      if (!event && value.toUpperCase() === 'VEVENT') event = { exdates: [] };
      else if (event) depth++; // an alarm inside the event
      continue;
    }
    if (name === 'END') {
      if (event && depth === 0) {
        events.push(event);
        event = null;
      } else if (event) depth--;
      continue;
    }
    if (!event || depth > 0) continue;
    if (name === 'UID') event.uid = value;
    else if (name === 'DTSTART') event.start = { value, params };
    else if (name === 'DTEND') event.end = { value, params };
    else if (name === 'DURATION') event.duration = value;
    else if (name === 'RRULE') event.rrule = value;
    else if (name === 'RECURRENCE-ID') event.recurrenceId = { value, params };
    else if (name === 'EXDATE') for (const v of value.split(',')) event.exdates.push({ value: v, params });
    else if (name === 'STATUS') event.status = value.toUpperCase();
    else if (name === 'TRANSP') event.transp = value.toUpperCase();
  }
  return events;
}

/** A DTSTART-like value → { date } for a whole day, or { at, date, time, zone } for a moment. */
function when(prop, tz) {
  const v = prop?.value?.trim() || '';
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), utc: true };
  const zone = zoneOr(prop.params?.TZID, tz); // no zone given: the clinic's own
  return { at: zonedToUtc(`${y}-${mo}-${d}`, `${h}:${mi}`, zone), date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, zone };
}

function durationMs(text) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(text || '').trim());
  if (!m) return 0;
  const [, sign, w, d, h, mi, s] = m.map((x) => (x === undefined ? 0 : x));
  const ms = ((((+w * 7 + +d) * 24 + +h) * 60 + +mi) * 60 + +s) * 1000;
  return sign === '-' ? -ms : ms;
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * The starts of a repeating event that touch [from, to] (wall-clock dates), for daily and
 * weekly repeats. Other kinds of repeat only count their first time.
 */
function repeats(event, start, from, to) {
  const rule = {};
  for (const kv of event.rrule.split(';')) {
    const [k, v] = kv.split('=');
    if (k && v) rule[k.toUpperCase()] = v.toUpperCase();
  }
  const firstDate = start.allDay ? start.date : start.date ?? start.at.toISOString().slice(0, 10);
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const untilProp = rule.UNTIL ? when({ value: rule.UNTIL, params: {} }, start.zone || 'UTC') : null;
  const until = untilProp ? (untilProp.allDay ? untilProp.date : untilProp.at) : null;
  const out = [];
  const keep = (date, n) => {
    if (n >= count) return false;
    if (until && (typeof until === 'string' ? date > until : startOf(date) > until)) return false;
    if (date >= addDays(from, -1) && date <= to) out.push(date);
    return true;
  };
  // A moment on that date, at the event's own time of day.
  const startOf = (date) =>
    start.allDay ? new Date(`${date}T00:00:00Z`) : start.utc ? new Date(start.at.getTime() + (dayIndex(date) - dayIndex(firstDate)) * 86_400_000) : zonedToUtc(date, start.time, start.zone);

  if (rule.FREQ === 'DAILY') {
    const k0 = Math.max(0, Math.ceil((dayIndex(from) - 1 - dayIndex(firstDate)) / interval));
    for (let k = k0; ; k++) {
      const date = addDays(firstDate, k * interval);
      if (date > to || !keep(date, k)) break;
    }
  } else if (rule.FREQ === 'WEEKLY') {
    const wkst = Math.max(0, DAYS.indexOf(rule.WKST || 'MO'));
    const startDay = weekday(firstDate);
    const days = (rule.BYDAY ? rule.BYDAY.split(',').map((d) => DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0) : [startDay]).sort(
      (a, b) => ((a - wkst + 7) % 7) - ((b - wkst + 7) % 7),
    );
    const week0 = addDays(firstDate, -((startDay - wkst + 7) % 7));
    const inFirstWeek = days.filter((d) => (d - wkst + 7) % 7 >= (startDay - wkst + 7) % 7).length;
    const p0 = Math.max(0, Math.floor((dayIndex(from) - 1 - dayIndex(week0)) / (7 * interval)));
    let n = p0 === 0 ? 0 : inFirstWeek + (p0 - 1) * days.length;
    outer: for (let p = p0; ; p++) {
      const weekStart = addDays(week0, p * 7 * interval);
      if (weekStart > to) break;
      for (const d of days) {
        const date = addDays(weekStart, (d - wkst + 7) % 7);
        if (date < firstDate) continue;
        if (!keep(date, n++)) break outer;
      }
    }
  } else if (firstDate >= addDays(from, -1) && firstDate <= to) {
    out.push(firstDate);
  }
  return out.map((date) => (start.allDay ? { allDay: true, date } : { at: startOf(date) }));
}

/** Adds [start, end) to the busy map, day by day in the clinic's time zone. */
function addBusy(busy, startAt, endAt, tz, from, to) {
  if (!(endAt > startAt)) return;
  const s = inZone(tz, startAt);
  const e = inZone(tz, endAt);
  for (let d = s.date; d <= e.date; d = addDays(d, 1)) {
    if (d < from || d > to || busy[d] === 'all') continue;
    const a = d === s.date ? s.minutes : 0;
    const b = d === e.date ? e.minutes : 1440;
    if (b <= a) continue;
    if (a === 0 && b === 1440) busy[d] = 'all';
    else (busy[d] ||= []).push({ start: a, end: b });
  }
}

/** The busy times in a set of events (iCalendar texts). */
export function busyFromIcs(texts, { from, to, tz }) {
  const busy = {};
  const events = texts.flatMap((t) => {
    try {
      return readEvents(t);
    } catch {
      return []; // one unreadable event never stops the rest
    }
  });
  // Single changed times of a repeating event replace the repeat's own time that day.
  const moved = new Map();
  for (const e of events) {
    if (!e.recurrenceId || !e.uid) continue;
    const r = when(e.recurrenceId, tz);
    if (!r) continue;
    if (!moved.has(e.uid)) moved.set(e.uid, new Set());
    moved.get(e.uid).add(r.allDay ? r.date : r.at.getTime());
  }

  for (const e of events) {
    if (e.status === 'CANCELLED' || e.transp === 'TRANSPARENT') continue; // cancelled, or shown as free
    const start = when(e.start, tz);
    if (!start) continue;
    const endProp = e.end && when(e.end, tz);
    const lengthMs = start.allDay
      ? Math.max(1, endProp?.allDay ? dayIndex(endProp.date) - dayIndex(start.date) : Math.round(durationMs(e.duration) / 86_400_000) || 1) * 86_400_000
      : endProp && !endProp.allDay ? endProp.at - start.at : durationMs(e.duration);

    let starts = [start.allDay ? { allDay: true, date: start.date } : { at: start.at }];
    if (e.rrule && !e.recurrenceId) {
      const skip = new Set(moved.get(e.uid) || []);
      for (const x of e.exdates) {
        const w = when(x, start.zone || tz);
        if (w) skip.add(w.allDay ? w.date : w.at.getTime());
      }
      starts = repeats(e, start, from, to).filter((s) => !skip.has(s.allDay ? s.date : s.at.getTime()));
    }
    for (const s of starts) {
      if (s.allDay) {
        const days = Math.round(lengthMs / 86_400_000);
        for (let i = 0; i < days; i++) {
          const d = addDays(s.date, i);
          if (d >= from && d <= to) busy[d] = 'all';
        }
      } else {
        addBusy(busy, s.at, new Date(s.at.getTime() + lengthMs), tz, from, to);
      }
    }
  }
  return busy;
}

let busyCache = { key: '', at: 0, value: null };

/**
 * { "YYYY-MM-DD": [{ start, end }] (minutes) or "all" } for [from, to] from all his calendars.
 * Asked again at most once a minute.
 */
export async function busyTimes(settings, { from, to, tz }, fetchImpl = fetch) {
  const key = `${settings.base}|${settings.user}|${from}|${to}`;
  if (busyCache.key === key && Date.now() - busyCache.at < BUSY_MS) return busyCache.value;

  const dav = client(settings, fetchImpl);
  const { calendars } = await discover(settings, dav);
  const start = icalUtc(zonedToUtc(from, '00:00', tz));
  const end = icalUtc(zonedToUtc(addDays(to, 1), '00:00', tz));
  const query = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}">
  <d:prop><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const answers = await Promise.all(calendars.map((c) => dav('REPORT', c.url, { depth: 1, body: query })));
  const texts = answers.flatMap((a) => elements(a.text, 'calendar-data').map(decode));
  const busy = busyFromIcs(texts, { from, to, tz });
  busyCache = { key, at: Date.now(), value: busy };
  return busy;
}

// ---------- Adding a booking ----------

// (control characters aren't allowed in an event's text: left out, so the calendar takes it)
const icsText = (s) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');

// iCalendar lines are at most 75 bytes; longer ones continue on the next line after a space.
function fold(line) {
  const bytes = new TextEncoder();
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (bytes.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** The booking as an iCalendar event. */
export function bookingIcs({ booking, serviceName, tz, now = new Date() }) {
  const startAt = zonedToUtc(booking.date, booking.time, tz);
  const endAt = new Date(startAt.getTime() + booking.duration * 60_000);
  const details = [
    `טלפון: ${booking.phone}`,
    booking.email && `אימייל: ${booking.email}`,
    booking.notes && `הערות: ${booking.notes}`,
    booking.price != null && `שולם באתר: ${booking.price} ₪`,
    `מספר אישור: ${booking.ref}`,
  ].filter(Boolean);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//clinic website//bookings//HE',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:booking-${booking.ref}@clinic`,
    `DTSTAMP:${icalUtc(now)}`,
    `DTSTART:${icalUtc(startAt)}`,
    `DTEND:${icalUtc(endAt)}`,
    `SUMMARY:${icsText(`${booking.name} – ${serviceName}`)}`,
    `DESCRIPTION:${icsText(details.join('\n'))}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]
    .map(fold)
    .join('\r\n');
}

/**
 * The calendar bookings go into: CALENDAR_NAME, created if it isn't there yet. Created with
 * an "extended MKCOL" (RFC 5689): Cloudflare's runtime can't send MKCALENDAR requests. If the
 * server won't create calendars, bookings go into his first calendar instead.
 */
async function targetCalendar(settings, dav) {
  let found = await discover(settings, dav);
  let cal = found.calendars.find((c) => c.name === settings.name);
  if (cal) return cal.url;
  const url = new URL('clinic-bookings/', found.home.endsWith('/') ? found.home : `${found.home}/`).href;
  try {
    await dav('MKCOL', url, {
      ok: [201],
      body: `<?xml version="1.0" encoding="utf-8"?><d:mkcol xmlns:d="${DAV}" xmlns:c="${CALDAV}"><d:set><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${escapeXml(settings.name)}</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></d:mkcol>`,
    });
  } catch (err) {
    if (!err.status) throw err; // our side failed: never write elsewhere because of that
    if (err.status !== 405 && found.calendars[0]) return found.calendars[0].url; // 405: it's already there
    if (err.status !== 405) throw err;
  }
  found = await discover(settings, dav, true);
  cal = found.calendars.find((c) => c.url === url || c.name === settings.name);
  if (!cal) throw new Error('CalDAV: the bookings calendar could not be created');
  return cal.url;
}

/** Adds a confirmed booking to his calendar. Adding the same booking twice changes nothing. */
export async function addBooking(settings, { booking, serviceName, tz }, fetchImpl = fetch) {
  const dav = client(settings, fetchImpl);
  const calUrl = await targetCalendar(settings, dav);
  const url = new URL(`booking-${booking.ref}.ics`, calUrl.endsWith('/') ? calUrl : `${calUrl}/`).href;
  await dav('PUT', url, { body: bookingIcs({ booking, serviceName, tz }), headers: { 'If-None-Match': '*' }, ok: [200, 201, 204, 412] });
  busyCache = { key: '', at: 0, value: null };
}
