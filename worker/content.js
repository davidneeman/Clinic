// The site editor on Cloudflare (the admin panel's "האתר" tab):
//   - David's texts, treatments, prices and photos: one JSON document in D1 (settings →
//     'content'), checked here before it's kept (public/js/site-content.js says what it holds)
//   - the notices at the top of the site, in D1 (notices); one can also close the booking
//     calendar on chosen days, as closed days (blocked_dates) that go when it goes
//   - the photos he uploads: in Workers KV (the MEDIA binding), as JPEGs without the phone's
//     metadata (no location, no camera details), in the sizes the site uses
// and what puts them on the pages (injectSiteData).

import { dayIndex, isValidDate, isValidTime } from '../server/time.js';
import {
  GALLERY_LIMITS,
  PHOTO_SLOTS,
  PRICE_LIMITS,
  SERVICE_LIMITS,
  TEXT_FIELDS,
  cleanContentText,
  contentUploads,
  isPhotoRef,
  photoSource,
  textLength,
  uploadKeys,
} from '../public/js/site-content.js';
import { zonedToUtc } from './calendar.js';

export const NOTICE_KINDS = ['info', 'news', 'alert'];
export const NOTICE_MAX = 280;
// A closed stretch can be up to a year; a notice can be shown up to two years ahead.
const CLOSE_MAX_DAYS = 366;
const AHEAD_MAX_DAYS = 731;
// One size of one photo (D1 and KV both take more; a phone photo saved at these sizes is
// usually 100–600 KB).
export const MEDIA_MAX_BYTES = 1_900_000;
// Uploads that nothing on the site uses (a photo replaced, or picked and not saved yet) are
// deleted after this long – long enough for a draft kept in the admin panel to be saved.
const UNUSED_UPLOAD_DAYS = 14;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const copyRef = (ref) => (ref.builtin ? { builtin: ref.builtin } : { upload: ref.upload });

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const NOTICE_ORDER = "CASE kind WHEN 'alert' THEN 0 WHEN 'news' THEN 1 ELSE 2 END";

