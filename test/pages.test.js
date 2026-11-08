import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('GitHub Pages build produces a working single page', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  execFileSync(process.execPath, ['scripts/build-pages.mjs', out]);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');

  assert.ok(fs.existsSync(path.join(out, 'favicon.svg')));
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  assert.ok(!/href="\//.test(html), 'no absolute links (the site lives under /<repo>/)');
  assert.match(html, /handoff: 'whatsapp'/);
  assert.match(html, /<meta property="og:image" content="https:\/\/[^"]+\/images\/og\.jpg">/);
  assert.match(html, /<script type="application\/ld\+json">\{"@context"/);
  for (const img of html.matchAll(/src="(images\/[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(out, img[1])), `missing ${img[1]}`);
  }
  for (const set of html.matchAll(/srcset="([^"]+)"/g)) {
    for (const candidate of set[1].split(',')) {
      const file = candidate.trim().split(/\s+/)[0];
      assert.ok(fs.existsSync(path.join(out, file)), `missing ${file}`);
    }
  }

  // David's changes in the admin panel come from the site on Cloudflare (its /api/site).
  assert.match(html, /const REMOTE_ORIGIN = "https:\/\/clinic\.davidneeman\.workers\.dev";/);
  assert.match(html, /refreshSiteData\(\);\n {2}<\/script>/);
  assert.ok(html.indexOf('const CONTENT_SECTIONS') < html.indexOf('const pristineHebrew'), 'the content model comes before the page script');
  assert.match(html, /const mediaBase = \(\) => REMOTE_ORIGIN;/);
  assert.match(html, /localStorage\.getItem\('site-data'\)/);

  // The inline module must parse.
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const file = path.join(out, 'check.mjs');
  fs.writeFileSync(file, script);
  execFileSync(process.execPath, ['--check', file]);
});
