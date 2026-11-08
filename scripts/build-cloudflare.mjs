// Builds the site for Cloudflare into dist/: the pages and files from public/, which
// Cloudflare serves as they are, next to the Worker in worker/ that answers /api/*.
//
// On the way it:
//   - keeps the public pages in Hebrew only, as on the GitHub Pages version
//   - writes each page's title, description and link-preview tags (WhatsApp, Facebook…)
//     into the HTML, since link previews don't run JavaScript
//   - adds security headers to every page and file (dist/_headers, from worker/page-headers.js)
//
// wrangler runs it before `wrangler dev` and `wrangler deploy` (wrangler.jsonc → build).
// Usage: node scripts/build-cloudflare.mjs [out-dir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_HEADERS } from '../worker/page-headers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function replaceOnce(src, from, to, file) {
  if (!src.includes(from)) throw new Error(`build-cloudflare: expected to find ${JSON.stringify(from.slice(0, 80))} in ${file}`);
  return src.replace(from, () => to);
}

function edit(file, ...pairs) {
  const p = path.join(outDir, file);
  let src = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) src = replaceOnce(src, from, to, file);
  fs.writeFileSync(p, src);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), outDir, { recursive: true });

// ---------- Hebrew only on the public pages (the admin panel keeps its language button) ----------

edit('js/theme-init.js', [
  "    lang = new URLSearchParams(location.search).get('lang') || localStorage.getItem('lang') || 'he';\n",
  "    if (/^\\/admin/.test(location.pathname)) lang = localStorage.getItem('lang') || 'he';\n",
]);

// ---------- Title, description and link previews ----------

const config = JSON.parse(read('config/site.json'));
const he = (await import('../public/js/i18n.js')).dictionaries.he;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const name = config.business.name.he;
// The site's main address. Until the clinic's own domain is set in config/site.json, this is
// the GitHub Pages address, so search engines keep treating that one as the original.
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

function headTags({ title, page }) {
  const url = siteUrl && `${siteUrl}${page}`;
  return `<title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(he.meta.description)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="he_IL">
  <meta property="og:site_name" content="${escapeHtml(name)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(he.meta.description)}">${url ? `
  <link rel="canonical" href="${url}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${siteUrl}images/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">` : ''}
  <meta name="twitter:card" content="summary_large_image">`;
}

edit(
  'index.html',
  [
    '<title>דוד נאמן</title>\n  <meta name="description" content="">',
    headTags({ title: `${he.meta.homeTitle} | ${name}`, page: '' }),
  ],
  // Business details for search engines. A data block: it never runs, so the strict
  // script policy below doesn't apply to it.
  ['</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>\n</head>`],
);
edit('book.html', [
  '<title>קביעת טיפול</title>\n  <meta name="description" content="">',
  headTags({ title: `${he.meta.bookTitle} | ${name}`, page: 'book' }),
]);

// ---------- Security headers for every page and file ----------
// (worker/page-headers.js: the Worker puts the same ones on the pages it serves itself)

const headerLines = Object.entries(PAGE_HEADERS)
  .map(([name, value]) => `  ${name}: ${value}`)
  .join('\n');
fs.writeFileSync(
  path.join(outDir, '_headers'),
  `/*
${headerLines}

/admin
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store

/admin.html
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store

/images/*
  Cache-Control: public, max-age=86400
`,
);

console.log(`Built ${path.relative(root, outDir) || '.'}/ for Cloudflare`);
