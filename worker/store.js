// The site's data on Cloudflare D1: bookings, blocked days, the opening-hours settings, contact
// messages and payments. The same functions as the Node server's store (server/store.js),
// made async because D1 answers over the network, plus what payment at booking needs.

import { slotsForDay } from '../server/availability.js';
import { addDays, toMinutes } from '../server/time.js';

export class SlotTakenError extends Error {}

// 32 letters and digits (no 0/O or 1/I), so every random byte maps evenly onto one.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
}
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// A booking's start as minutes after midnight, worked out from its "HH:MM" column.
const start = (t = '') => `(CAST(substr(${t}time, 1, 2) AS INTEGER) * 60 + CAST(substr(${t}time, 4, 2) AS INTEGER))`;
// A booking that takes its time: confirmed, or waiting for its payment while its hold lasts.
const takes = (t = '', now) => `(${t}status = 'confirmed' OR (${t}status = 'pending' AND ${t}hold_until > ${now}))`;
// D1's own timestamps (datetime('now')) look like "2026-10-01 05:00:00".
export const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

export function openD1Store(db, defaultSchedule, clock = () => new Date()) {
  const nowIso = () => clock().toISOString();

  async function getSchedule() {
    const value = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('schedule').first('value');
    return { ...defaultSchedule, ...(value ? JSON.parse(value) : {}) };
  }

  async function setSchedule(schedule) {
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('schedule', JSON.stringify(schedule))
      .run();
  }

  /**
   * { "YYYY-MM-DD": ["09:00", …] } for every day in [from, to]. `busy` adds times taken
   * elsewhere (the calendar): { "YYYY-MM-DD": [{ start, end }] (minutes) or "all" }.
   */
  async function availability({ from, to, duration, now, schedule, busy = {} }) {
    schedule ??= await getSchedule();
    const [bookings, blocked] = await db.batch([
      db
        .prepare(`SELECT date, time, duration FROM bookings WHERE ${takes('', '?3')} AND date BETWEEN ?1 AND ?2`)
        .bind(from, to, nowIso()),
      db.prepare('SELECT date FROM blocked_dates WHERE date BETWEEN ? AND ?').bind(from, to),
    ]);
    const byDate = new Map();
    const add = (date, range) => {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(range);
    };
    for (const b of bookings.results) {
      const s = toMinutes(b.time);
      add(b.date, { start: s, end: s + b.duration });
    }
    for (const [date, ranges] of Object.entries(busy)) if (Array.isArray(ranges)) for (const r of ranges) add(date, r);
    const closed = new Set(blocked.results.map((r) => r.date));

    const days = {};
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days[d] = slotsForDay({
        date: d,
        duration,
        schedule,
        dayBookings: byDate.get(d),
        blocked: closed.has(d) || busy[d] === 'all',
        now,
      });
    }
    return days;
  }

  /**
   * Checks the time is free, then adds the booking in one statement that only goes in when no
   * other booking takes an overlapping time (with the break around it), so two people can't
   * get the same time together. With `hold` (minutes) or `holdUntil` (a moment), the booking
   * waits for its payment as 'pending' and keeps the time until then. Throws SlotTakenError
   * when the time isn't free.
   */
  async function createBooking(b, now, { hold = 0, holdUntil = null, busy } = {}) {
    const schedule = await getSchedule();
    const free = (await availability({ from: b.date, to: b.date, duration: b.duration, now, schedule, busy }))[b.date];
    if (!free.includes(b.time)) throw new SlotTakenError('slot not available');

    const until = holdUntil ? new Date(holdUntil).toISOString() : hold > 0 ? new Date(clock().getTime() + hold * 60_000).toISOString() : null;
    const pending = Boolean(until);
    const insert = db.prepare(`
      INSERT INTO bookings (ref, service_id, date, time, duration, name, phone, email, notes, lang, status, price, hold_until, token, plan)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?13, ?14, ?15, ?16, ?18
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings
        WHERE date = ?3 AND ${takes('', '?17')}
          AND ?11 < ${start()} + duration + ?12
          AND ${start()} < ?11 + ?5 + ?12
      )
      RETURNING *`);
    for (let attempt = 1; ; attempt++) {
      try {
        const row = await insert
          .bind(
            newRef(), b.serviceId, b.date, b.time, b.duration, b.name, b.phone, b.email || null, b.notes || null, b.lang,
            toMinutes(b.time), schedule.bufferMinutes,
            pending ? 'pending' : 'confirmed', b.price ?? null, until, pending ? newToken() : null, nowIso(), b.plan ?? null,
          )
          .first();
        if (!row) throw new SlotTakenError('slot not available');
        return row;
      } catch (err) {
        // The confirmation number is random: on the rare repeat, draw another one.
        if (attempt < 3 && /UNIQUE constraint failed: bookings\.ref/.test(String(err?.message))) continue;
        throw err;
      }
    }
  }

  /**
   * A paid booking takes its time for good – unless, after its hold ran out, someone else got
   * an overlapping time: then it stays as it was, and null comes back.
   */
  async function confirmBooking(id) {
    const { bufferMinutes } = await getSchedule();
    return db
      .prepare(`
        UPDATE bookings SET status = 'confirmed', hold_until = NULL, token = NULL
        WHERE id = ?1 AND status IN ('pending', 'expired')
          AND NOT EXISTS (
            SELECT 1 FROM bookings AS o
            WHERE o.id != ?1 AND o.date = bookings.date AND ${takes('o.', '?2')}
              AND ${start('bookings.')} < ${start('o.')} + o.duration + ?3
              AND ${start('o.')} < ${start('bookings.')} + bookings.duration + ?3
          )
        RETURNING *`)
      .bind(id, nowIso(), bufferMinutes)
      .first();
  }

  async function listBookings(scope, today) {
    const sql =
      scope === 'past'
        ? "SELECT * FROM bookings WHERE status = 'confirmed' AND date < ?1 ORDER BY date DESC, time DESC LIMIT 200"
        : scope === 'cancelled'
          ? "SELECT * FROM bookings WHERE status = 'cancelled' ORDER BY date DESC, time DESC LIMIT 200"
          : // Coming up: confirmed, and those still waiting for the payment to be approved.
            `SELECT * FROM bookings WHERE ${takes('', '?2')} AND date >= ?1 ORDER BY date, time`;
    const stmt = db.prepare(sql);
    return (await (scope === 'cancelled' ? stmt : scope === 'past' ? stmt.bind(today) : stmt.bind(today, nowIso())).all()).results;
  }

  async function cancelBooking(id) {
    return db
      .prepare("UPDATE bookings SET status = 'cancelled', hold_until = NULL WHERE id = ? AND status IN ('confirmed', 'pending') RETURNING *")
      .bind(id)
      .first();
  }

  const changed = (result) => (result.meta?.changes ?? 0) > 0;

  return {
    getSchedule,
    setSchedule,
    availability,
    createBooking,
    confirmBooking,
    listBookings,
    cancelBooking,
    bookingByRef: (ref) => db.prepare('SELECT * FROM bookings WHERE ref = ?').bind(ref).first(),
    bookingById: (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first(),
    /** David saw the payment (Bit or PayBox) and approved the booking. */
    markBookingApproved: (id) => db.prepare('UPDATE bookings SET approved_at = ? WHERE id = ?').bind(sqlTime(clock()), id).run(),
    /** The client gave up on paying: their held time is free again at once. */
    releaseBooking: async (ref, token) =>
      changed(
        await db
          .prepare("UPDATE bookings SET status = 'expired', hold_until = NULL WHERE ref = ? AND token = ? AND status = 'pending'")
          .bind(ref, token)
          .run(),
      ),
    /** Holds that ran out are marked as such (their time is already free). */
    expireHolds: async () =>
      (await db.prepare("UPDATE bookings SET status = 'expired' WHERE status = 'pending' AND hold_until <= ?").bind(nowIso()).run())
        .meta?.changes ?? 0,

    addPayment: (p) =>
      db
        .prepare('INSERT INTO payments (booking_id, process_id, process_token, sum) VALUES (?, ?, ?, ?)')
        .bind(p.bookingId, p.processId, p.processToken, p.sum)
        .run(),
    paymentByProcess: (processId) => db.prepare('SELECT * FROM payments WHERE process_id = ?').bind(processId).first(),
    /** Payments still waiting for Grow's answer, started since `since` (a Date). */
    openPayments: async (since) =>
      (await db.prepare("SELECT * FROM payments WHERE status = 'created' AND created_at >= ? ORDER BY id").bind(sqlTime(since)).all())
        .results,
    markPaid: (id, t, status = 'paid') =>
      db
        .prepare(`UPDATE payments SET status = ?, transaction_id = ?, transaction_token = ?, asmachta = ?, paid_at = ? WHERE id = ? AND status = 'created'`)
        .bind(status, t.transactionId || null, t.transactionToken || null, t.asmachta || null, sqlTime(clock()), id)
        .run()
        .then(changed),
    markApproved: (id) => db.prepare('UPDATE payments SET approved_at = ? WHERE id = ?').bind(sqlTime(clock()), id).run(),

    markInCalendar: (id) => db.prepare('UPDATE bookings SET calendar_at = ? WHERE id = ?').bind(sqlTime(clock()), id).run(),
    /** Confirmed, upcoming bookings that haven't reached the calendar yet (to try again). */
    missingFromCalendar: async (today) =>
      (
        await db
          .prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND calendar_at IS NULL AND date >= ? ORDER BY date, time LIMIT 20")
          .bind(today)
          .all()
      ).results,

    // (notice_id: the day was closed by a notice on the site, and opens again with it)
    listBlocked: async (today) =>
      (await db.prepare('SELECT date, note, notice_id FROM blocked_dates WHERE date >= ? ORDER BY date').bind(today).all()).results,
    // A day he closes by hand is his, even if a notice had closed it too.
    addBlocked: (date, note) =>
      db
        .prepare('INSERT INTO blocked_dates (date, note) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET note = excluded.note, notice_id = NULL')
        .bind(date, note || null)
        .run(),
    removeBlocked: async (date) => changed(await db.prepare('DELETE FROM blocked_dates WHERE date = ?').bind(date).run()),
    addMessage: (m) =>
      db
        .prepare('INSERT INTO messages (name, phone, email, message) VALUES (?, ?, ?, ?)')
        .bind(m.name, m.phone || null, m.email || null, m.message)
        .run(),
    listMessages: async () =>
      (await db.prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT 200').all()).results,
    markMessageRead: async (id) => changed(await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(id).run()),
    deleteMessage: async (id) => changed(await db.prepare('DELETE FROM messages WHERE id = ?').bind(id).run()),
  };
}
