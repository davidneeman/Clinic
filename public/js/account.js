// Signing in on the booking page, once it's set up on the server (worker/README.md): with Google,
// or with a code sent to the phone by SMS. A client who signs in sees how many sessions are left
// on their card and their bookings, and a session from the card is booked at once (book.js).

import { api, clearFieldErrors, el, getLang, locale, onLangChange, pick, showFieldErrors, t, toast } from './site.js';

const $ = (id) => document.getElementById(id);

// Google's own "G", as on its sign-in buttons (constant markup).
const GOOGLE_G =
  '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

const state = {
  config: null,
  me: null, // what /api/account says
  phone: null, // signing in with the phone: { step: 'number' | 'code', number }
  open: false, // the list of bookings is open
};
const listeners = new Set();
const leaving = new Set();

/** The signed-in client (what /api/account says), or null. */
export const signedIn = () => (state.me?.signedIn ? state.me : null);
/** Called whenever the sign-in changes (and once it's known). */
export const onAccount = (fn) => listeners.add(fn);
/** Called just before the page leaves for Google's (to keep what was chosen). */
export const beforeGoogle = (fn) => leaving.add(fn);
/** How the last trip to Google's page ended ('ok', 'cancelled', …), or ''. */
export const googleReturn = () => /^#signin=(\w+)$/.exec(location.hash)?.[1] || '';

export async function initAccount(config) {
  state.config = config;
  await load();
  afterGoogle();
}

export async function reloadAccount() {
  await load();
}

async function load() {
  try {
    state.me = await api('/api/account');
  } catch {
    state.me = null; // the booking page works the same without it
  }
  render();
  for (const fn of listeners) fn(signedIn());
}

/** "0501234567" → "050-123-4567". */
export function fmtPhone(digits) {
  const d = String(digits ?? '');
  return /^05\d{8}$/.test(d) ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

function notice(kind, message) {
  $('account-alert').replaceChildren(message ? el('p', { class: `alert alert-${kind}` }, message) : '');
}

// ---------------------------------------------------------------------------
// Back from Google's page (#signin=…)
// ---------------------------------------------------------------------------

const BACK = { cancelled: 'account.backCancelled', failed: 'account.backFailed', expired: 'account.backExpired', unverified: 'account.backUnverified' };

function afterGoogle() {
  const status = googleReturn();
  if (!status) return;
  history.replaceState(history.state, '', location.pathname + location.search);
  if (status === 'ok' && signedIn()) {
    $('account').scrollIntoView({ block: 'start' });
    $('account-title').focus({ preventScroll: true });
  } else {
    // (also when Google said yes but no sign-in came of it: cookies turned off, for one)
    notice('error', t(BACK[status] || 'account.backFailed'));
  }
}

async function toGoogle(button) {
  notice();
  button.disabled = true;
  try {
    const { url } = await api('/api/auth/google/start', { method: 'POST', body: { for: 'client', lang: getLang() } });
    for (const fn of leaving) fn();
    location.assign(url);
  } catch (err) {
    button.disabled = false;
    notice('error', t(err.status === 429 ? 'errors.rate' : 'account.backFailed'));
  }
}

// ---------------------------------------------------------------------------
// A code by SMS
// ---------------------------------------------------------------------------

function phoneForm() {
  const step = state.phone.step;
  const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, t(step === 'number' ? 'account.sendCode' : 'account.signIn'));
  const field = (id, name, label, attrs) =>
    el('div', { class: 'field' }, el('label', { for: id }, label), el('input', { id, name, required: true, ...attrs }));
  const form = el(
    'form',
    { class: 'form account-phone', novalidate: true },
    step === 'number'
      ? field('signin-phone', 'phone', t('account.phoneLabel'), { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 20, value: state.phone.number || '' })
      : [
          el('p', { class: 'account-note' }, t('account.codeSent', { phone: fmtPhone(state.phone.number) })),
          field('signin-code', 'code', t('account.codeLabel'), { autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 10 }),
        ],
    el(
      'div',
      { class: 'account-form-actions' },
      submit,
      step === 'code' ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => sendCode(form, submit, true) }, t('account.resend')) : '',
      step === 'code'
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-sm',
              onclick: () => {
                state.phone = { step: 'number', number: state.phone.number };
                render();
                focusField('signin-phone');
              },
            },
            t('account.otherNumber'),
          )
        : '',
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm',
          onclick: () => {
            state.phone = null;
            render();
            $('account-title').focus();
          },
        },
        t('account.cancel'),
      ),
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.phone.step === 'number') sendCode(form, submit);
    else checkCode(form, submit);
  });
  return form;
}

const focusField = (id) => setTimeout(() => $(id)?.focus());
const isMobile = (digits) => /^05\d{8}$/.test(digits);
const digitsOf = (text) => {
  let d = String(text || '').replace(/\D+/g, '');
  if (d.startsWith('972')) d = `0${d.slice(3)}`;
  return d;
};

async function sendCode(form, button, again = false) {
  clearFieldErrors(form);
  notice();
  const number = again ? state.phone.number : digitsOf(form.elements.phone.value);
  if (!isMobile(number)) return showFieldErrors(form, ['phone'], { phone: 'errors.mobile' });
  button.disabled = true;
  const label = button.textContent;
  if (!again) button.textContent = t('account.sending');
  try {
    await api('/api/account/phone/start', { method: 'POST', body: { phone: number, lang: getLang() } });
    if (again) toast(t('account.resent'));
    state.phone = { step: 'code', number };
    render();
    focusField('signin-code');
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    if (err.status === 400 && !again) return showFieldErrors(form, ['phone'], { phone: 'errors.mobile' });
    notice('error', t(err.status === 429 ? 'errors.rate' : 'account.smsFailed'));
  }
}

