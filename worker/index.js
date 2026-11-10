// The website on Cloudflare: the pages are static files (dist/, built from public/ by
// scripts/build-cloudflare.mjs) that Cloudflare serves by itself, and this Worker answers
// /api/* – the same API as the Node server (server/app.js), with the data in Cloudflare D1.
//
// BOOKING_MODE (wrangler.jsonc → vars):
//   "whatsapp" (the default) – as on the site today: a booking request or a message opens
//              WhatsApp, and nothing is stored. The booking page shows the free times from
//              the opening hours, minus the days closed in the admin panel.
//   "pay"      – the client books and pays in full on the site (Grow). The time is held while
//              they pay, and the booking is confirmed only once Grow confirms the payment.
//              Messages still go to WhatsApp.
//   "online"   – bookings and messages are taken and stored here, without payment.
//   "transfer" – bookings are taken here, and the client pays by Bit or PayBox to the
//              practitioner's phone: one session, the 4-session card, or a session from a card
//              they already have. The time is held until he sees the payment and approves the
//              booking in the admin panel. Messages still go to WhatsApp.
//
// With ICLOUD_USER and ICLOUD_APP_PASSWORD set, times taken in the practitioner's iCloud
// calendar don't show, and each confirmed booking is added to it (worker/calendar.js).
//
// The home and booking pages also come through here (wrangler.jsonc → run_worker_first), to
// put in what David changes in the admin panel's "האתר" tab: his texts, photos and prices,
// and the notices at the top of the site (worker/content.js). The photos he uploads are
// served from /media/.
//
// Clients can sign in on the booking page, with Google (worker/google.js) or with a code sent
// to their phone by SMS (worker/sms.js): they see the sessions left on their card and their
// bookings, and a session from the card is confirmed at once. Managers can sign in with Google
// too. Each is on once migrations/0006 is applied and its secrets are set.
//
// Setup and deployment: worker/README.md.

import siteConfig from '../config/site.json' with { type: 'json' };
import { addDays, dayIndex, isValidDate, isValidTime, nowInZone } from '../server/time.js';
import { accessSettings, verifyAccess } from './access.js';
import { missingTables, openAccountStore } from './accounts.js';
import { openAdminStore, phoneKey } from './admin-store.js';
import { addBooking as addToCalendar, busyTimes, calendarSettings, zonedToUtc } from './calendar.js';
import {
  approveTransaction,
  createPaymentProcess,
  getPaymentProcessInfo,
  growSettings,
  isFullName,
  israeliMobile,
  paidTransaction,
  readNotice,
} from './grow.js';
import { GoogleError, authUrl as googleAuthUrl, callbackUrl, exchangeCode, googleSettings, nonceFor, verifyIdToken } from './google.js';
import { HttpError, json, readBytes, readCookie, readJson } from './http.js';
import { PasskeyError, hashCode, randomCode, verifyLogin, verifyRegistration } from './passkeys.js';
import { SmsError, checkCode, isIsraeliMobile, sendCode, smsSettings } from './sms.js';
import { CardEmptyError, SlotTakenError, openD1Store } from './store.js';
import { mergeSiteConfig, UPLOAD_ID_RE } from '../public/js/site-content.js';
import {
  MEDIA_MAX_BYTES,
  applyContentPatch,
  cleanJpeg,
  injectSiteData,
  newUploads,
  noticeFields,
  openContentStore,
  removeUnusedUploads,
  uploadSize,
  uploadsExist,
} from './content.js';
import { PAGE_HEADERS } from './page-headers.js';

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ACCESS_LOGOUT = '/cdn-cgi/access/logout';
// The admin panel's sign-in cookie: only sent over HTTPS, never readable by scripts, never
// sent from another site, and valid for 12 hours.
const SESSION_COOKIE = '__Host-admin';
const SESSION_HOURS = 12;
// Saving the sign-in on another device is allowed only this soon after signing in.
const FRESH_MINUTES = 15;
const sessionCookie = (token, hours = SESSION_HOURS) =>
  `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.round(hours * 3600)}`;
// A client's sign-in on the site: the same kind of cookie, for 90 days or until they sign out.
const CLIENT_COOKIE = '__Host-client';
const CLIENT_DAYS = 90;
const clientCookie = (token, days = CLIENT_DAYS) =>
  `${CLIENT_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.round(days * 86_400)}`;
