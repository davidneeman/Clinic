// What David can change on the site himself, in the admin panel's "האתר" tab: the texts (the
// quote included), the treatments' names, descriptions and photos, the prices, the opening and
// "about" photos, and the gallery with its descriptions.
//
// His changes are kept as one document ("content") on the server:
//   { texts:    { "about.quote": "…" },                       ← keys of the Hebrew dictionary (i18n.js)
//     services: { "stress": { name, description, photo } },  ← per treatment (config/site.json)
//     photos:   { hero: <photo>, about: <photo> },  aboutAlt: "…",
//     gallery:  [{ photo: <photo>, alt: "…" }, …],
//     prices:   { session: 350, packSessions: 4, pack: 1200 } }
// where a <photo> is { builtin: "david-2" } (a photo that comes with the site, in images/) or
// { upload: "<id>" } (one he uploaded from his phone; served from /media/).
// Anything missing stays as it comes with the site.
//
// Used by the pages, the admin panel and the Worker (worker/content.js), so it imports nothing
// and keeps its names distinctive (the GitHub Pages build puts all the scripts in one).

const SECTION_TITLE = { he: 'כותרת הפרק', en: 'Section title' };

export const CONTENT_SECTIONS = [
  {
    id: 'hero',
    label: { he: 'הפתיחה', en: 'Opening screen' },
    items: [
      { text: 'hero.titleA', label: { he: 'הכותרת – החלק הראשון', en: 'Headline – first part' }, max: 30 },
      { text: 'hero.titleB', label: { he: 'הכותרת – החלק המודגש', en: 'Headline – highlighted part' }, max: 30 },
      { photo: 'hero', label: { he: 'התמונה בחלון הקשת', en: 'The photo in the arch' } },
    ],
  },
  {
    id: 'treatments',
    label: { he: 'טיפולים ומחירים', en: 'Treatments and prices' },
    items: [
      { text: 'treatments.title', also: ['nav.treatments'], label: SECTION_TITLE, max: 40 },
      { text: 'treatments.lead', label: { he: 'פסקת הפתיחה', en: 'Intro paragraph' }, max: 800, multiline: true, optional: true },
      { services: true },
      { prices: true },
    ],
  },
  {
    id: 'gallery',
    label: { he: 'גלריה', en: 'Gallery' },
    items: [
      { text: 'gallery.title', also: ['nav.gallery'], label: SECTION_TITLE, max: 40 },
      { gallery: true },
    ],
  },
  {
    id: 'about',
    label: { he: 'קצת עליי', en: 'About' },
    items: [
      { text: 'about.title', also: ['nav.about'], label: SECTION_TITLE, max: 40 },
      { photo: 'about', label: { he: 'התמונה', en: 'Photo' } },
      { text: 'about.p1', label: { he: 'פסקה ראשונה', en: 'First paragraph' }, max: 1200, multiline: true },
      { text: 'about.p2', label: { he: 'פסקה שנייה', en: 'Second paragraph' }, max: 1200, multiline: true, optional: true },
      { text: 'about.p3', label: { he: 'פסקה שלישית', en: 'Third paragraph' }, max: 1200, multiline: true, optional: true },
      { text: 'about.quote', label: { he: 'הציטוט', en: 'The quote' }, max: 300, multiline: true },
    ],
  },
  {
    id: 'visit',
    label: { he: 'כתובת ושעות', en: 'Address and hours' },
    items: [
      { text: 'visit.title', also: ['nav.visit'], label: SECTION_TITLE, max: 40 },
      { text: 'visit.parking', label: { he: 'חניה', en: 'Parking' }, max: 200 },
      { text: 'visit.booking', also: ['book.lead'], label: { he: 'המשפט מתחת לשעות', en: 'The line under the hours' }, max: 200 },
      { text: 'visit.prep1', label: { he: 'לפני הטיפול – 1', en: 'Before the session – 1' }, max: 300, multiline: true },
      { text: 'visit.prep2', label: { he: 'לפני הטיפול – 2', en: 'Before the session – 2' }, max: 300, multiline: true, optional: true },
      { text: 'visit.prep3', label: { he: 'לפני הטיפול – 3', en: 'Before the session – 3' }, max: 300, multiline: true, optional: true },
    ],
  },
  {
    id: 'contact',
    label: { he: 'יצירת קשר', en: 'Contact' },
    items: [{ text: 'contact.title', label: SECTION_TITLE, max: 60 }],
  },
];

export const TEXT_FIELDS = CONTENT_SECTIONS.flatMap((s) => s.items.filter((i) => i.text));

