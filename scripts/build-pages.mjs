// Builds a static, single-page version of the site for GitHub Pages into docs/.
//
// There is no server on GitHub Pages, so:
//   - free times are calculated in the browser from the opening hours in config/site.json
//   - booking requests and contact messages are sent to the practitioner on WhatsApp
//   - what David changes in the admin panel (texts, photos, prices, notices, opening hours,
//     closed days) is read from the site on Cloudflare (config/site.json → cloudflareUrl,
//     its /api/site) and kept in the browser, so this copy looks the same
//
// Usage: npm run build:pages            (writes docs/)
//        node scripts/build-pages.mjs <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function replaceOnce(src, from, to) {
  if (!src.includes(from)) throw new Error(`build-pages: expected to find ${JSON.stringify(from.slice(0, 80))}`);
  return src.replace(from, () => to);
}

// Turn an ES module into plain script text: drop imports, keep exported declarations.
function stripModule(js) {
  return js.replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '').replace(/^export /gm, '');
}

function between(html, re, what) {
  const m = html.match(re);
  if (!m) throw new Error(`build-pages: could not find ${what}`);
  return m[1];
}

// ---------- HTML ----------

const index = read('public/index.html');
const book = read('public/book.html');
const mainOf = (html, what) => between(html, /<main id="main">([\s\S]*?)\n  <\/main>/, `<main> in ${what}`);