async function checkCode(form, button) {
  clearFieldErrors(form);
  notice();
  const code = form.elements.code.value.replace(/\D+/g, '');
  if (code.length < 4) return showFieldErrors(form, ['code'], { code: 'account.codeWrong' });
  button.disabled = true;
  button.textContent = t('account.checking');
  try {
    await api('/api/account/phone/check', { method: 'POST', body: { phone: state.phone.number, code } });
    state.phone = null;
    await load();
    $('account-title').focus();
  } catch (err) {
    button.disabled = false;
    button.textContent = t('account.signIn');
    if (err.data?.error === 'code_wrong') return showFieldErrors(form, ['code'], { code: 'account.codeWrong' });
    if (err.data?.error === 'code_expired') return showFieldErrors(form, ['code'], { code: 'account.codeExpired' });
    notice('error', t(err.status === 429 ? 'errors.rate' : 'account.smsFailed'));
  }
}

async function signOut() {
  await api('/api/account/logout', { method: 'POST', body: {} }).catch(() => {});
  state.open = false;
  state.phone = null;
  await load();
  toast(t('account.signedOut'));
  $('account-title').focus();
}

// ---------------------------------------------------------------------------
// What shows
// ---------------------------------------------------------------------------

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

function serviceName(id) {
  const s = state.config?.services.find((x) => x.id === id);
  return s ? pick(s.name) : '';
}

const STATUS = { confirmed: 'account.statusConfirmed', pending: 'account.statusPending', cancelled: 'account.statusCancelled' };

function bookingsList(bookings) {
  const today = state.config?.today || '';
  const row = (b) =>
    el(
      'li',
      { class: 'account-booking' },
      el('span', { class: 'account-when' }, fmtDate(b.date), ' · ', el('bdi', {}, b.time)),
      el('span', { class: 'account-what' }, serviceName(b.serviceId)),
      b.date >= today && STATUS[b.status] ? el('span', { class: `account-status is-${b.status}` }, t(STATUS[b.status])) : '',
    );
  const upcoming = bookings.filter((b) => b.date >= today);
  const past = bookings.filter((b) => b.date < today);
  if (!bookings.length) return [el('p', { class: 'account-note' }, t('account.noBookings'))];
  return [
    upcoming.length ? el('h3', { class: 'account-list-title' }, t('account.upcoming')) : '',
    upcoming.length ? el('ul', { class: 'account-bookings' }, upcoming.map(row)) : '',
    past.length ? el('h3', { class: 'account-list-title' }, t('account.past')) : '',
    past.length ? el('ul', { class: 'account-bookings' }, past.map(row)) : '',
  ];
}

/** The line under the greeting: the sessions left on the card, or why there's no card yet. */
function cardLine(me) {
  if (me.client) {
    const n = me.client.cardLeft;
    return n > 1 ? t('account.cardLeft', { n }) : n === 1 ? t('account.cardLeftOne') : t('account.cardEmpty');
  }
  if (me.phone) return t('account.noCard', { phone: fmtPhone(me.phone) });
  // A Google account without a card yet: its phone number proves which card is theirs.
  return t(me.sms ? 'account.notLinked' : 'account.notLinkedNoSms');
}

const startPhone = () => {
  state.phone = { step: 'number' };
  render();
  focusField('signin-phone');
};

function render() {
  const me = state.me;
  const box = $('account');
  if (!me || (!me.signedIn && !me.google && !me.sms)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const actions = [];
  const body = [];
  if (!me.signedIn) {
    $('account-title').textContent = t('account.title');
    $('account-sub').textContent = t('account.sub');
    if (state.phone) body.push(phoneForm());
    else {
      if (me.google) {
        actions.push(
          el('button', { type: 'button', class: 'btn btn-outline btn-sm btn-google', onclick: (e) => toGoogle(e.currentTarget) }, el('span', { class: 'google-g', html: GOOGLE_G }), t('account.google')),
        );
      }
      if (me.sms) actions.push(el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: startPhone }, t('account.phone')));
    }
  } else {
    const first = String(me.name || '').trim().split(/\s+/)[0];
    $('account-title').textContent = first ? t('account.hello', { name: first }) : t('account.helloNoName');
    $('account-sub').textContent = cardLine(me);
    if (state.phone) body.push(phoneForm());
    else {
      if (!me.client && !me.phone && me.sms) actions.push(el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: startPhone }, t('account.prove')));
      if (me.bookings?.length) {
        actions.push(
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline btn-sm',
              'aria-expanded': String(state.open),
              'aria-controls': 'account-body',
              onclick: () => {
                state.open = !state.open;
                render();
              },
            },
            t(state.open ? 'account.hideBookings' : 'account.myBookings'),
          ),
        );
      }
      actions.push(el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: signOut }, t('account.signOut')));
      if (state.open) body.push(...bookingsList(me.bookings || []));
    }
  }
  $('account-actions').replaceChildren(...actions);
  $('account-body').replaceChildren(...body);
  $('account-body').hidden = !body.length;
}

onLangChange(render);