// The treatments' own fields (per treatment in config/site.json).
export const SERVICE_LIMITS = { name: 40, description: 1200 };
export const GALLERY_LIMITS = { photos: 24, alt: 160 };
export const PRICE_LIMITS = { session: [0, 5000], packSessions: [2, 20], pack: [0, 50000] };

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

// Where a photo goes, its shape (width / height), the widths an upload is saved in, and the
// photos that come with the site that fit there.
export const PHOTO_SLOTS = {
  hero: { ratio: 4 / 5, widths: [640, 1080, 1600], builtins: ['room', 'david-1', 'david-2', 'david-3'] },
  about: { ratio: 4 / 5, widths: [640, 1080, 1600], builtins: ['about'] },
  service: { ratio: 1, widths: [300, 700, 1200], builtins: ['svc-dry', 'svc-cosmetic', 'svc-stress'] },
  gallery: { ratio: 4 / 5, widths: [720, 1080, 1600], builtins: ['gal-1', 'gal-2', 'gal-3', 'gal-4', 'gal-5', 'gal-6', 'gal-7', 'gal-8', 'gal-9'] },
};

// An uploaded photo's id: 16 random letters and digits (base32).
export const UPLOAD_ID_RE = /^[a-z2-7]{16}$/;

const archPhoto = (id, label) => ({
  label,
  w: 960,
  h: 1200,
  set: [[`images/${id}-640.jpg`, 640], [`images/${id}.jpg`, 960], [`images/${id}-1440.jpg`, 1440]],
});
const galleryPhoto = (n) => ({
  w: 720,
  h: 900,
  set: [[`images/gal-${n}.jpg`, 720], [`images/gal-${n}-1080.jpg`, 1080]],
  large: `images/large/gal-${n}.jpg`,
});
const servicePhoto = (id) => ({
  w: 700,
  h: 700,
  set: [[`images/${id}-300.jpg`, 300], [`images/${id}.jpg`, 700], [`images/${id}-1200.jpg`, 1200], [`images/${id}-1600.jpg`, 1600]],
});

export const BUILTIN_PHOTOS = {
  room: archPhoto('room', { he: 'חדר הטיפולים', en: 'The treatment room' }),
  'david-1': archPhoto('david-1', { he: 'דוד – 1', en: 'David – 1' }),
  'david-2': archPhoto('david-2', { he: 'דוד – 2', en: 'David – 2' }),
  'david-3': archPhoto('david-3', { he: 'דוד – 3', en: 'David – 3' }),
  about: { w: 900, h: 1125, set: [['images/about.jpg', 900], ['images/about-1350.jpg', 1350], ['images/about-1800.jpg', 1800]] },
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`gal-${n}`, galleryPhoto(n)])),
  'svc-dry': servicePhoto('svc-dry'),
  'svc-cosmetic': servicePhoto('svc-cosmetic'),
  'svc-stress': servicePhoto('svc-stress'),
};

// The gallery as it comes with the site (the same photos and descriptions as index.html).
export const DEFAULT_GALLERY = [
  'טיפול בכוסות רוח בקליניקה',
  'סימני כוסות רוח ודיקור בגב העליון',
  'דיקור בגב',
  'כוסות רוח לאורך עמוד השדרה',
  'כוסות רוח לאורך הגב',
  'דיקור לאורך הגב',
  'דיקור וסימני כוסות רוח בגב',
  'כוסות רוח בגב התחתון ודיקור לאורך הגב',
  'דיקור לאורך עמוד השדרה',
].map((alt, i) => ({ photo: { builtin: `gal-${i + 1}` }, alt }));
export const DEFAULT_PHOTOS = { hero: { builtin: 'room' }, about: { builtin: 'about' } };
export const DEFAULT_ABOUT_ALT = 'דוד נאמן בקליניקה';

/** The photo that comes with a treatment ("images/svc-dry.jpg" → { builtin: "svc-dry" }). */
export const serviceDefaultPhoto = (service) => {
  const id = /^images\/([\w-]+)\.jpg$/.exec(service?.image || '')?.[1];
  return id && BUILTIN_PHOTOS[id] ? { builtin: id } : null;
};

/** True for a photo that may go in this slot. */
export function isPhotoRef(ref, slot) {
  const spec = PHOTO_SLOTS[slot];
  if (!spec || !ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 1) return false;
  if (typeof ref.builtin === 'string') return spec.builtins.includes(ref.builtin);
  return typeof ref.upload === 'string' && UPLOAD_ID_RE.test(ref.upload);
}

/**
 * Everything an <img> needs for a photo: { src, srcset, width, height, large, byWidth }.
 * `base` comes before an uploaded photo's address: '' on the site itself, the site's full
 * address on the GitHub Pages copy.
 */
