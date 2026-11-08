// Small helpers for the Worker's API answers.

// Every API answer: JSON that browsers never cache (it can hold personal details) and never
// treat as a page.
const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...headers } });
}

/** An answer to send as { error: code, …more } with this HTTP status. */
export class HttpError extends Error {
  constructor(status, code, more = {}, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.more = more;
    this.headers = headers;
  }
}

/** A request's body as bytes, read up to `max` bytes (413 beyond that). */
export async function readBytes(request, max) {
  if (Number(request.headers.get('Content-Length') || 0) > max) throw new HttpError(413, 'too_large');
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, 'too_large');
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

/**
 * The JSON body of a request, read up to `max` bytes. Anything that isn't JSON is refused:
 * a page on another site can't send JSON here without the browser asking first (CORS), which
 * this site never allows.
 */
export async function readJson(request, max = 20_000) {
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'json_required');
  const text = new TextDecoder().decode(await readBytes(request, max)).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/** A cookie's value from the request, or ''. */
export function readCookie(request, name) {
  for (const pair of (request.headers.get('Cookie') || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0 && pair.slice(0, i).trim() === name) return pair.slice(i + 1).trim();
  }
  return '';
}
