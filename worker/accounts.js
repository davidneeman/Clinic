// Signing in on the site, in D1 (migrations/0006): clients who sign in with Google or with their
// phone number, their sessions, the Gmail address David connected to a client's card, and the
// managers' Google accounts. Session cookies are kept only as hashes, so the database alone
// can't be used to sign in.

import { phoneKey } from './admin-store.js';
import { emailKey } from './google.js';

/** True for the error D1 gives before migrations/0006 is applied (the site then works without signing in). */
export const missingTables = (err) => /no such table/.test(String(err?.message));

export function openAccountStore(db, clock = () => new Date()) {
  const now = () => clock().toISOString();
  const later = (minutes) => new Date(clock().getTime() + minutes * 60_000).toISOString();
  const changed = (result) => (result.meta?.changes ?? 0) > 0;
  const CLIENT = 'c.id, c.name, c.phone, c.email, c.card_left';

  return {
    /** True once migrations/0006 is in. */
    async ready() {
      try {
        await db.prepare('SELECT 1 FROM accounts LIMIT 1').first();
        return true;
      } catch (err) {
        if (missingTables(err)) return false;
        throw err;
      }
    },

    // ---------- Clients' accounts ----------
    /** A Google sign-in: the account for this Google id (added the first time), with its details now. */
    googleAccount: ({ sub, email, name }) =>
      db
        .prepare(`
          INSERT INTO accounts (google_sub, google_email, google_key, name, last_login_at) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(google_sub) DO UPDATE SET
            google_email = excluded.google_email, google_key = excluded.google_key, name = excluded.name, last_login_at = excluded.last_login_at
          RETURNING *`)
        .bind(sub, email, emailKey(email), name || null, now())
        .first(),
    /** A sign-in with the phone alone (its code was right): the account for this number. */
    phoneAccount: (phone) =>
      db
        .prepare(`
          INSERT INTO accounts (phone, last_login_at) VALUES (?1, ?2)
          ON CONFLICT(phone) WHERE google_sub IS NULL DO UPDATE SET last_login_at = excluded.last_login_at
          RETURNING *`)
        .bind(phone, now())
        .first(),
    /** A Google account proved this phone number with a code. */
    setPhone: (id, phone) => db.prepare('UPDATE accounts SET phone = ?, last_login_at = ? WHERE id = ? RETURNING *').bind(phone, now(), id).first(),

    addSession: ({ hash, accountId, days }) =>
      db.prepare('INSERT INTO account_sessions (id_hash, account_id, expires_at) VALUES (?, ?, ?)').bind(hash, accountId, later(days * 24 * 60)).run(),
    sessionAccount: (hash) =>
      db.prepare('SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id_hash = ? AND s.expires_at > ?').bind(hash, now()).first(),
    endSession: (hash) => db.prepare('DELETE FROM account_sessions WHERE id_hash = ?').bind(hash).run(),
    /** Clears out sessions that ran out (from the scheduled job). */
    purge: () => db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?').bind(now()).run(),

    /**
     * The client whose card an account sees: the one with the phone number it proved, or the
     * one David connected its Gmail address to. Null when there's none (yet).
     */
    async clientFor(account) {
      if (account?.phone) {
        const byPhone = await db.prepare(`SELECT ${CLIENT} FROM clients c WHERE c.phone = ?`).bind(account.phone).first();
        if (byPhone) return byPhone;
      }
      if (account?.google_key) {
        return db.prepare(`SELECT ${CLIENT} FROM client_google g JOIN clients c ON c.id = g.client_id WHERE g.email_key = ?`).bind(account.google_key).first();
      }
      return null;
    },

    /**
     * What a signed-in client sees of their bookings: those on their card, and those made with
     * their phone number that still wait for David's approval. Upcoming first, then past visits.
     * No notes, no one else's.
     */
    async bookingsFor({ clientId, phone, today }) {
      const cols = 'id, ref, service_id, date, time, duration, status, plan';
      const own = clientId
        ? (
            await db
              .prepare(`
                SELECT ${cols} FROM bookings
                WHERE client_id = ?1 AND (status = 'confirmed' OR (status IN ('pending', 'cancelled') AND date >= ?2))
                ORDER BY date DESC, time DESC LIMIT 60`)
              .bind(clientId, today)
              .all()
          ).results
        : [];
      const waiting = phone
        ? (
            await db
              .prepare(`SELECT ${cols}, phone FROM bookings WHERE client_id IS NULL AND status = 'pending' AND date >= ? ORDER BY date, time LIMIT 300`)
              .bind(today)
              .all()
          ).results.filter((b) => phoneKey(b.phone) === phone)
        : [];
      const seen = new Set();
      const all = [...own, ...waiting].filter((b) => !seen.has(b.id) && seen.add(b.id));
      const at = (b) => `${b.date} ${b.time}`;
      const upcoming = all.filter((b) => b.date >= today).sort((a, b) => at(a).localeCompare(at(b)));
      const past = all.filter((b) => b.date < today && b.status === 'confirmed').sort((a, b) => at(b).localeCompare(at(a)));
      return [...upcoming, ...past].map((b) => ({
        ref: b.ref,
        serviceId: b.service_id,
        date: b.date,
        time: b.time,
        duration: b.duration,
        status: b.status,
        plan: b.plan ?? null,
      }));
    },

    // ---------- In the admin panel: a client's Gmail address, for signing in with Google ----------
    clientGoogle: (clientId) => db.prepare('SELECT email FROM client_google WHERE client_id = ?').bind(clientId).first('email'),
    /** Connects (or, with no address, disconnects) a client's Gmail. False if another client has it. */
    async setClientGoogle(clientId, email) {
      if (!email) {
        await db.prepare('DELETE FROM client_google WHERE client_id = ?').bind(clientId).run();
        return true;
      }
      try {
        await db
          .prepare(`
            INSERT INTO client_google (client_id, email, email_key) VALUES (?1, ?2, ?3)
            ON CONFLICT(client_id) DO UPDATE SET email = excluded.email, email_key = excluded.email_key`)
          .bind(clientId, email, emailKey(email))
          .run();
        return true;
      } catch (err) {
        if (/UNIQUE constraint failed: client_google\.email_key/.test(String(err?.message))) return false;
        throw err;
      }
    },
    /** Whether another client already has this Gmail address (before a new client is added). */
    googleTaken: async (email, clientId = null) =>
      Boolean(await db.prepare('SELECT 1 AS taken FROM client_google WHERE email_key = ? AND client_id IS NOT ?').bind(emailKey(email), clientId).first('taken')),
    /** When the client last signed in on the site: with the phone on their card, or the Gmail he connected. */
    lastSignIn: (clientId) =>
      db
        .prepare(`
          SELECT MAX(a.last_login_at) AS at
          FROM clients c LEFT JOIN client_google g ON g.client_id = c.id
          JOIN accounts a ON a.phone = c.phone OR (g.email_key IS NOT NULL AND a.google_key = g.email_key)
          WHERE c.id = ?`)
        .bind(clientId)
        .first('at'),

    // ---------- Managers' Google accounts ----------
    adminByGoogle: (sub) => db.prepare('SELECT admin_id FROM admin_google WHERE sub = ?').bind(sub).first('admin_id'),
    /**
     * Connects a manager's Google account. → 'linked'; 'taken' if it's already another manager's;
     * 'gone' if the manager was removed meanwhile.
     */
    async linkAdminGoogle(adminId, { sub, email }) {
      const other = await db.prepare('SELECT admin_id FROM admin_google WHERE sub = ?').bind(sub).first('admin_id');
      if (other != null && other !== adminId) return 'taken';
      try {
        const added = await db
          .prepare(`
            INSERT INTO admin_google (admin_id, sub, email) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM admins WHERE id = ?1)
            ON CONFLICT(admin_id) DO UPDATE SET sub = excluded.sub, email = excluded.email, created_at = datetime('now')`)
          .bind(adminId, sub, email)
          .run();
        return changed(added) ? 'linked' : 'gone';
      } catch (err) {
        if (/UNIQUE constraint failed: admin_google\.sub/.test(String(err?.message))) return 'taken';
        throw err;
      }
    },
    unlinkAdminGoogle: async (adminId) => changed(await db.prepare('DELETE FROM admin_google WHERE admin_id = ?').bind(adminId).run()),
    /** admin id → the Gmail address they sign in with. */
    adminGoogleEmails: async () => new Map((await db.prepare('SELECT admin_id, email FROM admin_google').all()).results.map((r) => [r.admin_id, r.email])),
  };
}
