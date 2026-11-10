// The old address on GitHub Pages (davidneeman.github.io/Clinic) sends its visitors to the site
// on Cloudflare (config/site.json → siteUrl), which is the main site: booking with Bit or PayBox,
// the 4-session card, signing in. An old link to the booking page (".../#book" or ".../book")
// opens the booking page there; link previews of an old link show the site on Cloudflare.
//
// Usage: npm run build:pages            (writes docs/)
//        node scripts/build-pages.mjs <out-dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
const he = (await import('../public/js/i18n.js')).dictionaries.he;
const escapeHtml = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const site = config.siteUrl;
if (!/^https:\/\/[^/]+\/$/.test(site || '')) throw new Error('build-pages: config/site.json → siteUrl must be the main site, like https://example.com/');
const name = config.business.name.he;
const title = `${he.meta.homeTitle} | ${name}`;

/** A page that moves the visitor to the same place on the main site, at once. */
const page = ({ notFound = false } = {}) => `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="canonical" href="${site}">
  <meta name="description" content="${escapeHtml(he.meta.description)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="he_IL">
  <meta property="og:site_name" content="${escapeHtml(name)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(he.meta.description)}">
  <meta property="og:url" content="${site}">
  <meta property="og:image" content="${site}images/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">${notFound ? '\n  <meta name="robots" content="noindex">' : ''}
  <script>
    (function () {
      var book = /^#book\\b/.test(location.hash) || /\\/book\\/?$/.test(location.pathname);
      location.replace(${JSON.stringify(site)} + (book ? 'book' : '') + location.search + (book ? '' : location.hash));
    })();
  </script>
  <noscript><meta http-equiv="refresh" content="0; url=${site}"></noscript>
</head>
<body>
  <p><a href="${site}">${escapeHtml(name)}</a></p>
</body>
</html>
`;

fs.mkdirSync(outDir, { recursive: true });
// The old copy's photos and video aren't needed any more (its page is replaced below).
fs.rmSync(path.join(outDir, 'images'), { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, 'index.html'), page());
// GitHub Pages shows 404.html for any other address: it moves on too.
fs.writeFileSync(path.join(outDir, '404.html'), page({ notFound: true }));
for (const file of ['favicon.svg', 'apple-touch-icon.png']) fs.copyFileSync(path.join(root, 'public', file), path.join(outDir, file));
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
console.log(`Built ${path.relative(root, outDir) || '.'}/: the old address sends visitors to ${site}`);
