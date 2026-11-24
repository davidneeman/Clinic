// David's appointment message, sent to the client on WhatsApp by itself the moment a booking is
// confirmed (he approves the payment, or Grow confirms it): through Meta's WhatsApp Cloud API,
// from the business number he connects there.
//
// The words are a message template Meta approved ("appointment_confirmed", in Hebrew and in
// English: worker/README.md). Only the client's first name, the day, the date and the time go from
// here. Turned on by two Worker secrets, WHATSAPP_TOKEN and WHATSAPP_PHONE_ID. Without them nothing
// is sent, and the admin panel offers the message to send by hand, as before.

const API = 'https://graph.facebook.com/v26.0';
export const TEMPLATE = 'appointment_confirmed';
const TIMEOUT_MS = 8000;

const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The settings from the Worker's secrets, or null while they aren't set. */
export function whatsappSettings(env) {
  const token = String(env.WHATSAPP_TOKEN || '').trim();
  const phoneId = String(env.WHATSAPP_PHONE_ID || '').trim();
  if (!token || !/^\d{5,25}$/.test(phoneId)) return null;
  // Tests point this at a stand-in; plain http only for a test server on this machine.
  const base = (String(env.WHATSAPP_API_BASE || '').trim() || API).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(base)) return null;
  return { token, phoneId, base };
}

/** The number as WhatsApp takes it: the country code and the number, digits only (05… → 9725…). */
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D+/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `972${d.slice(1)}`;
  if (d.startsWith('9720')) d = `972${d.slice(4)}`; // (+972 050…)
  return d.length >= 9 && d.length <= 15 ? d : '';
}

/** One line of text (WhatsApp refuses a value with a line break, a tab or a run of spaces). */
const oneLine = (s, max = 60) =>
  String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);

/** The template's four values, in the client's language: first name, day, date, time. */
export function inviteValues(booking) {
  const [y, m, d] = String(booking.date).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const name = oneLine(String(booking.name || '').trim().split(/\s+/)[0]);
  return booking.lang === 'en' ? [name, EN_DAYS[day], `${d} ${EN_MONTHS[m - 1]}`, booking.time] : [name, HE_DAYS[day], `${d}.${m}`, booking.time];
}

/**
 * Sends the appointment message for this booking. → { ok: true, id } or { ok: false, reason, code }
 * (the reason only: never the number, the name or the token).
 */
export async function sendInvite(settings, booking, fetchImpl = fetch) {
  const to = waNumber(booking.phone);
  if (!to) return { ok: false, reason: 'phone' };
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: TEMPLATE,
      language: { code: booking.lang === 'en' ? 'en' : 'he' },
      components: [{ type: 'body', parameters: inviteValues(booking).map((text) => ({ type: 'text', text })) }],
    },
  };
  let res;
  try {
    res = await fetchImpl(`${settings.base}/${settings.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  const id = data?.messages?.[0]?.id;
  if (res.ok && id) return { ok: true, id };
  return { ok: false, reason: 'refused', code: data?.error?.code ?? res.status };
}
