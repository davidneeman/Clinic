// The security headers on every page and file of the site on Cloudflare. Cloudflare adds them
// to the files it serves by itself (dist/_headers, written by scripts/build-cloudflare.mjs),
// and the Worker to the pages it serves with David's content in them (worker/index.js).
// The same rules as the Node server (server/security.js), plus HSTS, and blob: photos for the
// admin panel's preview of a photo picked on the phone.

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const PAGE_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
