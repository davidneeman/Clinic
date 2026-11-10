import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('the old GitHub Pages address sends visitors to the main site, to the same place', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config/site.json', import.meta.url), 'utf8'));
  const site = config.siteUrl;
  assert.equal(site, 'https://clinic.davidneeman.workers.dev/');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  fs.mkdirSync(path.join(out, 'images'));
  fs.writeFileSync(path.join(out, 'images', 'old.jpg'), 'x');
  execFileSync(process.execPath, ['scripts/build-pages.mjs', out]);
  assert.ok(!fs.existsSync(path.join(out, 'images')), 'the old copy’s photos are gone');
  for (const file of ['favicon.svg', 'apple-touch-icon.png', '.nojekyll']) assert.ok(fs.existsSync(path.join(out, file)), file);

  for (const file of ['index.html', '404.html']) {
    const html = fs.readFileSync(path.join(out, file), 'utf8');
    assert.match(html, new RegExp(`<link rel="canonical" href="${site}">`), file);
    assert.match(html, new RegExp(`<meta property="og:url" content="${site}">`), file);
    assert.match(html, new RegExp(`<meta property="og:image" content="${site}images/og\\.jpg">`), file);
    assert.match(html, new RegExp(`<meta http-equiv="refresh" content="0; url=${site}">`), file);
    // Where an old link goes
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const go = (href) => {
      const url = new URL(href);
      let to = null;
      new Function('location', script)({ hash: url.hash, pathname: url.pathname, search: url.search, replace: (u) => (to = u) });
      return to;
    };
    assert.equal(go('https://davidneeman.github.io/Clinic/'), site);
    assert.equal(go('https://davidneeman.github.io/Clinic/#treatments'), `${site}#treatments`);
    assert.equal(go('https://davidneeman.github.io/Clinic/#book'), `${site}book`);
    assert.equal(go('https://davidneeman.github.io/Clinic/book'), `${site}book`);
    assert.equal(go('https://davidneeman.github.io/Clinic/?service=stress#book'), `${site}book?service=stress`);
  }
  assert.match(fs.readFileSync(path.join(out, '404.html'), 'utf8'), /<meta name="robots" content="noindex">/);
});