const header = between(index, /( {2}<header class="site-header"[^>]*>[\s\S]*?<\/header>)/, 'header');
const footer = between(index, /( {2}<footer class="site-footer">[\s\S]*?<\/footer>)/, 'footer');
// Everything after the footer (floating WhatsApp button, mobile action bar).
const tail = between(index, /<\/footer>\n([\s\S]*?)<\/body>/, 'content after the footer').trimEnd();
const fontsHref = between(index, /<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com[^"]+)">/, 'Google Fonts link');
const bookMain = replaceOnce(
  mainOf(book, 'book.html'),
  '<a class="btn btn-outline" href="/book" data-i18n="book.another">',
  '<a class="btn btn-outline" href="#book" id="book-another" data-i18n="book.another">',
);

let body = `  <a class="skip-link" href="#main" data-i18n="a11y.skip"></a>
${header}
  <main id="main">
    <div id="page-home">${mainOf(index, 'index.html')}
    </div>
    <div id="page-book" hidden>${bookMain}
    </div>
  </main>
${footer}
${tail}`;
body = body.replaceAll('href="/book"', 'href="#book"').replaceAll('href="/"', 'href="#top"');
// No admin panel on GitHub Pages (no server), so no link to it.
body = replaceOnce(body, '\n          <a href="/admin" rel="nofollow" data-i18n="footer.admin"></a>', '');
const absolute = body.match(/href="\/[^"]*"/g);
if (absolute) throw new Error(`build-pages: absolute links left: ${absolute.join(', ')}`);

// ---------- JS ----------

const config = JSON.parse(read('config/site.json'));

// Treatment photos also come in smaller and larger sizes (scripts/make-images.py).
for (const s of config.services) {
  for (const width of s.image ? [300, 1200, 1600] : []) {
    const file = path.join(root, 'public', s.image.replace(/\.jpg$/, `-${width}.jpg`));
    if (!fs.existsSync(file)) throw new Error(`build-pages: missing ${path.relative(root, file)} – run scripts/make-images.py`);
  }
}

let site = read('public/js/site.js');
site = replaceOnce(site, 'export function loadConfig()', 'function serverLoadConfig()');
site = replaceOnce(site, 'export async function api(', 'async function serverApi(');
// His content: kept in the browser from the last visit, then fetched fresh (refreshSiteData).
site = replaceOnce(
  site,
  "  const node = document.getElementById('site-data');\n  if (!node) return null;\n  try {\n    return JSON.parse(node.textContent);\n  } catch {\n    return null;\n  }",
  "  try {\n    const kept = JSON.parse(localStorage.getItem('site-data') || 'null');\n    return kept && typeof kept === 'object' ? kept : null;\n  } catch {\n    return null;\n  }",
);
site = replaceOnce(site, "export const mediaBase = () => '';", 'const mediaBase = () => REMOTE_ORIGIN;');

let home = stripModule(read('public/js/home.js'));
home += `
window.__homeRefresh = () => {
  if (config) renderAll();
};
`;
// Booking links point at the #book page; the router reads data-service to preselect a treatment.
home = replaceOnce(home, 'const bookHref = (id) => `/book?service=${encodeURIComponent(id)}`;', "const bookHref = () => '#book';");

let bookJs = stripModule(read('public/js/book.js'));
bookJs = replaceOnce(bookJs, "new URLSearchParams(location.search).get('service')", 'null');
// The request also goes into the practitioner's Google Calendar (when connected), while WhatsApp opens.
bookJs = replaceOnce(
  bookJs,
  "  window.open(href, '_blank', 'noopener');\n",
  "  window.open(href, '_blank', 'noopener');\n  saveToCalendar({ date: state.date, time: state.time, duration: state.service.duration, service: pick(state.service.name), name: data.name.trim(), notes: (data.notes || '').trim() })?.finally(() => cache.clear());\n",
);
bookJs += `
window.__bookRefresh = () => {
  if (state.config) renderAll();
};
window.__bookPreset = (id) => {
  const s = state.config?.services.find((x) => x.id === id);
  if (s) {
    selectService(s);
    goTo(2, { focus: false });
  }
};
window.__bookReset = () => {
  confirmed = null;
  cache.clear();
  state.service = null;
  state.date = null;
  state.time = null;
  $('details-form').reset();
  $('booking-flow').hidden = false;
  document.querySelector('.page-hero').hidden = false;
  $('confirmation').hidden = true;
  renderAll();
  goTo(1, { focus: false });
};
`;

const remoteOrigin = config.cloudflareUrl ? new URL(config.cloudflareUrl).origin : '';
const staticBackend = `
// ---- Static backend: everything runs in the browser ----
const STATIC_CONFIG = ${JSON.stringify(config)};
// The site on Cloudflare: David's content, notices, opening hours and closed days come from it.
const REMOTE_ORIGIN = ${JSON.stringify(remoteOrigin)};

// ---- Google Calendar (when connected): googleCalendarUrl in config/site.json is the
// address of the script in google-calendar/booking-calendar.gs. Times taken in the
// practitioner's calendar don't show, and each request is added to it. Without it, or
// if the calendar doesn't answer, the free times come from the opening hours alone.
const CALENDAR_URL = STATIC_CONFIG.googleCalendarUrl || '';
const busyByMonth = new Map(); // "YYYY-MM" → promise of { "YYYY-MM-DD": [["HH:MM","HH:MM"]] | "all" } or null
function calendarBusy(month) {
  if (!CALENDAR_URL) return Promise.resolve(null);
  if (!busyByMonth.has(month)) {
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 9000);
    const busy = fetch(CALENDAR_URL + '?from=' + month + '-01&to=' + month + '-' + String(last).padStart(2, '0'), { signal: stop.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.ok && j.busy) || null)
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    busyByMonth.set(month, busy);
    busy.then((b) => { if (!b && busyByMonth.get(month) === busy) busyByMonth.delete(month); }); // try again next time
  }
  return busyByMonth.get(month);
}
// Asked as soon as the booking page opens, so the times are ready by the calendar step.
function prefetchCalendar() {
  if (!CALENDAR_URL) return;
  const today = nowInZone(STATIC_CONFIG.timezone).date;
  const last = addDays(today, STATIC_CONFIG.defaultSchedule.maxDaysAhead);
  calendarBusy(today.slice(0, 7));
  if (last.slice(0, 7) !== today.slice(0, 7)) calendarBusy(last.slice(0, 7));
}
// Sent without waiting for an answer, so WhatsApp opens at once; the times are asked again afterwards.
function saveToCalendar(request) {
  if (!CALENDAR_URL) return null;
  busyByMonth.clear();
  return fetch(CALENDAR_URL, { method: 'POST', mode: 'no-cors', keepalive: true, body: JSON.stringify(request) })
    .catch(() => {})
    .finally(() => busyByMonth.clear());
}
let staticConfigPromise = null;
const liveSchedule = () => ({ ...STATIC_CONFIG.defaultSchedule, ...(getSiteData()?.schedule || {}) });
function staticSiteConfig(data) {
  const merged = mergeSiteConfig(STATIC_CONFIG, data?.content, REMOTE_ORIGIN);
  const schedule = liveSchedule();
  return {
    business: STATIC_CONFIG.business,
    services: merged.services,
    prices: merged.prices,
    currency: STATIC_CONFIG.currency,
    timezone: STATIC_CONFIG.timezone,
    today: nowInZone(STATIC_CONFIG.timezone).date,
    maxDaysAhead: schedule.maxDaysAhead,
    hours: schedule.weeklyHours,
    handoff: 'whatsapp',
    closedDays: Array.isArray(data?.closed) ? data.closed : [],
  };
}
function loadConfig() {
  staticConfigPromise ??= Promise.resolve().then(() => {
    siteConfig = staticSiteConfig(getSiteData());
    applyTranslations();
    return siteConfig;
  });
  return staticConfigPromise;
}
// The latest from the site on Cloudflare, kept for the next visit too. Without an answer, the
// page stays as it is (as it was on the last visit, or as it comes).
function refreshSiteData() {
  if (!REMOTE_ORIGIN) return;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 8000);
  fetch(REMOTE_ORIGIN + '/api/site', { signal: stop.signal, credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      try {
        localStorage.setItem('site-data', JSON.stringify(data));
      } catch (e) {}
      if (JSON.stringify(data) === JSON.stringify(getSiteData())) return;
      setSiteData(data);
      if (siteConfig) Object.assign(siteConfig, staticSiteConfig(data));
      applyTranslations();
      window.__homeRefresh?.();
      window.__bookRefresh?.();
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
async function api(url) {
  const u = new URL(url, location.href);
  if (u.pathname.endsWith('/api/availability')) {
    const schedule = liveSchedule();
    const closed = new Set(getSiteData()?.closed || []);
    const service = STATIC_CONFIG.services.find((s) => s.id === u.searchParams.get('service'));
    const now = nowInZone(STATIC_CONFIG.timezone);
    const last = addDays(now.date, schedule.maxDaysAhead);
    let from = u.searchParams.get('from');
    let to = u.searchParams.get('to');
    const busy = await calendarBusy(from.slice(0, 7));
    if (from < now.date) from = now.date;
    if (to > last) to = last;
    const days = {};
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const taken = busy && busy[d];
      days[d] = slotsForDay({
        date: d,
        duration: service.duration,
        schedule,
        now,
        blocked: taken === 'all' || closed.has(d),
        dayBookings: Array.isArray(taken) ? taken.map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) })) : [],
      });
    }
    return { days };
  }
  const err = new Error('not_available_on_static_site');
  err.status = 404;
  err.data = {};
  throw err;
}
`;

const router = `
// ---- Router: #book shows the booking page, anything else the home page ----
{
  const home = document.getElementById('page-home');
  const bookPage = document.getElementById('page-book');
  let pendingService = null;
  // Where the home page was scrolled to when the booking page opened, so the
  // browser's back button returns to the same spot (not to the top).
  let homeY = 0;
  let fromLink = false;
  function route() {
    const h = location.hash.slice(1);
    const isBook = h === 'book';
    const wasBook = document.body.dataset.route === 'book';
    const historyBack = wasBook && !isBook && !fromLink;
    fromLink = false;
    if (isBook && document.body.dataset.route === 'home') homeY = window.scrollY;
    home.hidden = isBook;
    bookPage.hidden = !isBook;
    document.body.dataset.titleKey = isBook ? 'meta.bookTitle' : 'meta.homeTitle';
    document.body.dataset.route = isBook ? 'book' : 'home';
    applyTranslations();
    if (isBook) {
      prefetchCalendar();
      window.scrollTo({ top: 0, behavior: 'instant' });
      if (pendingService) {
        const id = pendingService;
        pendingService = null;
        loadConfig().then(() => window.__bookPreset(id));
      }
    } else if (historyBack) {
      window.scrollTo({ top: homeY, behavior: 'instant' });
    } else if (h && h !== 'top' && h !== 'main') {
      document.getElementById(h)?.scrollIntoView();
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (href === '#main') {
      // The skip link: go to the content of the page that's showing, without leaving it.
      const main = document.getElementById('main');
      main.tabIndex = -1;
      main.focus({ preventScroll: true });
      main.scrollIntoView();
      return;
    }
    if (a.id === 'book-another') window.__bookReset();
    if (a.dataset.service) pendingService = a.dataset.service;
    fromLink = true;
    if (location.hash === href) route();
    else location.hash = href;
  });
  window.addEventListener('hashchange', route);
  route();
}
`;

const script = [
  stripModule(read('public/js/i18n.js')),
  stripModule(read('public/js/icons.js')),
  stripModule(read('public/js/site-content.js')),
  stripModule(read('server/time.js')),
  stripModule(read('server/availability.js')),
  staticBackend,
  stripModule(site),
  `{\n${home}\n}`,
  `{\n${bookJs}\n}`,
  router,
  'refreshSiteData();',
].join('\n');

// Hebrew only; light unless the visitor picked dark with the button.
const themeInit = `(function () {
  var r = document.documentElement, th = null;
  r.classList.add('js');
  try {
    th = localStorage.getItem('theme');
    var a = JSON.parse(localStorage.getItem('a11y') || '{}') || {};
    if (a.text) r.classList.add('a11y-text-' + a.text);
    ['contrast', 'links', 'still', 'font'].forEach(function (k) { if (a[k]) r.classList.add('a11y-' + k); });
  } catch (e) {}
  try {
    if (sessionStorage.getItem('intro')) r.classList.add('no-intro');
    else sessionStorage.setItem('intro', '1');
  } catch (e) {}
  r.setAttribute('data-look', '2ln');
  try {
    var opt = /[?&]options(?:=([a-z]*))?(?:&|$)/.exec(location.search);
    if (opt) {
      r.classList.add('show-palettes');
      var pal = opt[1] || localStorage.getItem('palette') || '';
      if (/^(oat|dune)$/.test(pal)) {
        r.setAttribute('data-palette', pal);
        localStorage.setItem('palette', pal);
      }
    }
  } catch (e) {}
  if (location.hash !== '#book') r.classList.add('bar-wait');
  if (th !== 'dark') th = 'light';
  r.setAttribute('data-theme', th);
  r.lang = 'he';
  r.dir = 'rtl';
})();`;

const he = (await import('../public/js/i18n.js')).dictionaries.he;
const escapeHtml = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const name = config.business.name.he;
const pageTitle = `${he.meta.homeTitle} | ${name}`;
const siteUrl = config.siteUrl || '';
const street = config.business.address.he.replace(/\s*\(.*?\)\s*/g, ' ').trim();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'LocalBusiness',
  name,
  description: he.meta.description,
  url: siteUrl || undefined,
  image: siteUrl ? `${siteUrl}images/og.jpg` : undefined,
  telephone: config.business.phone,
  address: {
    '@type': 'PostalAddress',
    streetAddress: street.split(',')[0].trim(),
    addressLocality: (street.split(',')[1] || '').trim(),
    addressCountry: 'IL',
  },
  openingHoursSpecification: Object.entries(config.defaultSchedule.weeklyHours).flatMap(([day, ranges]) =>
    ranges.map(([opens, closes]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAYS[day], opens, closes })),
  ),
};
const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(he.meta.description)}">
  <meta name="theme-color" content="#ede3ce">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="he_IL">
  <meta property="og:site_name" content="${escapeHtml(name)}">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(he.meta.description)}">${siteUrl ? `
  <link rel="canonical" href="${siteUrl}">
  <meta property="og:url" content="${siteUrl}">
  <meta property="og:image" content="${siteUrl}images/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
  <script>${themeInit}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${fontsHref}">
  <style>