// While signing in with Google (10 minutes at most): ties Google's answer to the browser that
// asked for it. "Lax", since the answer comes back from Google's page.
const OAUTH_COOKIE = '__Host-oauth';
const oauthCookie = (value, seconds = 600) => `${OAUTH_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
// What a Google sign-in is for, by the first letter of its state: a client on the booking page,
// a manager signing in, or a manager connecting their Google account.
const GOOGLE_FOR = { client: 'c', admin: 'a', link: 'l' };
const GOOGLE_PURPOSE = { c: 'google-client', a: 'google-admin', l: 'google-link' };
const CODE_RE = /^\d{4,10}$/;
const HOLD_MINUTES = 20; // how long a time stays held while the client pays
const RECONCILE_HOURS = 6; // how far back the scheduled check looks for unanswered payments
const MODES = new Set(['whatsapp', 'pay', 'online', 'transfer']);
// What a client can pay for when paying by Bit or PayBox ("transfer").
const PLANS = new Set(['single', 'pack', 'card']);
/** "+972 58-434-4047" → "058-434-4047", the way people type it into Bit or PayBox. */
const localPhone = (phone) => String(phone || '').replace(/^\+972[\s-]*/, '0');
// The pages that come with David's content in them (the others are served as they are).
const PAGES = new Set(['/', '/book']);
// Where plain http is fine: this computer, while developing.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// How long a page waits for the database before it's served without his changes.
const PAGE_DATA_MS = 2500;

// Characters a keyboard doesn't type: control characters, text-direction overrides, and half of
// an emoji (a calendar would refuse an event with them). Left out of what visitors send.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A text as sent, cleaned and cut to `max` characters (never in the middle of an emoji). */
function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(HIDDEN, '').trim();
  return [...s].slice(0, max).join('').trim();
}

const invalid = (fields) => new HttpError(400, 'invalid', { fields });
const notFound = () => new HttpError(404, 'not_found');
const tooMany = () => new HttpError(429, 'too_many_requests', {}, { 'Retry-After': '60' });

/** True when this visitor has gone over the limit (the limiter is a binding in wrangler.jsonc). */
async function overLimit(limiter, key) {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    return false; // a hiccup in the limiter never blocks a real visitor
  }
}

export function createWorker({ config = siteConfig, clock = () => new Date(), fetch: fetchImpl = fetch, log = console } = {}) {
  const tz = config.timezone;
  const services = new Map(config.services.map((s) => [s.id, s]));
  const now = () => nowInZone(tz, clock());
  const modeOf = (env) => (MODES.has(env.BOOKING_MODE) ? env.BOOKING_MODE : 'whatsapp');
  const storeFor = (env) => openD1Store(env.DB, config.defaultSchedule, clock);
  const contentFor = (env) => openContentStore(env.DB, clock);
  const accountsFor = (env) => openAccountStore(env.DB, clock);
  // On this computer (wrangler dev), stand-ins for Google and Twilio may be used for testing.
  const settingsFor = (url) => ({ local: LOCAL_HOSTS.has(url.hostname) });

  // Signing in on the site needs migrations/0006 (once it's seen to be in, it stays in).
  let signInTables = false;
  async function signInReady(env) {
    if (!signInTables) signInTables = await accountsFor(env).ready().catch(() => false);
    return signInTables;
  }

  /** The ways clients can sign in now: with Google, with a code by SMS. */
  async function signInWays(env, url, mode) {
    if (mode === 'whatsapp' || !(await signInReady(env))) return { google: false, sms: false };
    return { google: Boolean(googleSettings(env, settingsFor(url))), sms: Boolean(smsSettings(env, settingsFor(url))) };
  }

  /** The client signed in on the site (their account), or null. */
  async function currentAccount(request, env) {
    const token = readCookie(request, CLIENT_COOKIE);
    if (!token || token.length > 100) return null;
    try {
      return await accountsFor(env).sessionAccount(await hashCode(token));
    } catch (err) {
      if (missingTables(err)) return null;
      throw err;
    }
  }

  async function startClientSession(env, accountId) {
    const token = randomCode(32);
    await accountsFor(env).addSession({ hash: await hashCode(token), accountId, days: CLIENT_DAYS });
    return clientCookie(token);
  }

  /** The site's settings with David's treatments and prices from the admin panel. */
  async function siteFor(env) {
    try {
      return mergeSiteConfig(config, await contentFor(env).content());
    } catch (err) {
      log.error('Reading the site content failed:', err?.message || String(err));
      return mergeSiteConfig(config, {});
    }
  }

  /**
   * The home or booking page with David's content and the notices showing now. If the
   * database doesn't answer in time, the page goes out as it comes with the site.
   */
  async function page(request, env, url) {
    const ask = new Headers(request.headers);
    ask.delete('If-None-Match');
    ask.delete('If-Modified-Since');
    const asset = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET', headers: ask }));
    if (!asset.ok || !/^text\/html/i.test(asset.headers.get('Content-Type') || '')) return asset;
    let data = null;
    let timer;
    try {
      data = await Promise.race([
        contentFor(env).publicSite(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), PAGE_DATA_MS);
        }),
      ]);
    } catch (err) {
      log.error('Page content failed (the page went out without it):', err?.message || String(err));
    } finally {
      clearTimeout(timer);
    }
    const html = await asset.text();
    const headers = new Headers(asset.headers);
    for (const h of ['ETag', 'Last-Modified', 'Content-Length', 'Content-Encoding']) headers.delete(h);
    headers.set('Cache-Control', 'no-cache'); // his changes show at once
    for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
    const body = data ? injectSiteData(html, data) : html;
    return new Response(request.method === 'HEAD' ? null : body, { status: asset.status, headers });
  }

  /** A photo he uploaded (/media/<id>-<width>.jpg): never changes, so browsers keep it. */
  async function media(request, env, key) {
    const found = env.MEDIA ? await env.MEDIA.getWithMetadata(key, { type: 'stream', cacheTtl: 86_400 }) : null;
    if (!found?.value) throw notFound();
    if (request.method === 'HEAD') await found.value.cancel();
    return new Response(request.method === 'HEAD' ? null : found.value, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ...(found.metadata?.size ? { 'Content-Length': String(found.metadata.size) } : {}),
      },
    });
  }

  // Emails aren't connected on Cloudflare yet: they come once the practice's domain is set.
  // Until then nothing is sent, and the log only notes that an email would have gone out,
  // without anyone's details.
  const noMail = (kind) => log.info(`[mail not connected] ${kind} email not sent`);

  /** Who is signed in: with a passkey (a session cookie), or through Cloudflare Access if it's set up. */
  async function currentAdmin(request, env) {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
      const admin = await openAdminStore(env.DB, clock).sessionAdmin(await hashCode(token));
      if (admin) {
        const signedInAt = Date.parse(admin.expires_at) - SESSION_HOURS * 3_600_000;
        return { id: admin.id, name: admin.name, handle: admin.handle, signedInAt };
      }
    }
    const settings = accessSettings(env);
    const viaAccess = settings && (await verifyAccess(request, settings, { fetch: fetchImpl, now: clock().getTime() }));
    return viaAccess ? { email: viaAccess.email, name: viaAccess.email } : null;
  }

  async function requireAdmin(request, env) {
    const admin = await currentAdmin(request, env);
    if (!admin) throw new HttpError(401, 'unauthorized');
    return admin;
  }

  async function startSession(env, adminId) {
    const token = randomCode(32);
    await openAdminStore(env.DB, clock).addSession({ hash: await hashCode(token), adminId, hours: SESSION_HOURS });
    return sessionCookie(token);
  }

  /** Back to one of the site's own pages (from Google's), with the cookies to set. */
  function backTo(url, path, cookies = []) {
    const headers = new Headers({
      Location: new URL(path, url.origin).toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
  }

  /** Times taken in his calendar, or {} when it isn't connected or doesn't answer. */
  async function calendarBusy(env, from, to) {
    const settings = calendarSettings(env);
    if (!settings) return {};
    try {
      return await busyTimes(settings, { from, to, tz }, fetchImpl);
    } catch (err) {
      // The booking page then shows the times from the opening hours alone, as before.
      log.error('Calendar busy times failed:', err?.message || String(err));
      return {};
    }
  }

  /** After a booking is confirmed: into his calendar (and, later, the emails). */
  async function afterConfirmed(env, store, booking) {
    try {
      await openAdminStore(env.DB, clock).clientFromBooking(booking); // into David's client list
    } catch (err) {
      log.error('Adding the client to the list failed:', err?.message || String(err));
    }
    noMail('new booking');
    if (booking.email) noMail('booking confirmation');
    const settings = calendarSettings(env);
    if (!settings) return;
    try {
      const service = (await siteFor(env)).services.find((s) => s.id === booking.service_id);
      await addToCalendar(settings, { booking, serviceName: service?.name.he || booking.service_id, tz }, fetchImpl);
      await store.markInCalendar(booking.id);
    } catch (err) {
      log.error('Adding the booking to the calendar failed (tried again later):', err?.message || String(err));
    }
  }

  /**
   * Asks Grow whether this payment is paid, with our own identifiers. Paid → the booking is
   * confirmed and Grow is told the notice arrived. Safe to run again for the same payment.
   */
  async function settle(env, store, payment) {
    const grow = growSettings(env);
    if (!grow) return 'not_configured';
    const info = await getPaymentProcessInfo(grow, { processId: payment.process_id, processToken: payment.process_token }, fetchImpl);
    const transaction = paidTransaction(info, payment.sum);
    if (!transaction) return 'not_paid';

    const booking = await store.confirmBooking(payment.booking_id);
    if (booking) {
      await store.markPaid(payment.id, transaction);
      await afterConfirmed(env, store, booking);
    } else {
      const current = await store.bookingById(payment.booking_id);
      if (current?.status === 'confirmed') {
        await store.markPaid(payment.id, transaction); // a repeat of a notice already handled
      } else if (await store.markPaid(payment.id, transaction, 'conflict')) {
        // Paid after the hold ran out, and someone else had taken the time meanwhile.
        log.error(`Payment for booking ${current?.ref} arrived after its time was taken: refund it in Grow (asmachta ${transaction.asmachta}).`);
      }
    }
    if (!payment.approved_at) {
      try {
        await approveTransaction(grow, { transaction, processId: payment.process_id, processToken: payment.process_token }, fetchImpl);
        await store.markApproved(payment.id);
      } catch (err) {
        log.error('Grow approveTransaction failed:', err?.message || String(err));
      }
    }
    return 'paid';
  }

  async function api(request, env, url, ctx) {
    const { method } = request;
    const path = url.pathname;
    const route = `${method} ${path}`;
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const mode = modeOf(env);
    const store = storeFor(env);

    if (await overLimit(env.API_LIMIT, ip)) throw tooMany();

    // ---------- Grow's server tells ours a payment's status (server to server) ----------
    // Form fields, not JSON, and from Grow rather than from a browser – so it comes before
    // the checks below. It only says which payment to look at: settle() asks Grow itself.
    if (route === 'POST /api/payments/grow/notify') {
      if (Number(request.headers.get('Content-Length') || 0) > 50_000) throw new HttpError(413, 'too_large');
      const type = request.headers.get('Content-Type') || '';
      let notice = {};
      try {
        if (/application\/json/i.test(type)) {
          const body = await readJson(request, 50_000);
          notice = body?.data ?? body ?? {};
        } else {
          notice = readNotice(await request.formData());
        }
      } catch {
        return json({ ok: true }); // nothing readable to act on
      }
      const payment = await store.paymentByProcess(String(notice.processId ?? '').trim());
      // Only a payment page this site opened, named with its own secret token.
      if (payment && String(notice.processToken ?? '').trim() === payment.process_token) await settle(env, store, payment);
      return json({ ok: true });
    }

    // ---------- A photo David uploads in the admin panel (one size of it) ----------
    // Its own body (a JPEG, not JSON), so it comes before the checks below – with the same
    // rules: from this site's own pages only (a page on another site can't send image/jpeg
    // here without the browser asking first), and only signed in.
    const upload = /^\/api\/admin\/media\/(hero|about|service|gallery)\/([a-z2-7]{16})\/(\d{3,4})$/.exec(path);
    if (upload && method === 'PUT') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'bad_origin');
      await requireAdmin(request, env);
      if (!env.MEDIA) throw new HttpError(503, 'media_unavailable');
      const size = uploadSize(upload[1], Number(upload[3]));
      if (!size || !UPLOAD_ID_RE.test(upload[2])) throw invalid(['width']);
      if (!/^image\/jpeg$/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'jpeg_required');
      const photo = cleanJpeg(await readBytes(request, MEDIA_MAX_BYTES));
      if (!photo) throw invalid(['photo']);
      if (Math.abs(photo.width - size[0]) > 1 || Math.abs(photo.height - size[1]) > 1) throw invalid(['size']);
      const key = `${upload[2]}-${upload[3]}`;
      await env.MEDIA.put(key, photo.bytes, {
        metadata: { w: photo.width, h: photo.height, size: photo.bytes.byteLength, created: clock().toISOString() },
      });
      return json({ ok: true, url: `/media/${key}.jpg` }, 201);
    }

    // Anything that changes data must come from this site's own pages, as JSON.
    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'bad_origin');
      // (the site's texts are saved in one go, so they may be longer)
      body = await readJson(request, path === '/api/admin/content' ? 100_000 : undefined);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) body = {};
    }

    // ---------- Public API ----------

    if (route === 'GET /api/config') {
      const today = now().date;
      const [schedule, site, closedDays] = await Promise.all([
        store.getSchedule(),
        siteFor(env),
        // Closed days this coming week, so "open now" on the site knows about them.
        contentFor(env)
          .closedDays(today, addDays(today, 7))
          .catch(() => []),
      ]);
      return json({
        business: config.business,
        services: site.services,
        prices: site.prices,
        currency: config.currency,
        timezone: tz,
        today: now().date,
        maxDaysAhead: schedule.maxDaysAhead,
        hours: schedule.weeklyHours,
        // Messages go to WhatsApp unless the site takes them itself ("online").
        handoff: mode === 'online' ? undefined : 'whatsapp',
        payments: mode === 'pay' ? true : undefined,
        // Paying by Bit or PayBox to this number, approved by hand.
        transfer: mode === 'transfer' ? { phone: localPhone(config.business.phone) } : undefined,
        closedDays,
      });
    }

    // The site's public data in one answer: David's content, the notices, the opening hours and
    // the closed days. All of it is on the site's pages anyway (and no other site may read it).
    if (route === 'GET /api/site') {
      const today = now().date;
      const editor = contentFor(env);
      const [data, schedule] = await Promise.all([editor.publicSite(), store.getSchedule()]);
      const closed = await editor.closedDays(today, addDays(today, schedule.maxDaysAhead));
      return json({ ...data, schedule, closed });
    }

    if (route === 'GET /api/availability') {
      const q = url.searchParams;
      const service = services.get(q.get('service'));
      let from = q.get('from');
      let to = q.get('to');
      if (!service || !isValidDate(from) || !isValidDate(to) || from > to) throw invalid(['service', 'from', 'to']);
      const schedule = await store.getSchedule();
      const n = now();
      const last = addDays(n.date, schedule.maxDaysAhead);
      if (from < n.date) from = n.date;
      if (to > last) to = last;
      if (from > to) return json({ days: {} });
      if (dayIndex(to) - dayIndex(from) > 62) throw invalid(['to']);
      const busy = await calendarBusy(env, from, to);
      return json({ days: await store.availability({ from, to, duration: service.duration, now: n, schedule, busy }) });
    }

    if (route === 'POST /api/bookings') {
      if (mode === 'whatsapp') throw notFound();
      const grow = mode === 'pay' ? growSettings(env) : null;
      if (mode === 'pay' && !grow) throw new HttpError(503, 'payments_unavailable');
      const transfer = mode === 'transfer';
      if (await overLimit(env.FORMS_LIMIT, `${ip} bookings`)) throw tooMany();
      const b = body;
      const site = await siteFor(env); // the prices David set
      const service = site.services.find((s) => s.id === b.serviceId);
      const input = {
        serviceId: b.serviceId,
        date: b.date,
        time: b.time,
        name: str(b.name, 80),
        phone: str(b.phone, 30),
        email: str(b.email, 120),
        notes: str(b.notes, 1000),
        lang: b.lang === 'en' ? 'en' : 'he',
      };
      const bad = [];
      if (!service) bad.push('serviceId');
      if (!isValidDate(input.date)) bad.push('date');
      if (!isValidTime(input.time)) bad.push('time');
      if (input.name.length < 2 || (grow && !isFullName(input.name))) bad.push('name');
      if (!PHONE_RE.test(input.phone) || (grow && !israeliMobile(input.phone))) bad.push('phone');
      if (input.email && !EMAIL_RE.test(input.email)) bad.push('email');
      if (b.consent !== true) bad.push('consent');
      const plan = transfer ? (PLANS.has(b.plan) ? b.plan : null) : null;
      if (transfer && !plan) bad.push('plan');
      if (bad.length) throw invalid(bad);
      // Bit or PayBox: one session, the card of sessions (this one included), or nothing now
      // for a session from a card the client already has.
      const price = transfer ? (plan === 'pack' ? site.prices.pack.price : plan === 'card' ? 0 : service.price) : grow ? service.price : null;

      // A session from the card of a client signed in on the site, with one left on it: confirmed
      // at once, without waiting for David (when the booking has the phone number on the card).
      let fromCard = null;
      if (transfer && plan === 'card') {
        const account = await currentAccount(request, env);
        const client = account && (await accountsFor(env).clientFor(account));
        if (client && client.card_left > 0 && phoneKey(input.phone) === client.phone) fromCard = client.id;
      }

      const busy = await calendarBusy(env, input.date, input.date);
      const create = (card) =>
        store.createBooking(
          { ...input, duration: service.duration, price, plan },
          now(),
          card
            ? { busy, fromCard: card }
            : // Paid by hand: the time stays held until David approves (or the appointment passes).
              { hold: grow ? HOLD_MINUTES : 0, holdUntil: transfer ? zonedToUtc(input.date, input.time, tz) : null, busy },
        );
      let booking;
      try {
        try {
          booking = await create(fromCard);
        } catch (err) {
          if (!(err instanceof CardEmptyError)) throw err;
          fromCard = null; // its last session went a moment ago: this one waits for David, as before
          booking = await create(null);
        }
      } catch (err) {
        if (err instanceof SlotTakenError) throw new HttpError(409, 'slot_taken');
        throw err;
      }
      const summary = {
        ref: booking.ref,
        serviceId: booking.service_id,
        date: booking.date,
        time: booking.time,
        duration: booking.duration,
        name: booking.name,
        price: booking.price ?? undefined,
      };

      if (fromCard) {
        ctx?.waitUntil?.(afterConfirmed(env, store, booking)); // his calendar
        const cardLeft = (await openAdminStore(env.DB, clock).client(fromCard))?.card_left ?? 0;
        return json({ booking: { ...summary, plan, price: 0, status: 'confirmed' }, cardLeft }, 201);
      }

      if (transfer) {
        return json({ booking: { ...summary, plan, price }, transfer: { phone: localPhone(config.business.phone) } }, 201);
      }

      if (!grow) {
        ctx?.waitUntil?.(afterConfirmed(env, store, booking));
        return json({ booking: summary }, 201);
      }

      // Payment: open Grow's page for exactly this booking.
      let page;
      try {
        page = await createPaymentProcess(
          grow,
          {
            sum: booking.price,
            description: service.name.he,
            fullName: booking.name,
            phone: booking.phone,
            email: booking.email,
            ref: booking.ref,
            successUrl: `${url.origin}/book?paid=${booking.ref}`,
            cancelUrl: `${url.origin}/book?cancelled=${booking.ref}`,
            notifyUrl: `${url.origin}/api/payments/grow/notify`,
          },
          fetchImpl,
        );
        await store.addPayment({ bookingId: booking.id, processId: page.processId, processToken: page.processToken, sum: booking.price });
      } catch (err) {
        await store.releaseBooking(booking.ref, booking.token);
        log.error('Opening the payment page failed:', err?.message || String(err));
        throw new HttpError(502, 'payment_unavailable');
      }
      // The token lets this browser release the held time if the client changes their mind.
      return json({ booking: summary, payUrl: page.url, token: booking.token }, 201);
    }

    if (route === 'GET /api/bookings/status') {
      if (mode !== 'pay' && mode !== 'transfer') throw notFound();
      const booking = await store.bookingByRef(String(url.searchParams.get('ref') || '').slice(0, 12));
      if (!booking) throw notFound();
      return json({ status: booking.status }); // only the status: no one else's details
    }

    if (route === 'POST /api/bookings/release') {
      if (mode !== 'pay') throw notFound();
      const released = await store.releaseBooking(str(body.ref, 12), str(body.token, 64));
      return json({ ok: true, released });
    }

    if (route === 'POST /api/contact') {
      if (mode !== 'online') throw notFound();
      if (await overLimit(env.FORMS_LIMIT, `${ip} contact`)) throw tooMany();
      const b = body;
      const msg = { name: str(b.name, 80), phone: str(b.phone, 30), email: str(b.email, 120), message: str(b.message, 2000) };
      const bad = [];
      if (msg.name.length < 2) bad.push('name');
      if (msg.phone && !PHONE_RE.test(msg.phone)) bad.push('phone');
      if (msg.email && !EMAIL_RE.test(msg.email)) bad.push('email');
      if (!msg.phone && !msg.email) bad.push('phone', 'email');
      if (msg.message.length < 2) bad.push('message');
      // Honeypot field: real visitors never fill it in.
      if (b.website) return json({ ok: true }, 201);
      if (bad.length) throw invalid(bad);
      await store.addMessage(msg);
      noMail('new message');
      return json({ ok: true }, 201);
    }

    // ---------- Signing in on the site: clients (and managers) with Google, clients by SMS ----------

    // Who is signed in, the sessions left on their card and their bookings; and which ways to
    // sign in are on (none until migrations/0006 is applied and Google's or Twilio's secrets are set).
    if (route === 'GET /api/account') {
      const ways = await signInWays(env, url, mode);
      const account = mode === 'whatsapp' ? null : await currentAccount(request, env);
      if (!account) return json({ ...ways, signedIn: false });
      const accounts = accountsFor(env);
      const client = await accounts.clientFor(account);
      const phone = client?.phone || account.phone || null;
      return json({
        ...ways,
        signedIn: true,
        via: account.google_sub ? 'google' : 'phone',
        name: client?.name || account.name || '',
        email: account.google_email || client?.email || '',
        phone,
        // A Google account shows a card once its phone number is proven (or David connects it).
        phoneProven: Boolean(account.phone),
        client: client ? { cardLeft: client.card_left } : null,
        bookings: client || phone ? await accounts.bookingsFor({ clientId: client?.id ?? null, phone, today: now().date }) : [],
      });
    }

    if (route === 'POST /api/account/logout') {
      const token = readCookie(request, CLIENT_COOKIE);
      if (token) await accountsFor(env).endSession(await hashCode(token)).catch((err) => {
        if (!missingTables(err)) throw err;
      });
      return json({ ok: true }, 200, { 'Set-Cookie': clientCookie('', 0) });
    }

    // To Google's sign-in page: for a client, a manager, or a manager connecting their account.
    if (route === 'POST /api/auth/google/start') {
      const kind = GOOGLE_FOR[body.for];
      if (!kind) throw invalid(['for']);
      const google = googleSettings(env, settingsFor(url));
      if (!google || !(await signInReady(env)) || (kind === 'c' && mode === 'whatsapp')) throw notFound();
      if (await overLimit(env.FORMS_LIMIT, `${ip} google`)) throw tooMany();
      let handle = null;
      if (kind === 'l') {
        // Only right after signing in (as for saving the sign-in on another device).
        const me = await requireAdmin(request, env);
        if (!me.id) throw new HttpError(403, 'passkeys_only');
        if (clock().getTime() - me.signedInAt > FRESH_MINUTES * 60_000) throw new HttpError(403, 'reauth_required');
        handle = String(me.id);
      } else if (kind === 'c') {
        // A sign-in this browser already has ends once the new one is in (Google's way back
        // can't carry its cookie, so it's noted now).
        const old = readCookie(request, CLIENT_COOKIE);
        if (old && old.length <= 100) handle = await hashCode(old);
      }
      const state = `${kind}${randomCode(16)}`;
      const verifier = randomCode(32); // the sign-in's secret (PKCE): it never leaves the server
      const browser = randomCode(16);
      await openAdminStore(env.DB, clock).addChallenge({
        id: state,
        challenge: verifier,
        purpose: GOOGLE_PURPOSE[kind],
        inviteHash: await hashCode(browser),
        handle,
        minutes: 10,
      });
      const to = await googleAuthUrl(google, { state, verifier, redirectUri: callbackUrl(url.origin), lang: body.lang });
      return json({ url: to }, 200, { 'Set-Cookie': oauthCookie(browser) });
    }

    // Back from Google's page. Only for the browser that started this sign-in, once, within
    // 10 minutes; the answer is checked with Google itself (worker/google.js).
    if (route === 'GET /api/auth/google/callback') {
      const q = url.searchParams;
      const state = String(q.get('state') || '');
      const kind = /^[cal][\w-]{20,24}$/.test(state) ? state[0] : null;
      const done = (status, cookies = []) => backTo(url, `${kind === 'a' || kind === 'l' ? '/admin' : '/book'}#signin=${status}`, [oauthCookie('', 0), ...cookies]);
      if (!kind) return done('failed');
      const challenge = await openAdminStore(env.DB, clock).takeChallenge(state, GOOGLE_PURPOSE[kind]);
      const browser = readCookie(request, OAUTH_COOKIE);
      if (!challenge || !browser || (await hashCode(browser)) !== challenge.invite_hash) return done('expired');
      if (q.has('error')) return done(q.get('error') === 'access_denied' ? 'cancelled' : 'failed');
      const google = googleSettings(env, settingsFor(url));
      if (!google) return done('failed');
      let who;
      try {
        const idToken = await exchangeCode(google, { code: q.get('code'), verifier: challenge.challenge, redirectUri: callbackUrl(url.origin) }, fetchImpl);
        who = await verifyIdToken(google, idToken, { nonce: await nonceFor(challenge.challenge), now: clock().getTime() }, fetchImpl);
      } catch (err) {
        if (!(err instanceof GoogleError)) throw err;
        log.error('Google sign-in refused:', err.message);
        return done(err.code === 'unverified' ? 'unverified' : 'failed');
      }
      const accounts = accountsFor(env);
      if (kind === 'c') {
        const account = await accounts.googleAccount({ ...who, name: str(who.name, 80) });
        if (challenge.handle) await accounts.endSession(challenge.handle);
        return done('ok', [await startClientSession(env, account.id)]);
      }
      if (kind === 'a') {
        // Only a manager who connected this Google account in the admin panel.
        const adminId = await accounts.adminByGoogle(who.sub);
        return adminId == null ? done('unknown') : done('ok', [await startSession(env, adminId)]);
      }
      return done(await accounts.linkAdminGoogle(Number(challenge.handle), who));
    }

    // A sign-in code by SMS (only to an Israeli mobile number).
    if (route === 'POST /api/account/phone/start' || route === 'POST /api/account/phone/check') {
      const sms = smsSettings(env, settingsFor(url));
      if (!sms || mode === 'whatsapp' || !(await signInReady(env))) throw notFound();
      const checking = route.endsWith('/check');
      if (await overLimit(env.FORMS_LIMIT, `${ip} ${checking ? 'sms-check' : 'sms'}`)) throw tooMany();
      const phone = phoneKey(str(body.phone, 30));
      const code = str(body.code, 20).replace(/[\s-]+/g, '');
      const bad = [];
      if (!isIsraeliMobile(phone)) bad.push('phone');
      if (checking && !CODE_RE.test(code)) bad.push('code');
      if (bad.length) throw invalid(bad);
      let right = false;
      try {
        if (!checking) {
          await sendCode(sms, { phone, lang: body.lang }, fetchImpl);
          return json({ ok: true });
        }
        right = await checkCode(sms, { phone, code }, fetchImpl);
      } catch (err) {
        if (!(err instanceof SmsError)) throw err;
        if (err.code === 'phone') throw invalid(['phone']);
        if (err.code === 'expired') throw new HttpError(400, 'code_expired', { fields: ['code'] });
        if (err.code === 'too_many') throw tooMany();
        log.error('Twilio failed:', err.message);
        throw new HttpError(502, 'sms_failed');
      }
      if (!right) throw new HttpError(400, 'code_wrong', { fields: ['code'] });
      const accounts = accountsFor(env);
      const current = await currentAccount(request, env);
      // Signed in with Google: the number is proven to be theirs, and their card shows.
      if (current?.google_sub) {
        await accounts.setPhone(current.id, phone);
        return json({ ok: true });
      }
      const account = await accounts.phoneAccount(phone);
      const old = readCookie(request, CLIENT_COOKIE);
      if (old) await accounts.endSession(await hashCode(old)); // (a sign-in with another number ends)
      return json({ ok: true }, 200, { 'Set-Cookie': await startClientSession(env, account.id) });
    }

    // ---------- Admin API (behind Cloudflare Access) ----------

    const admins = openAdminStore(env.DB, clock);

    if (route === 'GET /api/admin/session') {
      const admin = await currentAdmin(request, env);
      const ways = await signInWays(env, url, mode);
      return json({
        enabled: true,
        loggedIn: Boolean(admin),
        passkeys: true,
        name: admin?.name,
        access: Boolean(accessSettings(env)),
        // The "האתר" tab: his texts, photos and notices (photos only once MEDIA is set up).
        editor: true,
        media: Boolean(env.MEDIA),
        // Signing in with Google: managers, and clients on the booking page (with the Gmail he
        // connects to a client's card).
        google: Boolean(googleSettings(env, settingsFor(url))) && (await signInReady(env)),
        clientGoogle: ways.google,
      });
    }

    // Signing in with a passkey: a fresh challenge, which the phone signs after Face ID.
    if (route === 'POST /api/admin/passkey/login/start') {
      const id = randomCode(16);
      const challenge = randomCode(32);
      await admins.addChallenge({ id, challenge, purpose: 'login' });
      return json({ id, publicKey: { challenge, rpId: url.hostname, timeout: 120_000, userVerification: 'required' } });
    }

    if (route === 'POST /api/admin/passkey/login/finish') {
      if (await overLimit(env.FORMS_LIMIT, `${ip} admin`)) throw tooMany();
      const challenge = await admins.takeChallenge(body.id, 'login');
      if (!challenge) throw new HttpError(400, 'challenge_expired');
      const stored = await admins.passkey(body.credential?.id);
      if (!stored || stored.rp_id !== url.hostname) throw new HttpError(401, 'passkey_unknown');
      let signCount;
      try {
        signCount = await verifyLogin(body.credential, stored, { challenge: challenge.challenge, origin: url.origin, rpId: url.hostname });
      } catch (err) {
        if (err instanceof PasskeyError) throw new HttpError(401, 'passkey_failed');
        throw err;
      }
      await admins.touchPasskey(stored.id, signCount);
      return json({ ok: true, name: stored.name }, 200, { 'Set-Cookie': await startSession(env, stored.admin_id) });
    }

    // A new passkey, with a one-time invite link.
    if (route === 'POST /api/admin/passkey/register/start') {
      const invite = await admins.openInvite(await hashCode(str(body.invite, 100)));
      if (!invite) throw new HttpError(403, 'invite_invalid');
      const id = randomCode(16);
      const challenge = randomCode(32);
      const handle = randomCode(16);
      await admins.addChallenge({ id, challenge, purpose: 'register', inviteHash: invite.code_hash, handle });
      const person = invite.name || 'admin';
      return json({
        id,
        name: invite.name || '',
        publicKey: {
          challenge,
          rp: { name: config.business.name.he, id: url.hostname },
          user: { id: handle, name: person, displayName: person },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          attestation: 'none',
          timeout: 120_000,
        },
      });
    }

    if (route === 'POST /api/admin/passkey/register/finish') {
      if (await overLimit(env.FORMS_LIMIT, `${ip} admin`)) throw tooMany();
      const challenge = await admins.takeChallenge(body.id, 'register');
      if (!challenge) throw new HttpError(400, 'challenge_expired');
      let passkey;
      try {
        passkey = await verifyRegistration(body.credential, { challenge: challenge.challenge, origin: url.origin, rpId: url.hostname });
      } catch (err) {
        if (err instanceof PasskeyError) throw new HttpError(400, 'passkey_failed');
        throw err;
      }
      const invite = await admins.openInvite(challenge.invite_hash);
      if (!invite || !(await admins.useInvite(challenge.invite_hash))) throw new HttpError(403, 'invite_invalid');
      const name = str(body.name, 60) || invite.name || 'מנהל';
      const admin = await admins.addAdmin(name, challenge.handle);
      await admins.addPasskey({ ...passkey, adminId: admin.id, rpId: url.hostname });
      return json({ ok: true, name }, 201, { 'Set-Cookie': await startSession(env, admin.id) });
    }

    if (route === 'POST /api/admin/logout') {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) await admins.endSession(await hashCode(token));
      const viaAccess = Boolean(readCookie(request, 'CF_Authorization') || request.headers.get('Cf-Access-Jwt-Assertion'));
      return json({ ok: true, redirect: viaAccess ? ACCESS_LOGOUT : undefined }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (path.startsWith('/api/admin/')) {
      const me = await requireAdmin(request, env);
      const today = now().date;

      // ---------- Saving the sign-in on this device: one more passkey for the same person ----------
      // Only right after signing in (on a computer, usually with the phone), so a session cookie
      // alone can never add a passkey later.
      if (route === 'POST /api/admin/passkey/add/start') {
        if (!me.id) throw new HttpError(403, 'passkeys_only');
        if (clock().getTime() - me.signedInAt > FRESH_MINUTES * 60_000) throw new HttpError(403, 'reauth_required');
        const id = randomCode(16);
        const challenge = randomCode(32);
        await admins.addChallenge({ id, challenge, purpose: 'add', handle: me.handle });
        const existing = await admins.passkeyIds(me.id);
        return json({
          id,
          publicKey: {
            challenge,
            rp: { name: config.business.name.he, id: url.hostname },
            user: { id: me.handle, name: me.name, displayName: me.name },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            // This device's own Face ID, Touch ID or Windows Hello, not the phone again.
            authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
            excludeCredentials: existing.map((cid) => ({ type: 'public-key', id: cid })),
            attestation: 'none',
            timeout: 120_000,
          },
        });
      }

      if (route === 'POST /api/admin/passkey/add/finish') {
        if (!me.id) throw new HttpError(403, 'passkeys_only');
        if (await overLimit(env.FORMS_LIMIT, `${ip} admin`)) throw tooMany();
        const challenge = await admins.takeChallenge(body.id, 'add');
        if (!challenge || challenge.handle !== me.handle) throw new HttpError(400, 'challenge_expired');
        let passkey;
        try {
          passkey = await verifyRegistration(body.credential, { challenge: challenge.challenge, origin: url.origin, rpId: url.hostname });
        } catch (err) {
          if (err instanceof PasskeyError) throw new HttpError(400, 'passkey_failed');
          throw err;
        }
        if (await admins.passkey(passkey.id)) throw new HttpError(409, 'already_added');
        await admins.addPasskey({ ...passkey, adminId: me.id, rpId: url.hostname });
        return json({ ok: true }, 201);
      }

      // ---------- The people who may sign in ----------
      if (route === 'GET /api/admin/admins') {
        const google = await accountsFor(env)
          .adminGoogleEmails()
          .catch((err) => {
            if (missingTables(err)) return new Map();
            throw err;
          });
        const list = (await admins.listAdmins()).map((a) => ({ ...a, google: google.get(a.id) ?? null }));
        return json({ admins: list, me: me.id ?? null });
      }

      // Disconnecting one's own Google account (signing in with Face ID still works).
      if (route === 'DELETE /api/admin/google') {
        if (!me.id) throw new HttpError(403, 'passkeys_only');
        if (!(await signInReady(env)) || !(await accountsFor(env).unlinkAdminGoogle(me.id))) throw notFound();
        return json({ ok: true });
      }

      if (route === 'POST /api/admin/invites') {
        const code = randomCode(24);
        const hours = 48;
        await admins.addInvite({ hash: await hashCode(code), name: str(body.name, 60), createdBy: me.id, hours });
        return json({ link: `${url.origin}/admin#invite=${code}`, hours }, 201);
      }

      const person = /^\/api\/admin\/admins\/(\d{1,12})$/.exec(path);
      if (method === 'DELETE' && person) {
        if (Number(person[1]) === me.id) throw new HttpError(409, 'cannot_remove_self');
        if (!(await admins.removeAdmin(Number(person[1])))) throw notFound();
        return json({ ok: true });
      }

      // ---------- The site: his texts, photos and prices, and the notices ----------
      const editor = contentFor(env);

      if (route === 'GET /api/admin/content') {
        return json({
          content: await editor.content(),
          media: Boolean(env.MEDIA),
          // As they come with the site, for "back to the original"
          defaults: {
            services: config.services.map((s) => ({ id: s.id, name: s.name.he, description: s.description.he, image: s.image })),
            prices: { session: config.prices.session.price, packSessions: config.prices.pack.sessions, pack: config.prices.pack.price },
          },
        });
      }

      if (route === 'PUT /api/admin/content') {
        const current = await editor.content();
        const { content, bad } = applyContentPatch(current, body, { services: config.services });
        if (bad.length) throw invalid(bad);
        // A photo uploaded a moment ago must be there in every size before the site uses it.
        if (!(await uploadsExist(env.MEDIA, newUploads(current, content)))) throw invalid(['photo_missing']);
        await editor.saveContent(content);
        return json({ content });
      }

      if (route === 'GET /api/admin/notices') return json({ notices: await editor.listNotices() });

      if (route === 'POST /api/admin/notices') {
        const { notice, bad } = noticeFields(body, { tz, now: clock() });
        if (bad.length) throw invalid(bad);
        return json({ notice: await editor.addNotice(notice) }, 201);
      }

      const noticePath = /^\/api\/admin\/notices\/(\d{1,12})$/.exec(path);
      if (noticePath && method === 'PUT') {
        const { notice, bad } = noticeFields(body, { tz, now: clock() });
        if (bad.length) throw invalid(bad);
        const row = await editor.updateNotice(Number(noticePath[1]), notice);
        if (!row) throw notFound();
        return json({ notice: row });
      }
      if (noticePath && method === 'DELETE') {
        if (!(await editor.removeNotice(Number(noticePath[1])))) throw notFound();
        return json({ ok: true });
      }

      // ---------- David's clients ----------
      const clientFields = (b) => {
        const c = { name: str(b.name, 80), phone: phoneKey(str(b.phone, 30)), email: str(b.email, 120), notes: str(b.notes, 2000), cardLeft: b.cardLeft ?? 0 };
        const bad = [];
        if (c.name.length < 2) bad.push('name');
        if (c.phone.length < 7 || c.phone.length > 15) bad.push('phone');
        if (c.email && !EMAIL_RE.test(c.email)) bad.push('email');
        if (!Number.isInteger(c.cardLeft) || c.cardLeft < 0 || c.cardLeft > 100) bad.push('cardLeft');
        // The Gmail address the client signs in with on the site (only when he sends it).
        if ('google' in b) {
          c.google = str(b.google, 120);
          if (c.google && !EMAIL_RE.test(c.google)) bad.push('google');
        }
        if (bad.length) throw invalid(bad);
        return c;
      };
      // Before saving: another client already signs in with that Gmail address.
      const googleTaken = async (c, id = null) => Boolean(c.google) && (await signInReady(env)) && (await accountsFor(env).googleTaken(c.google, id));
      const saveGoogle = async (c, id) => {
        if (c.google === undefined || !(await signInReady(env))) return;
        if (!(await accountsFor(env).setClientGoogle(id, c.google))) throw new HttpError(409, 'google_taken');
      };
      // What the client form shows of signing in: the Gmail he connected, and the last sign-in.
      const signInOf = async (id) => {
        if (!(await signInReady(env))) return {};
        const accounts = accountsFor(env);
        return { google: (await accounts.clientGoogle(id)) ?? '', lastSignIn: (await accounts.lastSignIn(id)) ?? null };
      };

      if (route === 'GET /api/admin/clients') return json({ clients: await admins.listClients(url.searchParams.get('q'), today) });

      if (route === 'POST /api/admin/clients') {
        const fields = clientFields(body);
        if (await googleTaken(fields)) throw new HttpError(409, 'google_taken');
        const client = await admins.addClient(fields);
        if (!client) throw new HttpError(409, 'phone_taken');
        await saveGoogle(fields, client.id);
        return json({ client: { ...client, ...(await signInOf(client.id)) } }, 201);
      }

      const clientPath = /^\/api\/admin\/clients\/(\d{1,12})$/.exec(path);
      if (clientPath) {
        const id = Number(clientPath[1]);
        if (method === 'GET') {
          const client = await admins.client(id);
          if (!client) throw notFound();
          return json({ client: { ...client, ...(await signInOf(id)) }, bookings: await admins.clientBookings(id) });
        }
        if (method === 'PUT') {
          const fields = clientFields(body);
          if (await googleTaken(fields, id)) throw new HttpError(409, 'google_taken');
          const client = await admins.updateClient(id, fields);
          if (client === false) throw new HttpError(409, 'phone_taken');
          if (!client) throw notFound();
          await saveGoogle(fields, id);
          return json({ client: { ...client, ...(await signInOf(id)) } });
        }
        if (method === 'DELETE') {
          if (!(await admins.forgetClient(id))) throw notFound();
          return json({ ok: true });
        }
      }

      if (route === 'GET /api/admin/bookings') {
        const bookings = await store.listBookings(url.searchParams.get('scope'), today);
        // A session from a card: how many the client has left, to check before approving.
        for (const b of bookings) {
          if (b.plan === 'card' && b.status === 'pending') b.card_left = (await admins.clientByPhone(b.phone))?.card_left ?? null;
        }
        return json({ bookings });
      }

      // David saw the payment (or the card) and approves: the booking is confirmed, the client
      // is in his list, a new card adds its other sessions and a card session takes one.
      const approve = /^\/api\/admin\/bookings\/(\d{1,12})\/approve$/.exec(path);
      if (method === 'POST' && approve) {
        const waiting = await store.bookingById(Number(approve[1]));
        if (!waiting) throw notFound();
        if (!waiting.plan || !['pending', 'expired'].includes(waiting.status)) throw new HttpError(409, 'not_waiting');
        const booking = await store.confirmBooking(waiting.id);
        if (!booking) throw new HttpError(409, 'slot_taken');
        await store.markBookingApproved(booking.id);
        let cardLeft = null;
        const clientId = await admins.clientFromBooking(booking);
        const pack = (await siteFor(env)).prices.pack;
        if (clientId && booking.plan === 'pack') cardLeft = await admins.addCardSessions(clientId, pack.sessions - 1);
        if (clientId && booking.plan === 'card') cardLeft = await admins.addCardSessions(clientId, -1);
        ctx?.waitUntil?.(afterConfirmed(env, store, booking)); // the calendar
        return json({ booking, cardLeft });
      }

      // A confirmed session that came off a card (or a new card's first one) goes back on it.
      // (A late cancellation he wants to count: he takes the session off in the client's card.)
      const cancel = /^\/api\/admin\/bookings\/(\d{1,12})\/cancel$/.exec(path);
      if (method === 'POST' && cancel) {
        const before = await store.bookingById(Number(cancel[1]));
        const booking = await store.cancelBooking(Number(cancel[1]));
        if (!booking) throw notFound();
        let cardLeft = null;
        if (before?.status === 'confirmed' && booking.client_id && (booking.plan === 'card' || booking.plan === 'pack')) {
          cardLeft = await admins.addCardSessions(booking.client_id, 1);
        }
        return json({ booking, cardLeft });
      }

      if (route === 'GET /api/admin/schedule') {
        return json({ schedule: await store.getSchedule(), blocked: await store.listBlocked(today) });
      }

      if (route === 'PUT /api/admin/schedule') {
        const s = body;
        const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
        const bad = [];
        if (!int(s.slotInterval, 5, 240)) bad.push('slotInterval');
        if (!int(s.bufferMinutes, 0, 240)) bad.push('bufferMinutes');
        if (!int(s.minNoticeHours, 0, 24 * 14)) bad.push('minNoticeHours');
        if (!int(s.maxDaysAhead, 1, 365)) bad.push('maxDaysAhead');

        const weeklyHours = {};
        for (let d = 0; d < 7; d++) {
          const ranges = s.weeklyHours?.[d] ?? s.weeklyHours?.[String(d)] ?? [];
          const ok =
            Array.isArray(ranges) &&
            ranges.length <= 6 &&
            ranges.every((r) => Array.isArray(r) && isValidTime(r[0]) && isValidTime(r[1]) && r[0] < r[1]);
          if (!ok) bad.push(`weeklyHours.${d}`);
          else weeklyHours[d] = [...ranges].sort((a, b) => a[0].localeCompare(b[0]));
        }
        if (bad.length) throw invalid(bad);

        const schedule = {
          weeklyHours,
          slotInterval: s.slotInterval,
          bufferMinutes: s.bufferMinutes,
          minNoticeHours: s.minNoticeHours,
          maxDaysAhead: s.maxDaysAhead,
        };
        await store.setSchedule(schedule);
        return json({ schedule });
      }

      // One day ({ date }) or a run of days ({ from, to }: a vacation in one go, up to a year).
      if (route === 'POST /api/admin/blocked') {
        const from = body.from ?? body.date;
        const to = body.to ?? from;
        if (!isValidDate(from) || !isValidDate(to) || to < from || dayIndex(to) - dayIndex(from) >= 366) throw invalid(['date']);
        if (from === to) await store.addBlocked(from, str(body.note, 120));
        else await store.addBlockedRange(from, to, str(body.note, 120));
        return json({ blocked: await store.listBlocked(today) }, 201);
      }

      const unblock = /^\/api\/admin\/blocked\/(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(path);
      if (method === 'DELETE' && unblock) {
        const [, from, to] = unblock;
        if (to) {
          if (!isValidDate(from) || !isValidDate(to) || to < from) throw invalid(['date']);
          if (!(await store.removeBlockedRange(from, to))) throw notFound();
        } else if (!(await store.removeBlocked(from))) throw notFound();
        return json({ blocked: await store.listBlocked(today) });
      }

      if (route === 'GET /api/admin/messages') return json({ messages: await store.listMessages() });

      const read = /^\/api\/admin\/messages\/(\d{1,12})\/read$/.exec(path);
      if (method === 'POST' && read) {
        if (!(await store.markMessageRead(Number(read[1])))) throw notFound();
        return json({ ok: true });
      }

      const remove = /^\/api\/admin\/messages\/(\d{1,12})$/.exec(path);
      if (method === 'DELETE' && remove) {
        if (!(await store.deleteMessage(Number(remove[1])))) throw notFound();
        return json({ ok: true });
      }
    }

    throw notFound();
  }

  /**
   * Every few minutes (wrangler.jsonc → triggers): payments Grow hasn't told us about are
   * asked about directly, held times that ran out are released, and confirmed bookings
   * that didn't reach the calendar are tried again.
   */
  async function scheduled(env) {
    const store = storeFor(env);
    if (growSettings(env)) {
      for (const payment of await store.openPayments(new Date(clock().getTime() - RECONCILE_HOURS * 3_600_000))) {
        try {
          await settle(env, store, payment);
        } catch (err) {
          log.error('Checking a payment with Grow failed:', err?.message || String(err));
        }
      }
    }
    await store.expireHolds();
    await openAdminStore(env.DB, clock).purge();
    await accountsFor(env)
      .purge()
      .catch((err) => {
        if (!missingTables(err)) throw err;
      });
    // Once a day: photos he uploaded that nothing on the site uses any more.
    const at = clock();
    if (env.MEDIA && at.getUTCHours() === 2 && at.getUTCMinutes() < 10) {
      try {
        await removeUnusedUploads(env.MEDIA, await contentFor(env).content(), at);
      } catch (err) {
        log.error('Removing unused photos failed:', err?.message || String(err));
      }
    }
    if (calendarSettings(env)) {
      for (const booking of await store.missingFromCalendar(now().date)) await afterConfirmed(env, store, booking);
    }
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      try {
        if (url.pathname === '/healthz') return json({ ok: true });
        // Only encrypted: a page asked for over plain http moves to its https address, and
        // nothing is taken over plain http (on this computer, while developing, it's allowed).
        if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
          if (url.pathname.startsWith('/api/')) return json({ error: 'https_required' }, 403);
          url.protocol = 'https:';
          return new Response(null, { status: 301, headers: { Location: url.toString() } });
        }
        if (url.pathname.startsWith('/api/')) return await api(request, env, url, ctx);
        const read = request.method === 'GET' || request.method === 'HEAD';
        const photo = /^\/media\/([a-z2-7]{16}-\d{3,4})\.jpg$/.exec(url.pathname);
        if (photo && read) return await media(request, env, photo[1]);
        if (PAGES.has(url.pathname) && read) {
          try {
            return await page(request, env, url);
          } catch (err) {
            log.error('Serving the page failed:', err?.stack || String(err));
            return env.ASSETS.fetch(request);
          }
        }
        // Other pages and files: Cloudflare serves them without the Worker (wrangler.jsonc →
        // assets.run_worker_first), so this is only a fallback.
        return env.ASSETS.fetch(request);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.code, ...err.more }, err.status, err.headers);
        log.error('API error:', err?.stack || String(err));
        return json({ error: 'server_error' }, 500);
      }
    },
    async scheduled(controller, env) {
      await scheduled(env);
    },
  };
}

export default createWorker();
