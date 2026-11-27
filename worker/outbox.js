// What David still has to send his clients on WhatsApp, and when: the admin panel's "הודעות
// לשליחה". He sends each one himself (one tap opens WhatsApp with it written, or he copies it).
//   - invite:   his appointment message, once a booking is confirmed (he approves it);
//   - reminder: the day before (or on the day), unless his appointment message only went then;
//   - cancel:   once he cancels a booking (with the session back on the card, if it went back).
// Kept per booking in settings ('sent:<id>': when it was confirmed or cancelled, and when each
// message went), so nothing is asked twice. Only bookings confirmed or cancelled since this list
// exists ask for the first and the last. A record goes a week after the appointment's day.

import { addDays, nowInZone } from '../server/time.js';

export const OUTBOX_KINDS = ['invite', 'reminder', 'cancel'];
const PREFIX = 'sent:';
const KEEP_DAYS = 7;

const minutesOf = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
};

export function openOutbox(db, { clock = () => new Date(), tz = 'Asia/Jerusalem' } = {}) {
  const stamp = () => clock().toISOString();
  const parse = (value) => {
    try {
      const record = JSON.parse(value);
      return record && typeof record === 'object' ? record : null;
    } catch {
      return null;
    }
  };
  const read = async (id) => parse(await db.prepare('SELECT value FROM settings WHERE key = ?').bind(PREFIX + id).first('value'));
  const all = async () => {
    const rows = (await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'sent:%'").all()).results;
    return rows.map((row) => ({ key: row.key, id: Number(row.key.slice(PREFIX.length)), record: parse(row.value) }));
  };
  const update = async (booking, patch) => {
    const record = { ...(await read(booking.id)), date: booking.date, ...patch };
    await db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(PREFIX + booking.id, JSON.stringify(record))
      .run();
    return record;
  };

  return {
    /** Confirmed: his appointment message is due (unless it already went, by itself). */
    confirmed: (booking, { sent = false } = {}) => update(booking, { confirmed: stamp(), ...(sent ? { invite: stamp() } : {}) }),
    /** Cancelled: the cancel message is due (cardLeft: what's on the card, when a session went back). */
    cancelled: (booking, cardLeft = null) => update(booking, { cancelled: stamp(), cardLeft: Number.isInteger(cardLeft) ? cardLeft : null }),
    /** He sent it (done), or takes that back. */
    mark: (booking, kind, done = true) => update(booking, { [kind]: done ? stamp() : null }),

    /**
     * The messages due now: { kind, booking, cardLeft? }, the ones to send at once (appointment
     * messages and cancellations) first, then the reminders; each by the appointment's time.
     */
    async due(store) {
      const at = nowInZone(tz, clock());
      const today = at.date;
      const tomorrow = addDays(today, 1);
      const passed = (b) => b.date < today || (b.date === today && minutesOf(b.time) <= at.minutes);
      const dayOf = (iso) => nowInZone(tz, new Date(iso)).date;
      const records = new Map((await all()).filter((r) => r.record).map((r) => [r.id, r.record]));
      const items = [];
      for (const b of await store.listBookings('upcoming', today)) {
        if (b.status !== 'confirmed' || passed(b)) continue;
        const r = records.get(b.id);
        if (r?.confirmed && !r.invite) items.push({ kind: 'invite', booking: b });
        else if (
          (b.date === today || b.date === tomorrow) &&
          !r?.reminder &&
          // (his appointment message that went only the day before, or on the day, is reminder enough)
          (!r?.invite || dayOf(r.invite) < addDays(b.date, -1))
        ) {
          items.push({ kind: 'reminder', booking: b });
        }
      }
      for (const [id, r] of records) {
        if (!r.cancelled || r.cancel || !(r.date >= today)) continue;
        const b = await store.bookingById(id);
        if (b?.status === 'cancelled' && !passed(b)) items.push({ kind: 'cancel', booking: b, cardLeft: r.cardLeft ?? null });
      }
      const order = (item) => `${item.kind === 'reminder' ? 1 : 0} ${item.booking.date} ${item.booking.time}`;
      return items.sort((a, b) => order(a).localeCompare(order(b)));
    },

    /** Records of appointments more than a week past. */
    async prune(today) {
      const cutoff = addDays(today, -KEEP_DAYS);
      for (const { key, record } of await all()) {
        if (!record || !(record.date >= cutoff)) await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
      }
    },
  };
}