${read('public/css/styles.css')}
  </style>
</head>
<body data-title-key="meta.homeTitle">
${body}
  <script type="module">
${script}
  </script>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
for (const file of ['favicon.svg', 'apple-touch-icon.png']) {
  if (fs.existsSync(path.join(root, 'public', file))) fs.copyFileSync(path.join(root, 'public', file), path.join(outDir, file));
}
fs.rmSync(path.join(outDir, 'images'), { recursive: true, force: true }); // drop photos that are no longer used
fs.cpSync(path.join(root, 'public', 'images'), path.join(outDir, 'images'), { recursive: true });
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');

// GitHub Pages shows 404.html for any address that doesn't exist. Send visitors to the
// site instead (an old ".../book" link opens the booking page).
const base = siteUrl ? new URL(siteUrl).pathname : '/';
fs.writeFileSync(
  path.join(outDir, '404.html'),
  `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(he.notFound.title)} | ${escapeHtml(name)}</title>
  <script>location.replace(${JSON.stringify(base)} + (/\\/book\\/?$/.test(location.pathname) ? '#book' : ''));</script>
  <noscript><meta http-equiv="refresh" content="0; url=${base}"></noscript>
</head>
<body>
  <p><a href="${base}">${escapeHtml(he.notFound.home)}</a></p>
</body>
</html>
`,
);
console.log(`Built ${path.relative(root, outDir) || '.'}/index.html (${Math.round(html.length / 1024)} KB)`);
