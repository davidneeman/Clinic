// Signing in with Google (OpenID Connect), for clients on the booking page and for managers in
// the admin panel.
//
// The browser goes to Google's own page, where the person picks their Google account; Google
// sends them back to /api/auth/google/callback with a one-time code. The Worker trades the
// code for Google's signed statement of who they are (an ID token), straight with Google and
// with the site's secret, and checks it: Google's signature, that it was made for this site,
// that it's fresh, that it answers this very sign-in (nonce), and that Google checked the email
// address. The code only works together with a secret kept for that one sign-in (PKCE), so a
// code caught on the way is useless. No password is ever seen or kept here.
//
// Turned on by two Worker secrets, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (worker/README.md).

import { b64url, sha256 } from './passkeys.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const KEYS_MS = 60 * 60 * 1000; // Google changes its signing keys every few days
const LEEWAY_S = 60; // clock differences
const TIMEOUT_MS = 10_000;
const utf8 = new TextEncoder();

export class GoogleError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

/** The address of the sign-in's way back, which must be listed in Google Cloud for this site. */
export const callbackUrl = (origin) => `${origin}/api/auth/google/callback`;

/**
 * Google's settings from the Worker's secrets, or null while they aren't set. On this computer
 * (wrangler dev, `local`), stand-ins for Google's addresses may be given, for testing.
 */
export function googleSettings(env, { local = false } = {}) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const standIn = (value, real) => (local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(value || '')) ? String(value) : real);
  return {
    clientId,
    clientSecret,
    authUrl: standIn(env.GOOGLE_AUTH_URL, AUTH_URL),
    tokenUrl: standIn(env.GOOGLE_TOKEN_URL, TOKEN_URL),
    certsUrl: standIn(env.GOOGLE_CERTS_URL, CERTS_URL),
  };
}

const digest = async (text) => b64url.encode(await sha256(text));
/** PKCE: Google gets only this hash of the sign-in's secret; the secret itself comes with the code. */
export const pkceChallenge = (verifier) => digest(verifier);
/** The value Google puts back into its statement, to tie it to this one sign-in. */
export const nonceFor = (verifier) => digest(`nonce:${verifier}`);

/** Google's sign-in page for this sign-in. */
export async function authUrl(settings, { state, verifier, redirectUri, lang }) {
  const q = new URLSearchParams({
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce: await nonceFor(verifier),
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    hl: lang === 'en' ? 'en' : 'he',
  });
  return `${settings.authUrl}?${q}`;
}

/** Trades the one-time code for Google's statement of who signed in (with the sign-in's secret). */
export async function exchangeCode(settings, { code, verifier, redirectUri }, fetchImpl = fetch) {
  if (typeof code !== 'string' || !code || code.length > 2048) throw new GoogleError('no_code');
  let res;
  try {
    res = await fetchImpl(settings.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GoogleError('unreachable', `Google token: ${err?.message || err}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError('token', `Google token: HTTP ${res.status} ${String(data?.error || '').slice(0, 60)}`);
  if (typeof data.id_token !== 'string') throw new GoogleError('token', 'Google token: no id_token');
  return data.id_token;
}

function part(text) {
  try {
    return JSON.parse(new TextDecoder().decode(b64url.decode(text)));
  } catch {
    return null;
  }
}

let keyCache = { url: '', at: 0, keys: [] };

async function signingKeys(url, fetchImpl, fresh) {
  if (!fresh && keyCache.url === url && Date.now() - keyCache.at < KEYS_MS) return keyCache.keys;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new GoogleError('keys', `Google keys: HTTP ${res.status}`);
  const { keys } = await res.json();
  keyCache = { url, at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return keyCache.keys;
}

/**
 * Checks Google's statement (an ID token) and returns who it's about: { sub, email, name }.
 * Throws GoogleError when anything about it is off.
 */
export async function verifyIdToken(settings, token, { nonce, now = Date.now() }, fetchImpl = fetch) {
  const pieces = String(token).split('.');
  if (pieces.length !== 3) throw new GoogleError('token', 'not a JWT');
  const header = part(pieces[0]);
  const claims = part(pieces[1]);
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw new GoogleError('token', 'unexpected token');

  let jwk = (await signingKeys(settings.certsUrl, fetchImpl, false)).find((k) => k.kid === header.kid);
  // A key not seen yet: Google may have just added it.
  jwk ??= (await signingKeys(settings.certsUrl, fetchImpl, true)).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA') throw new GoogleError('token', 'unknown signing key');
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url.decode(pieces[2]), utf8.encode(`${pieces[0]}.${pieces[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) throw new GoogleError('token', 'bad signature');

  const t = Math.floor(now / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.has(claims.iss)) throw new GoogleError('token', 'wrong issuer');
  if (!audiences.includes(settings.clientId)) throw new GoogleError('token', 'made for another site');
  if (claims.azp !== undefined && claims.azp !== settings.clientId) throw new GoogleError('token', 'made for another site');
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < t) throw new GoogleError('token', 'expired');
  if (typeof claims.iat !== 'number' || claims.iat - LEEWAY_S > t) throw new GoogleError('token', 'from the future');
  if (!nonce || claims.nonce !== nonce) throw new GoogleError('token', 'answers another sign-in');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new GoogleError('token', 'no subject');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || email.length > 200 || !(claims.email_verified === true || claims.email_verified === 'true')) throw new GoogleError('unverified', 'email not verified');
  const name = typeof claims.name === 'string' ? claims.name : '';
  return { sub: claims.sub, email, name };
}

/**
 * An email address written one way, to tell whether two are the same account: lower case, and
 * for Gmail without the dots and "+…" that Gmail ignores (john.doe+x@gmail.com is johndoe@gmail.com).
 */
export function emailKey(email) {
  const at = String(email ?? '').trim().toLowerCase();
  const i = at.lastIndexOf('@');
  if (i < 1) return at;
  let [user, domain] = [at.slice(0, i), at.slice(i + 1)];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    user = user.split('+')[0].replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${user}@${domain}`;
}