export function photoSource(ref, slot, base = '') {
  if (!isPhotoRef(ref, slot)) return null;
  let set;
  let size;
  let large;
  if (ref.builtin) {
    const b = BUILTIN_PHOTOS[ref.builtin];
    set = b.set;
    size = [b.w, b.h];
    large = b.large;
  } else {
    const spec = PHOTO_SLOTS[slot];
    set = spec.widths.map((w) => [`${base}/media/${ref.upload}-${w}.jpg`, w]);
    const w = (set[1] || set[0])[1];
    size = [w, Math.round(w / spec.ratio)];
  }
  const main = set.find(([, w]) => w === size[0]) || set[0];
  return {
    src: main[0],
    srcset: set.map(([u, w]) => `${u} ${w}w`).join(', '),
    width: size[0],
    height: size[1],
    large: large || set.at(-1)[0],
    byWidth: Object.fromEntries(set.map(([u, w]) => [w, u])),
  };
}

/** Upload addresses (for checking that every size of an upload is there). */
export const uploadKeys = (ref, slot) => (ref?.upload ? PHOTO_SLOTS[slot].widths.map((w) => `${ref.upload}-${w}`) : []);

/** Every uploaded photo the content uses, as { id, slot }. */
export function contentUploads(content = {}) {
  const out = [];
  const add = (ref, slot) => ref?.upload && out.push({ id: ref.upload, slot });
  add(content.photos?.hero, 'hero');
  add(content.photos?.about, 'about');
  for (const s of Object.values(content.services || {})) add(s?.photo, 'service');
  for (const g of content.gallery || []) add(g?.photo, 'gallery');
  return out;
}

// ---------------------------------------------------------------------------
// Putting the content on the page
// ---------------------------------------------------------------------------

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

/**
 * Writes his texts into the Hebrew dictionary (`dict`), and the original text from `pristine`
 * wherever he has none (so a text he puts back to the original goes back). A section's title
 * is also its name in the menu, and the headline's two parts make its full text.
 */
export function applyContentTexts(dict, pristine, texts = {}) {
  const own = (key) => typeof texts?.[key] === 'string';
  for (const f of TEXT_FIELDS) {
    for (const key of [f.text, ...(f.also || [])]) setPath(dict, key, own(f.text) ? texts[f.text] : getPath(pristine, key));
  }
  setPath(
    dict,
    'hero.title',
    own('hero.titleA') || own('hero.titleB') ? `${getPath(dict, 'hero.titleA')} ${getPath(dict, 'hero.titleB')}`.trim() : getPath(pristine, 'hero.title'),
  );
}

/**
 * The site's settings (config/site.json, as /api/config gives them) with his treatments and
 * prices: names, descriptions and photos (`image`, and `imageSet` by width), and the prices.
 */
export function mergeSiteConfig(config, content = {}, base = '') {
  const prices = content?.prices;
  const services = (config.services || []).map((s) => {
    const mine = content?.services?.[s.id] || {};
    const photo = photoSource(isPhotoRef(mine.photo, 'service') ? mine.photo : serviceDefaultPhoto(s), 'service', base);
    return {
      ...s,
      name: typeof mine.name === 'string' ? { ...s.name, he: mine.name } : s.name,
      description: typeof mine.description === 'string' ? { ...s.description, he: mine.description } : s.description,
      image: photo ? photo.byWidth[700] || photo.src : s.image,
      imageSet: photo ? photo.byWidth : undefined,
      price: prices ? prices.session : s.price,
    };
  });
  return {
    ...config,
    services,
    prices: prices
      ? { ...config.prices, session: { ...config.prices?.session, price: prices.session }, pack: { sessions: prices.packSessions, price: prices.pack } }
      : config.prices,
  };
}

/** The gallery to show: his, or the one that comes with the site. Each: { …photoSource, alt }. */
export function galleryPhotos(content = {}, base = '') {
  const list = Array.isArray(content?.gallery) ? content.gallery : DEFAULT_GALLERY;
  return list
    .map((g) => {
      const p = photoSource(g?.photo, 'gallery', base);
      return p && { ...p, alt: typeof g.alt === 'string' ? g.alt : '' };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Checking what the admin panel sends (the Worker uses these)
// ---------------------------------------------------------------------------

/**
 * A text as it will be kept: Unicode-normalized, without control characters or the bidi
 * overrides that could flip it on screen, single spaces, at most two line breaks in a row
 * (none for a one-line field). null when it isn't a string.
 */
export function cleanContentText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return null;
  let s = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e]/g, '');
  if (!multiline) s = s.replace(/\n+/g, ' ');
  s = s
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** A text's length in characters (code points), the way the limits are counted. */
export const textLength = (s) => [...String(s)].length;
