// Signing in with a phone number: a code sent to it by SMS, through Twilio Verify.
//
// Twilio makes the code, sends it, and checks it: it's good for 10 minutes and for 5 tries, and
// Twilio limits how many codes one number gets. The code never passes through here when it's
// sent, and isn't kept anywhere on the site. Only Israeli mobile numbers (05…) can ask for one.
//
// Turned on by three Worker secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_VERIFY_SERVICE (worker/README.md).

const API = 'https://verify.twilio.com';
const TIMEOUT_MS = 10_000;

export class SmsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code; // 'phone' | 'too_many' | 'expired' | 'failed'
  }
}

/**
 * Twilio's settings from the Worker's secrets, or null while they aren't all set. On this
 * computer (wrangler dev, `local`), a stand-in for Twilio may be given, for testing.
 */
export function smsSettings(env, { local = false } = {}) {
  const account = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const service = String(env.TWILIO_VERIFY_SERVICE || '').trim();
  if (!/^AC\w{32}$/.test(account) || !token || !/^VA\w{32}$/.test(service)) return null;
  const standIn = String(env.TWILIO_API_URL || '');
  const base = local && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(standIn) ? standIn : API;
  return { account, token, service, base };
}

/** An Israeli mobile number (as the client list keeps it: 0501234567) → +972501234567. */
export const toE164 = (digits) => `+972${String(digits).slice(1)}`;
export const isIsraeliMobile = (digits) => /^05\d{8}$/.test(String(digits));

async function call(settings, path, fields, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${settings.base}/v2/Services/${settings.service}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${settings.account}:${settings.token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SmsError('failed', `Twilio: ${err?.message || err}`);
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Sends a sign-in code to the number (digits, 05…). */
export async function sendCode(settings, { phone, lang }, fetchImpl = fetch) {
  const fields = { To: toE164(phone), Channel: 'sms', Locale: lang === 'en' ? 'en' : 'he' };
  let { status, data } = await call(settings, 'Verifications', fields, fetchImpl);
  // A language Twilio doesn't take: the message goes out in its own choice of language.
  if (status === 400 && data?.code !== 60200) ({ status, data } = await call(settings, 'Verifications', { To: fields.To, Channel: 'sms' }, fetchImpl));
  if (status === 201 || status === 200) return true;
  if (data?.code === 60200 || data?.code === 60205 || data?.code === 21614) throw new SmsError('phone', `Twilio: ${data.code}`);
  if (status === 429 || data?.code === 60203) throw new SmsError('too_many', `Twilio: ${data?.code}`);
  throw new SmsError('failed', `Twilio: HTTP ${status} ${data?.code ?? ''}`);
}

/** True when the code is the one sent to the number; false when it isn't. */
export async function checkCode(settings, { phone, code }, fetchImpl = fetch) {
  const { status, data } = await call(settings, 'VerificationCheck', { To: toE164(phone), Code: code }, fetchImpl);
  if (status === 200) return data?.status === 'approved' && data?.valid !== false;
  // No code waiting for this number: it ran out (10 minutes), was used, or had too many tries.
  if (status === 404 || data?.code === 20404) throw new SmsError('expired', 'Twilio: no pending code');
  if (status === 429 || data?.code === 60202) throw new SmsError('too_many', `Twilio: ${data?.code}`);
  throw new SmsError('failed', `Twilio: HTTP ${status} ${data?.code ?? ''}`);
}