export function openContentStore(db, clock = () => new Date()) {
  const nowIso = () => clock().toISOString();
  const contentQuery = () => db.prepare("SELECT value FROM settings WHERE key = 'content'");
  const noticesQuery = () =>
    db
      .prepare(
        `SELECT id, kind, text, updated_at FROM notices
         WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?1) AND (ends_at IS NULL OR ends_at > ?1)
         ORDER BY ${NOTICE_ORDER}, id DESC LIMIT 3`,
      )
      .bind(nowIso());
  const parse = (value) => {
    try {
      const c = value ? JSON.parse(value) : {};
      return isObject(c) ? c : {};
    } catch {
      return {};
    }
  };
  const asPublic = (rows) => rows.map((n) => ({ id: n.id, kind: n.kind, text: n.text, v: n.updated_at }));

  /** Puts back the closed days every active notice asks for (and only those). */
  async function syncClosures() {
    const closing = (
      await db
        .prepare('SELECT id, text, close_from, close_to FROM notices WHERE active = 1 AND close_from IS NOT NULL AND close_to IS NOT NULL ORDER BY id')
        .all()
    ).results;
    await db.batch([
      db.prepare('DELETE FROM blocked_dates WHERE notice_id IS NOT NULL'),
      // A day closed by hand stays his; a day two notices close belongs to the older one.
      ...closing.map((n) =>
        db
          .prepare(
            `WITH RECURSIVE d(day) AS (SELECT ?1 UNION ALL SELECT date(day, '+1 day') FROM d WHERE day < ?2)
             INSERT INTO blocked_dates (date, note, notice_id) SELECT day, ?3, ?4 FROM d WHERE true
             ON CONFLICT(date) DO NOTHING`,
          )
          .bind(n.close_from, n.close_to, [...n.text].slice(0, 120).join(''), n.id),
      ),
    ]);
  }

  const noticeRow = (n) => [n.kind, n.text, n.starts_at, n.ends_at, n.close_from, n.close_to, n.active ? 1 : 0];

  return {
    async content() {
      return parse(await contentQuery().first('value'));
    },
    saveContent: (content) =>
      db
        .prepare("INSERT INTO settings (key, value) VALUES ('content', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(JSON.stringify(content))
        .run(),

    /**
     * What every page needs: his content and the notices showing now (one trip to D1). If the
     * notices can't be read (the database not updated yet: migrations/0005), his content
     * still goes on the pages.
     */
    async publicSite() {
      try {
        const [content, notices] = await db.batch([contentQuery(), noticesQuery()]);
        return { content: parse(content.results[0]?.value), notices: asPublic(notices.results) };
      } catch (err) {
        if (!/no such table: notices/.test(String(err?.message))) throw err;
        return { content: parse(await contentQuery().first('value')), notices: [] };
      }
    },
    publicNotices: async () => asPublic((await noticesQuery().all()).results),

    listNotices: async () => (await db.prepare('SELECT * FROM notices ORDER BY id DESC LIMIT 100').all()).results,
    async addNotice(n) {
      const row = await db
        .prepare('INSERT INTO notices (kind, text, starts_at, ends_at, close_from, close_to, active) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
        .bind(...noticeRow(n))
        .first();
      await syncClosures();
      return row;
    },
    async updateNotice(id, n) {
      const row = await db
        .prepare(
          `UPDATE notices SET kind = ?, text = ?, starts_at = ?, ends_at = ?, close_from = ?, close_to = ?, active = ?,
           updated_at = datetime('now') WHERE id = ? RETURNING *`,
        )
        .bind(...noticeRow(n), id)
        .first();
      if (row) await syncClosures();
      return row;
    },
    async removeNotice(id) {
      const { meta } = await db.prepare('DELETE FROM notices WHERE id = ?').bind(id).run();
      if (!meta?.changes) return false;
      await syncClosures();
      return true;
    },
    /** Days the booking calendar is closed on, from `from` to `to` (for "open now" on the site). */
    closedDays: async (from, to) =>
      (await db.prepare('SELECT date FROM blocked_dates WHERE date BETWEEN ? AND ? ORDER BY date').bind(from, to).all()).results.map((r) => r.date),
  };
}

// ---------------------------------------------------------------------------
// Checking what the admin panel sends
// ---------------------------------------------------------------------------

/**
 * His changes (`patch`) on top of what's kept (`current`). A field set to null goes back to
 * how it comes with the site. Returns { content, bad } – `bad` lists the fields that can't be
 * kept as they are (nothing is kept then).
 */
export function applyContentPatch(current, patch, { services }) {
  const next = structuredClone(isObject(current) ? current : {});
  const bad = [];
  if (!isObject(patch)) return { content: next, bad: ['content'] };

  if ('texts' in patch) {
    if (!isObject(patch.texts)) bad.push('texts');
    else {
      for (const [key, value] of Object.entries(patch.texts)) {
        const field = TEXT_FIELDS.find((f) => f.text === key);
        if (!field) {
          bad.push(`texts.${key}`);
          continue;
        }
        if (value === null) {
          if (next.texts) delete next.texts[key];
          continue;
        }
        const text = cleanContentText(value, field);
        if (text === null || textLength(text) > field.max || (!text && !field.optional)) bad.push(`texts.${key}`);
        else (next.texts ??= {})[key] = text;
      }
      if (next.texts && !Object.keys(next.texts).length) delete next.texts;
    }
  }

  if ('services' in patch) {
    if (!isObject(patch.services)) bad.push('services');
    else {
      for (const [id, change] of Object.entries(patch.services)) {
        if (!services.some((s) => s.id === id) || !isObject(change)) {
          bad.push(`services.${id}`);
          continue;
        }
        const mine = { ...(next.services?.[id] || {}) };
        for (const key of ['name', 'description']) {
          if (!(key in change)) continue;
          if (change[key] === null) {
            delete mine[key];
            continue;
          }
          const text = cleanContentText(change[key], { multiline: key === 'description' });
          if (!text || textLength(text) > SERVICE_LIMITS[key] || (key === 'name' && textLength(text) < 2)) bad.push(`services.${id}.${key}`);
          else mine[key] = text;
        }
        if ('photo' in change) {
          if (change.photo === null) delete mine.photo;
          else if (isPhotoRef(change.photo, 'service')) mine.photo = copyRef(change.photo);
          else bad.push(`services.${id}.photo`);
        }
        if (Object.keys(mine).length) (next.services ??= {})[id] = mine;
        else if (next.services) delete next.services[id];
      }
      if (next.services && !Object.keys(next.services).length) delete next.services;
    }
  }

  if ('photos' in patch) {
    if (!isObject(patch.photos)) bad.push('photos');
    else {
      for (const [slot, ref] of Object.entries(patch.photos)) {
        if (slot !== 'hero' && slot !== 'about') bad.push(`photos.${slot}`);
        else if (ref === null) {
          if (next.photos) delete next.photos[slot];
        } else if (isPhotoRef(ref, slot)) (next.photos ??= {})[slot] = copyRef(ref);
        else bad.push(`photos.${slot}`);
      }
      if (next.photos && !Object.keys(next.photos).length) delete next.photos;
    }
  }

  if ('aboutAlt' in patch) {
    if (patch.aboutAlt === null) delete next.aboutAlt;
    else {
      const alt = cleanContentText(patch.aboutAlt);
      if (alt === null || textLength(alt) > GALLERY_LIMITS.alt) bad.push('aboutAlt');
      else next.aboutAlt = alt;
    }
  }

  if ('gallery' in patch) {
    if (patch.gallery === null) delete next.gallery;
    else if (!Array.isArray(patch.gallery) || !patch.gallery.length || patch.gallery.length > GALLERY_LIMITS.photos) bad.push('gallery');
    else {
      const list = [];
      patch.gallery.forEach((g, i) => {
        const alt = isObject(g) ? cleanContentText(g.alt ?? '') : null;
        if (!isObject(g) || !isPhotoRef(g.photo, 'gallery') || alt === null || textLength(alt) > GALLERY_LIMITS.alt) bad.push(`gallery.${i}`);
        else list.push({ photo: copyRef(g.photo), alt });
      });
      next.gallery = list;
    }
  }

  if ('prices' in patch) {
    if (patch.prices === null) delete next.prices;
    else if (!isObject(patch.prices)) bad.push('prices');
    else {
      const prices = {};
      for (const [key, [min, max]] of Object.entries(PRICE_LIMITS)) {
        const v = patch.prices[key];
        if (!Number.isInteger(v) || v < min || v > max) bad.push(`prices.${key}`);
        else prices[key] = v;
      }
      next.prices = prices;
    }
  }

  return { content: next, bad };
}

/** The uploads `next` uses that `current` didn't: each must be there in every size. */
export function newUploads(current, next) {
  const before = new Set(contentUploads(current).map((u) => u.id));
  return contentUploads(next).filter((u) => !before.has(u.id));
}

/** True when every size of every one of these uploads is in KV. */
export async function uploadsExist(kv, uploads) {
  if (!uploads.length) return true;
  if (!kv) return false;
  for (const u of uploads) {
    const { keys } = await kv.list({ prefix: `${u.id}-` });
    const have = new Set(keys.map((k) => k.name));
    if (!uploadKeys({ upload: u.id }, u.slot).every((k) => have.has(k))) return false;
  }
  return true;
}

/**
 * A notice from the admin panel's form: the times are the clinic's own ("YYYY-MM-DDTHH:MM",
 * or '' for "from now" / "until I turn it off"), the closed days whole days or none.
 * Returns { notice, bad }.
 */
export function noticeFields(b, { tz, now }) {
  const bad = [];
  const kind = NOTICE_KINDS.includes(b?.kind) ? b.kind : null;
  if (!kind) bad.push('kind');
  const text = cleanContentText(b?.text ?? '', { multiline: false });
  if (!text || textLength(text) < 2 || textLength(text) > NOTICE_MAX) bad.push('text');

  const moment = (value, field) => {
    if (value == null || value === '') return null;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(value));
    if (!m || !isValidDate(m[1]) || !isValidTime(m[2])) {
      bad.push(field);
      return null;
    }
    return zonedToUtc(m[1], m[2], tz).toISOString();
  };
  const startsAt = moment(b?.startsAt, 'startsAt');
  const endsAt = moment(b?.endsAt, 'endsAt');
  const latest = new Date(now.getTime() + AHEAD_MAX_DAYS * 86_400_000).toISOString();
  if (startsAt && startsAt > latest) bad.push('startsAt');
  // (an end that has passed is kept: the notice just doesn't show any more)
  if (endsAt && ((startsAt && endsAt <= startsAt) || endsAt > latest)) bad.push('endsAt');

  let closeFrom = null;
  let closeTo = null;
  if (b?.closeFrom || b?.closeTo) {
    closeFrom = b.closeFrom;
    closeTo = b.closeTo;
    if (!isValidDate(closeFrom)) bad.push('closeFrom');
    if (!isValidDate(closeTo)) bad.push('closeTo');
    if (isValidDate(closeFrom) && isValidDate(closeTo)) {
      const span = dayIndex(closeTo) - dayIndex(closeFrom);
      if (span < 0 || span >= CLOSE_MAX_DAYS) bad.push('closeTo');
      if (dayIndex(closeFrom) > dayIndex(now.toISOString().slice(0, 10)) + AHEAD_MAX_DAYS) bad.push('closeFrom');
    }
  }
  return {
    notice: { kind, text, starts_at: startsAt, ends_at: endsAt, close_from: closeFrom, close_to: closeTo, active: b?.active !== false },
    bad,
  };
}

// ---------------------------------------------------------------------------
// Uploaded photos: JPEGs only, without the phone's metadata
// ---------------------------------------------------------------------------

const isIccProfile = (b, at) => String.fromCharCode(...b.subarray(at, at + 12)) === 'ICC_PROFILE\0';

/**
 * Reads a JPEG and returns { bytes, width, height } without what a phone adds to its photos
 * (EXIF: the location, the time, the camera; XMP; IPTC; comments; extra images after its end)
 * – or null when it isn't a whole, ordinary JPEG. The picture itself isn't touched.
 */
export function cleanJpeg(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = b.length;
  if (len < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep = [[0, 2]];
  let i = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  while (i < len) {
    if (b[i] !== 0xff) return null;
    while (i < len && b[i] === 0xff) i++; // fill bytes
    if (i >= len) return null;
    const marker = b[i];
    const start = i - 1;
    i++;
    if (marker === 0xd9) {
      // End of the picture: anything after it (another image, padding) is left out.
      keep.push([start, i]);
      if (!scans || !width || !height) return null;
      const out = new Uint8Array(keep.reduce((n, [s, e]) => n + e - s, 0));
      let at = 0;
      for (const [s, e] of keep) {
        out.set(b.subarray(s, e), at);
        at += e - s;
      }
      return { bytes: out, width, height };
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      keep.push([start, i]);
      continue;
    }
    if (i + 2 > len) return null;
    const segLen = (b[i] << 8) | b[i + 1];
    const end = i + segLen;
    if (segLen < 2 || end > len) return null;
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) {
      if (segLen < 8) return null;
      height = (b[i + 3] << 8) | b[i + 4];
      width = (b[i + 5] << 8) | b[i + 6];
    }
    // Kept: JFIF (APP0), Adobe's color note (APP14) and the color profile (APP2 ICC_PROFILE).
    const app = marker >= 0xe1 && marker <= 0xef && marker !== 0xee && !(marker === 0xe2 && isIccProfile(b, i + 2));
    if (!(app || marker === 0xfe)) keep.push([start, end]);
    i = end;
    if (marker === 0xda) {
      // The picture's data runs to the next marker (FF 00 and the restart markers are part of it).
      scans++;
      const from = i;
      while (i < len) {
        if (b[i] === 0xff && i + 1 < len) {
          const next = b[i + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next !== 0xff) break;
        }
        i++;
      }
      keep.push([from, i]);
    }
  }
  return null; // never reached its end
}

/** The size a photo for this slot must have at this width: [width, height], or null. */
export function uploadSize(slot, width) {
  const spec = PHOTO_SLOTS[slot];
  if (!spec || !spec.widths.includes(width)) return null;
  return [width, Math.round(width / spec.ratio)];
}

/** Deletes uploads that nothing uses any more and that are older than a few days. */
export async function removeUnusedUploads(kv, content, now = new Date()) {
  if (!kv) return 0;
  const used = new Set(contentUploads(content).map((u) => u.id));
  const before = now.getTime() - UNUSED_UPLOAD_DAYS * 86_400_000;
  let removed = 0;
  let cursor;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    for (const key of page.keys) {
      const id = key.name.split('-')[0];
      const created = Date.parse(key.metadata?.created || '');
      if (!used.has(id) && (!created || created < before)) {
        await kv.delete(key.name);
        removed++;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return removed;
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const setAttr = (tag, name, value) => tag.replace(new RegExp(`\\s${name}="[^"]*"`), () => ` ${name}="${escapeAttr(value)}"`);

/**
 * The page with his content in it: the data for the page's scripts (a JSON block they read
 * before they write the texts), and the opening and "about" photos already in their <img>, so
 * the browser fetches the right one first.
 */
export function injectSiteData(html, data) {
  const at = html.indexOf('</head>');
  if (at < 0) return html;
  // A data block never runs; "<" is written as < so the text can't end the block early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  let out = `${html.slice(0, at)}  <script type="application/json" id="site-data">${json}</script>\n${html.slice(at)}`;
  const content = data.content || {};
  out = out.replace(/<img data-photo="(hero|about)"[^>]*>/g, (tag, slot) => {
    const photo = photoSource(content.photos?.[slot], slot);
    let t = tag;
    if (photo) {
      t = setAttr(t, 'src', photo.src);
      t = setAttr(t, 'srcset', photo.srcset);
      t = setAttr(t, 'width', photo.width);
      t = setAttr(t, 'height', photo.height);
    }
    if (slot === 'about' && typeof content.aboutAlt === 'string') t = setAttr(t, 'alt', content.aboutAlt);
    return t;
  });
  return out;
}
