// The admin panel's own data in D1: the people who may sign in, their passkeys, one-time
// invite links, sessions, and David's client list. Codes and session cookies are kept only
// as hashes, so the database alone can't be used to sign in.

const iso = (date) => date.toISOString();

/** A phone number as the client list keys it: digits only, Israeli numbers starting with 0. */
export function phoneKey(phone) {
  let digits = String(phone ?? '').replace(/\D+/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  return digits;
}

export function openAdminStore(db, clock = () => new Date()) {
  const now = () => iso(clock());
  const later = (minutes) => iso(new Date(clock().getTime() + minutes * 60_000));
  const changed = (result) => (result.meta?.changes ?? 0) > 0;

  return {
    countAdmins: async () => Number(await db.prepare('SELECT COUNT(*) AS n FROM admins').first('n')),

    // ---------- Challenges: each used once, within a few minutes ----------
    addChallenge: ({ id, challenge, purpose, inviteHash = null, handle = null, minutes = 5 }) =>
      db
        .prepare('INSERT INTO challenges (id, challenge, purpose, invite_hash, handle, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, challenge, purpose, inviteHash, handle, later(minutes))
        .run(),
    /** The challenge, removed as it's read, so it can't be answered twice. */
    takeChallenge: (id, purpose) =>
      db
        .prepare('DELETE FROM challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING *')
        .bind(String(id ?? ''), purpose, now())
        .first(),

    // ---------- Invites ----------
    addInvite: ({ hash, name, createdBy, hours = 48 }) =>
      db
        .prepare('INSERT INTO invites (code_hash, name, created_by, expires_at) VALUES (?, ?, ?, ?)')
        .bind(hash, name || null, createdBy ?? null, later(hours * 60))
        .run(),
    openInvite: (hash) =>
      db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').bind(hash, now()).first(),
    /** Marks the invite used. False if it was already used or ran out: each link works once. */
    useInvite: async (hash) =>
      changed(
        await db
          .prepare('UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
          .bind(now(), hash, now())
          .run(),
      ),

    // ---------- People and their passkeys ----------
    addAdmin: (name, handle) => db.prepare('INSERT INTO admins (name, handle) VALUES (?, ?) RETURNING *').bind(name, handle).first(),
    // Adding a passkey signs its owner in, so it counts as their latest sign-in.
    addPasskey: (p) =>
      db
        .prepare('INSERT INTO passkeys (id, admin_id, public_key, alg, sign_count, rp_id, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(p.id, p.adminId, p.publicKey, p.alg, p.signCount, p.rpId, now())
        .run(),
    passkey: (id) =>
      db
        .prepare('SELECT p.*, a.name FROM passkeys p JOIN admins a ON a.id = p.admin_id WHERE p.id = ?')
        .bind(String(id ?? ''))
        .first(),
    /** The ids of a person's passkeys: a device that already holds one isn't added twice. */
    passkeyIds: async (adminId) =>
      (await db.prepare('SELECT id FROM passkeys WHERE admin_id = ? ORDER BY created_at').bind(adminId).all()).results.map((r) => r.id),
    touchPasskey: (id, signCount) =>
      db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').bind(signCount, now(), id).run(),
    listAdmins: async () =>
      (
        await db
          .prepare(`
            SELECT a.id, a.name, a.created_at,
              (SELECT COUNT(*) FROM passkeys p WHERE p.admin_id = a.id) AS passkeys,
              (SELECT MAX(p.last_used_at) FROM passkeys p WHERE p.admin_id = a.id) AS last_used
            FROM admins a ORDER BY a.id`)
          .all()
      ).results,
    /** Removes a person: their passkeys and sessions stop working at once. */
    removeAdmin: async (id) => {
      const [, , gone] = await db.batch([
        db.prepare('DELETE FROM sessions WHERE admin_id = ?').bind(id),
        db.prepare('DELETE FROM passkeys WHERE admin_id = ?').bind(id),
        db.prepare('DELETE FROM admins WHERE id = ?').bind(id),
      ]);
      return changed(gone);
    },

    // ---------- Sessions ----------
    addSession: ({ hash, adminId, hours = 12 }) =>
      db.prepare('INSERT INTO sessions (id_hash, admin_id, expires_at) VALUES (?, ?, ?)').bind(hash, adminId, later(hours * 60)).run(),
    sessionAdmin: (hash) =>
      db
        .prepare('SELECT a.id, a.name, a.handle, s.expires_at FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.id_hash = ? AND s.expires_at > ?')
        .bind(hash, now())
        .first(),
    endSession: (hash) => db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(hash).run(),
    /** Clears out what has run out (from the scheduled job). */
    purge: () =>
      db.batch([
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now()),
        db.prepare('DELETE FROM invites WHERE expires_at <= ?').bind(later(-7 * 24 * 60)),
      ]),

    // ---------- Clients ----------
    /** A confirmed booking's client: found by phone number, or added. → the client's id. */
    clientFromBooking: async (booking) => {
      const phone = phoneKey(booking.phone);
      if (phone.length < 7) return null;
      const id = await db
        .prepare(`
          INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET email = COALESCE(clients.email, excluded.email), updated_at = datetime('now')
          RETURNING id`)
        .bind(booking.name, phone, booking.email || null)
        .first('id');
      await db.prepare('UPDATE bookings SET client_id = ? WHERE id = ?').bind(id, booking.id).run();
      return id;
    },
    listClients: async (q, today) => {
      const term = String(q ?? '').trim().slice(0, 60);
      const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      const digits = phoneKey(term);
      return (
        await db
          .prepare(`
            SELECT c.id, c.name, c.phone, c.email, c.card_left, c.updated_at,
              (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id AND b.status = 'confirmed' AND b.date < ?1) AS visits,
              (SELECT MAX(b.date) FROM bookings b WHERE b.client_id = c.id AND b.status = 'confirmed' AND b.date < ?1) AS last_visit,
              (SELECT MIN(b.date || ' ' || b.time) FROM bookings b WHERE b.client_id = c.id AND b.status = 'confirmed' AND b.date >= ?1) AS next_visit
            FROM clients c
            WHERE ?2 = '' OR c.name LIKE ?3 ESCAPE '\\' OR c.email LIKE ?3 ESCAPE '\\' OR (?4 != '' AND c.phone LIKE ?5)
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT 300`)
          .bind(today, term, like, digits, `%${digits}%`)
          .all()
      ).results;
    },
    client: (id) => db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first(),
    clientByPhone: (phone) => db.prepare('SELECT id, name, card_left FROM clients WHERE phone = ?').bind(phoneKey(phone)).first(),
    /** Sessions added to (or, negative, taken from) a client's card; never below 0. → what's left. */
    addCardSessions: (id, delta) =>
      db
        .prepare(`UPDATE clients SET card_left = MAX(0, MIN(100, card_left + ?)), updated_at = datetime('now') WHERE id = ? RETURNING card_left`)
        .bind(delta, id)
        .first('card_left'),
    clientBookings: async (id) =>
      (
        await db
          .prepare('SELECT id, ref, service_id, date, time, duration, status, price, notes FROM bookings WHERE client_id = ? ORDER BY date DESC, time DESC LIMIT 200')
          .bind(id)
          .all()
      ).results,
    /** → the new client, or null if someone already has that phone number. */
    addClient: async (c) => {
      try {
        return await db
          .prepare('INSERT INTO clients (name, phone, email, notes, card_left) VALUES (?, ?, ?, ?, ?) RETURNING *')
          .bind(c.name, c.phone, c.email || null, c.notes || null, c.cardLeft ?? 0)
          .first();
      } catch (err) {
        if (/UNIQUE constraint failed: clients\.phone/.test(String(err?.message))) return null;
        throw err;
      }
    },
    /** → the updated client; null if not found; false if another client has that phone number. */
    updateClient: async (id, c) => {
      try {
        return await db
          .prepare(`UPDATE clients SET name = ?, phone = ?, email = ?, notes = ?, card_left = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`)
          .bind(c.name, c.phone, c.email || null, c.notes || null, c.cardLeft, id)
          .first();
      } catch (err) {
        if (/UNIQUE constraint failed: clients\.phone/.test(String(err?.message))) return false;
        throw err;
      }
    },
    /** Forgets a client: removed from the list, and their name and details wiped from past bookings. */
    forgetClient: async (id) => {
      const [, gone] = await db.batch([
        db.prepare("UPDATE bookings SET name = '—', phone = '', email = NULL, notes = NULL, client_id = NULL WHERE client_id = ?").bind(id),
        db.prepare('DELETE FROM clients WHERE id = ?').bind(id),
      ]);
      return changed(gone);
    },
  };
}
