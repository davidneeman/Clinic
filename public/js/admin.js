import { api, clearFieldErrors, el, loadConfig, locale, onLangChange, pick, showFieldErrors, t, toast } from './site.js';
import { svg } from './icons.js';
import { createSiteTab } from './admin-site.js';
import { choiceSelect, clearDraft, draftNames, draftWhen, formatRange, loadDraft, rangeDates, rangeField, rangeParts, saveDraft, shiftDays, timeSelect, todayIn } from './admin-pickers.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  tab: 'bookings',
  scope: 'upcoming',
  bookings: [],
  schedule: null,
  blocked: [],
  messages: [],
  // On Cloudflare: signing in with a passkey (Face ID, Touch ID or a fingerprint), no password.
  passkeys: false,
  // Or behind Cloudflare Access, which asks for a one-time code sent by email before this
  // page loads: no password form, and logging out ends that session.
  access: false,
  enabled: false,
  clients: [],
  clientQuery: '',
  people: [],
  me: null,
  // The "האתר" tab (on Cloudflare): notices, texts, prices and photos.
  editor: false,
  // Signing in with Google (once it's set up): managers, and clients with the Gmail on their card.
  google: false,
  clientGoogle: false,
};

const siteTab = createSiteTab({
  getConfig: () => state.config,
  onUnauthorized: () => showLogin(),
  // A notice can close the calendar on some days: show them in the schedule tab too.
  onClosedDaysChanged: () => loadSchedule().catch(() => {}),
});

function fmtDate(dateStr, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** SQLite timestamps are UTC ("YYYY-MM-DD HH:MM:SS"); show them in the practice's time zone. */
function fmtStamp(stamp) {
  const at = new Date(`${stamp.replace(' ', 'T')}Z`);
  const timeZone = state.config?.timezone;
  return {
    time: new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at),
    date: new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(at),
  };
}

function dayName(i) {
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + i)));
}

function alertIn(id, kind, message) {
  $(id)?.replaceChildren(message ? el('p', { class: `alert alert-${kind}` }, message) : '');
}

/** A form's save: while it's saving its button is off, so a double tap saves once. */
function onSave(form, save) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.saving) return;
    form.dataset.saving = '1';
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      await save(e);
    } finally {
      delete form.dataset.saving;
      if (button) button.disabled = false;
    }
  });
}

/**
 * Runs a call to the server. If the sign-in has run out, the sign-in screen shows and what was
 * being done stops there: nothing says "done" when it wasn't, and nothing typed is thrown away.
 */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) showLogin();
    else toast(t('common.error'));
    throw err;
  }
}
// (an action stopped that way needs no other message: the sign-in screen says it all)
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function showLogin() {
  $('dashboard').hidden = true;
  $('device-offer').hidden = true;
  $('welcome').hidden = true;
  $('login-view').hidden = false;
  if (state.passkeys) {
    // A one-time link (#invite=…) adds this phone's passkey; otherwise sign in with it.
    const invite = Boolean(inviteCode());
    for (const id of ['login-form', 'admin-disabled', 'access-logout']) $(id).hidden = true;
    $('passkey-login').hidden = invite;
    $('register-form').hidden = !invite;
    $('google-login').hidden = !state.google;
    renderSignIn();
    return;
  }
  if (state.access) {
    // Signed in to Access with an email that isn't allowed in, or the sign-in has expired.
    const notice = $('admin-disabled');
    notice.dataset.i18n = state.enabled ? 'admin.noAccess' : 'admin.accessOff';
    notice.textContent = t(notice.dataset.i18n);
    notice.hidden = false;
    $('login-form').hidden = true;
    $('access-logout').hidden = !state.enabled;
    return;
  }
  $('password').focus();
}

async function showDashboard() {
  $('login-view').hidden = true;
  $('dashboard').hidden = false;
  $('tab-clients').hidden = !state.passkeys;
  $('tab-people').hidden = !state.passkeys;
  $('tab-site').hidden = !state.editor;
  // Back on the tab that was open last time.
  let last = null;
  try {
    last = localStorage.getItem('admin-tab');
  } catch {
    /* private mode */
  }
  if (last && $(`tab-${last}`) && !$(`tab-${last}`).hidden) selectTab(last);
  // Messages from the site go to WhatsApp unless the site takes them itself.
  setText('messages-intro', state.config?.handoff === 'whatsapp' ? 'admin.introMessagesWhatsapp' : 'admin.introMessages');
  await Promise.all([
    loadBookings(),
    loadSchedule(),
    loadMessages(),
    ...(state.passkeys ? [loadClients(), loadPeople()] : []),
    ...(state.editor ? [siteTab.load().catch(() => {})] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Passkeys: Face ID / Touch ID / a fingerprint
// ---------------------------------------------------------------------------

const fromB64 = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const inviteCode = () => /^#invite=([\w-]{20,100})$/.exec(location.hash)?.[1] || '';
// A phone or tablet signs in with its own Face ID; a computer, usually, with the phone.
const onPhone = () => /iPhone|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/** Sets an element's text from a key, so a language switch re-translates it. */
function setText(id, key) {
  $(id).dataset.i18n = key;
  $(id).textContent = t(key);
}

/** The sign-in screens: a few short steps, worded for a phone or for a computer. */
function renderSignIn() {
  if (!state.passkeys) return;
  const phone = onPhone();
  const steps = (id, keys) => $(id).replaceChildren(...keys.map((k) => el('li', {}, t(k))));
  setText('login-title', inviteCode() ? 'admin.joinTitle' : 'admin.signInTitle');
  steps('passkey-steps', phone ? ['admin.phoneStep1', 'admin.phoneStep2'] : ['admin.pcStep1', 'admin.pcStep2', 'admin.pcStep3']);
  setText('passkey-btn', phone ? 'admin.passkeyLogin' : 'admin.pcLogin');
  setText('passkey-note', phone ? 'admin.phoneNote' : 'admin.pcNote');
  steps('register-steps', ['admin.joinStep1', phone ? 'admin.joinStep2' : 'admin.joinStep2pc', 'admin.joinStep3']);
  setText('register-btn', phone ? 'admin.registerBtn' : 'admin.registerBtnPc');
  $('register-computer').hidden = phone;
}
onLangChange(renderSignIn);
const canPasskey = () => typeof window.PublicKeyCredential === 'function' && Boolean(navigator.credentials?.get);

function passkeyMessage(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return 'admin.passkeyCancelled';
  if (err?.status === 403) return 'admin.inviteInvalid';
  if (err?.status === 429) return 'errors.rate';
  return 'admin.passkeyFailed';
}

$('passkey-btn').addEventListener('click', async () => {
  alertIn('passkey-alert');
  if (!canPasskey()) return alertIn('passkey-alert', 'error', t('admin.passkeyUnsupported'));
  const button = $('passkey-btn');
  button.disabled = true;
  try {
    const start = await api('/api/admin/passkey/login/start', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({ publicKey: { ...start.publicKey, challenge: fromB64(start.publicKey.challenge) } });
    const r = cred.response;
    await api('/api/admin/passkey/login/finish', {
      method: 'POST',
      body: {
        id: start.id,
        credential: {
          id: cred.id,
          rawId: toB64(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON),
            authenticatorData: toB64(r.authenticatorData),
            signature: toB64(r.signature),
            userHandle: r.userHandle ? toB64(r.userHandle) : null,
          },
        },
      },
    });
    if (cred.authenticatorAttachment === 'cross-platform') offerThisDevice();
    await showDashboard();
  } catch (err) {
    alertIn('passkey-alert', 'error', t(passkeyMessage(err)));
  } finally {
    button.disabled = false;
  }
});

/** Signed in with the phone on a device that has its own Face ID, Touch ID or Windows Hello. */
async function offerThisDevice() {
  const here = await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false);
  if (here) $('device-offer').hidden = false;
}

/** Saves the sign-in on this device: one more passkey for the person signed in. */
async function addThisDevice() {
  if (!canPasskey()) return toast(t('admin.passkeyUnsupported'));
  try {
    const start = await api('/api/admin/passkey/add/start', { method: 'POST', body: {} });
    const pk = start.publicKey;
    const cred = await navigator.credentials.create({
      publicKey: {
        ...pk,
        challenge: fromB64(pk.challenge),
        user: { ...pk.user, id: fromB64(pk.user.id) },
        excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })),
      },
    });
    const r = cred.response;
    await api('/api/admin/passkey/add/finish', {
      method: 'POST',
      body: {
        id: start.id,
        credential: {
          id: cred.id,
          rawId: toB64(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON),
            authenticatorData: toB64(r.getAuthenticatorData()),
            publicKey: toB64(r.getPublicKey()),
            publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
            transports: r.getTransports?.() || [],
          },
        },
      },
    });
    $('device-offer').hidden = true;
    toast(t('admin.deviceAdded'));
    if (state.passkeys) loadPeople();
  } catch (err) {
    if (err.status === 401) return showLogin();
    // A device that already holds the sign-in says so before Face ID is even asked.
    const key =
      err.name === 'InvalidStateError' || err.status === 409
        ? 'admin.deviceAlready'
        : err.data?.error === 'reauth_required'
          ? 'admin.reauth'
          : passkeyMessage(err);
    toast(t(key));
  }
}

// ---------------------------------------------------------------------------
// Google: signing in with it, and connecting one's own account (in the people tab)
// ---------------------------------------------------------------------------

/** Off to Google's page: to sign in ('admin') or to connect the account ('link'). */
async function toGoogle(purpose, button) {
  if (button) button.disabled = true;
  try {
    const { url } = await api('/api/auth/google/start', { method: 'POST', body: { for: purpose, lang: document.documentElement.lang } });
    location.assign(url);
  } catch (err) {
    if (button) button.disabled = false;
    if (err.status === 401) return showLogin();
    const key = err.data?.error === 'reauth_required' ? 'admin.googleReauth' : err.status === 429 ? 'errors.rate' : 'account.backFailed';
    if (purpose === 'admin') alertIn('passkey-alert', 'error', t(key));
    else toast(t(key));
  }
}
$('google-login-btn').addEventListener('click', (e) => toGoogle('admin', e.currentTarget));

// Back from Google's page (#signin=…): what happened.
const GOOGLE_BACK = {
  unknown: 'admin.googleUnknown',
  linked: 'admin.googleLinked',
  taken: 'admin.googleTaken',
  cancelled: 'account.backCancelled',
  expired: 'account.backExpired',
  unverified: 'account.backUnverified',
};
const googleBack = /^#signin=(\w+)$/.exec(location.hash)?.[1] || '';
if (googleBack) history.replaceState(null, '', location.pathname);
function afterGoogle(loggedIn) {
  if (!googleBack || googleBack === 'ok') return;
  const message = t(GOOGLE_BACK[googleBack] || 'account.backFailed');
  if (!loggedIn) return alertIn('passkey-alert', googleBack === 'linked' ? 'success' : 'error', message);
  toast(message);
  if (googleBack === 'linked' || googleBack === 'taken') selectTab('people');
}

$('device-offer-add').addEventListener('click', addThisDevice);
$('welcome-close').addEventListener('click', () => ($('welcome').hidden = true));
$('device-offer-close').addEventListener('click', () => ($('device-offer').hidden = true));

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  alertIn('passkey-alert');
  if (!canPasskey()) return alertIn('passkey-alert', 'error', t('admin.passkeyUnsupported'));
  const button = $('register-form').querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const start = await api('/api/admin/passkey/register/start', { method: 'POST', body: { invite: inviteCode() } });
    const name = $('reg-name').value.trim() || start.name;
    const pk = start.publicKey;
    const user = { ...pk.user, id: fromB64(pk.user.id), ...(name ? { name, displayName: name } : {}) };
    const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: fromB64(pk.challenge), user } });
    const r = cred.response;
    await api('/api/admin/passkey/register/finish', {
      method: 'POST',
      body: {
        id: start.id,
        name,
        credential: {
          id: cred.id,
          rawId: toB64(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON),
            authenticatorData: toB64(r.getAuthenticatorData()),
            publicKey: toB64(r.getPublicKey()),
            publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
            transports: r.getTransports?.() || [],
          },
        },
      },
    });
    history.replaceState(null, '', location.pathname); // the link is used up
    setText('welcome-text', onPhone() ? 'admin.welcome' : 'admin.welcomePc');
    $('welcome').hidden = false;
    await showDashboard();
  } catch (err) {
    alertIn('passkey-alert', 'error', t(passkeyMessage(err)));
  } finally {
    button.disabled = false;
  }
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  alertIn('login-alert');
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    showDashboard();
  } catch (err) {
    const key = err.status === 401 ? 'admin.wrongPassword' : err.status === 429 ? 'errors.rate' : err.status === 503 ? 'admin.disabled' : 'common.error';
    alertIn('login-alert', 'error', t(key));
  }
});

$('logout').addEventListener('click', async () => {
  // What's typed and not saved is kept on this device; signing out takes it off (after asking).
  if (draftNames().length && !confirm(t('admin.logoutDrafts'))) return;
  for (const name of draftNames()) clearDraft(name);
  const res = await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => ({}));
  if (res.redirect) return location.assign(res.redirect);
  showLogin();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Shows one tab (and remembers it, so the panel opens on it next time). */
function selectTab(name) {
  state.tab = name;
  for (const t2 of document.querySelectorAll('[data-tab]')) {
    const on = t2.dataset.tab === name;
    t2.setAttribute('aria-selected', String(on));
    $(`panel-${t2.dataset.tab}`).hidden = !on;
  }
  try {
    localStorage.setItem('admin-tab', name);
  } catch {
    /* private mode */
  }
}
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

for (const b of document.querySelectorAll('[data-scope]')) {
  b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    for (const o of document.querySelectorAll('[data-scope]')) o.setAttribute('aria-pressed', String(o === b));
    loadBookings();
  });
}

async function loadBookings() {
  const { bookings } = await guarded(() => api(`/api/admin/bookings?scope=${state.scope}`));
  state.bookings = bookings;
  state.bookingsAt = Date.now();
  if (state.scope === 'upcoming') {
    // Bookings waiting for David to see the payment (Bit or PayBox) and approve them.
    const waiting = bookings.filter((b) => b.status === 'pending').length;
    $('waiting-badge').hidden = !waiting;
    $('waiting-badge').textContent = String(waiting);
  }
  renderBookings();
}

// Back to the panel after a while (it was left open on the phone): new bookings, and the ones
// waiting for him to approve, show without reloading the page.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || $('dashboard').hidden || Date.now() - (state.bookingsAt || 0) < 30_000) return;
  loadBookings().catch(() => {});
});

/** What a booking paid by Bit or PayBox is for, and how much: one line for the list. */
function planLine(b) {
  if (!b.plan) return '';
  const pack = state.config?.prices?.pack?.sessions ?? 4;
  if (b.plan === 'card') {
    const left = b.status === 'pending' ? (b.card_left == null ? t('admin.noCardFound') : t('admin.cardLeft', { n: b.card_left })) : '';
    // Confirmed without his approval: the client signed in and booked from their card.
    const onSite = b.status === 'confirmed' && !b.approved_at ? t('admin.fromCardSite') : '';
    return [onSite || t('admin.planCard'), left].filter(Boolean).join(' · ');
  }
  const what = b.plan === 'pack' ? t('admin.planPack', { n: pack }) : t('admin.planSingle');
  return `${what} · ${formatMoney(b.price)}`;
}
const formatMoney = (n) => `${Number(n || 0).toLocaleString('he-IL')} ₪`;

async function approveBooking(b) {
  const ask = b.plan === 'card' ? t('admin.approveCardConfirm', { name: b.name }) : t('admin.approveConfirm', { name: b.name, amount: formatMoney(b.price) });
  if (!confirm(ask)) return;
  try {
    const { cardLeft } = await api(`/api/admin/bookings/${b.id}/approve`, { method: 'POST', body: {} });
    toast(cardLeft == null ? t('admin.approved') : `${t('admin.approved')} · ${t('admin.cardLeft', { n: cardLeft })}`);
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(t(err.data?.error === 'slot_taken' ? 'admin.approveTaken' : 'common.error'));
  }
  loadBookings();
  if (state.passkeys) loadClients();
}

function serviceName(id) {
  const s = state.config?.services.find((x) => x.id === id);
  return s ? pick(s.name) : id;
}

function renderBookings() {
  const list = $('bookings-list');
  if (!state.bookings.length) {
    list.replaceChildren(el('p', { class: 'empty-state' }, t('admin.noBookings')));
    return;
  }
  list.replaceChildren(
    ...state.bookings.map((b) =>
      el(
        'article',
        { class: `item${b.status === 'pending' ? ' is-unread' : ''}` },
        el('div', { class: 'item-when' }, el('strong', {}, b.time), el('small', {}, fmtDate(b.date))),
        el(
          'div',
          { class: 'item-body' },
          el('h3', {}, b.name),
          el('p', {}, `${serviceName(b.service_id)} · ${t('common.minutes', { n: b.duration })} · `, el('span', { class: 'ref' }, b.ref)),
          el(
            'p',
            {},
            el('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, el('bdi', {}, b.phone)),
            b.email ? ' · ' : '',
            b.email ? el('a', { href: `mailto:${b.email}` }, el('bdi', {}, b.email)) : '',
          ),
          b.plan
            ? el(
                'p',
                { class: 'item-plan' },
                b.status === 'pending' ? el('span', { class: 'chip-waiting' }, t('admin.awaitingPayment')) : '',
                b.status === 'pending' ? ' ' : '',
                planLine(b),
              )
            : '',
          b.notes ? el('p', { class: 'item-notes' }, b.notes) : '',
        ),
        el(
          'div',
          { class: 'item-actions' },
          b.status === 'pending' && state.scope === 'upcoming'
            ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => approveBooking(b) }, t(b.plan === 'card' ? 'admin.approveCard' : 'admin.approve'))
            : '',
          ['confirmed', 'pending'].includes(b.status) && state.scope === 'upcoming'
            ? el('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => cancelBooking(b) }, t('admin.cancel'))
            : '',
        ),
      ),
    ),
  );
}

async function cancelBooking(b) {
  if (!confirm(t('admin.cancelConfirm', { name: b.name }))) return;
  const { cardLeft } = await guarded(() => api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: {} }));
  toast(cardLeft == null ? t('admin.cancelledToast') : t('admin.cancelledCard', { n: cardLeft }));
  loadBookings();
  if (cardLeft != null && state.passkeys) loadClients();
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

// The settings as plain choices (the value already set is always kept among them).
const SETTINGS = {
  slotInterval: {
    choices: [10, 15, 20, 30, 45, 60, 90, 120],
    text: (n) => (n === 60 ? t('admin.everyHour') : n === 90 ? t('admin.everyHourHalf') : n === 120 ? t('admin.everyTwoHours') : t('admin.everyN', { n })),
  },
  bufferMinutes: {
    choices: [0, 5, 10, 15, 20, 30, 45, 60],
    text: (n) => (n === 0 ? t('admin.noBreak') : n === 60 ? t('admin.oneHour') : t('admin.minutesN', { n })),
  },
  minNoticeHours: {
    choices: [0, 1, 2, 3, 4, 6, 12, 24, 48, 72],
    text: (n) =>
      n === 0
        ? t('admin.noNotice')
        : n === 1
          ? t('admin.hourBefore')
          : n === 2
            ? t('admin.twoHoursBefore')
            : n === 24
              ? t('admin.dayBefore')
              : n === 48
                ? t('admin.twoDaysBefore')
                : n % 24 === 0
                  ? t('admin.daysBefore', { n: n / 24 })
                  : t('admin.hoursBefore', { n }),
  },
  maxDaysAhead: {
    choices: [7, 14, 21, 30, 45, 60, 90, 120, 180, 365],
    text: (n) =>
      ({ 7: t('admin.aWeek'), 14: t('admin.twoWeeks'), 30: t('admin.aMonth'), 45: t('admin.monthHalf'), 60: t('admin.twoMonths'), 180: t('admin.halfYear'), 365: t('admin.aYear') })[n] ||
      (n % 30 === 0 ? t('admin.monthsN', { n: n / 30 }) : n % 7 === 0 ? t('admin.weeksN', { n: n / 7 }) : t('admin.daysN', { n })),
  },
};

/** The schedule in one shape (all seven days), to tell whether anything changed. */
function scheduleShape(sch) {
  return {
    weeklyHours: Array.from({ length: 7 }, (_, d) => (sch.weeklyHours?.[d] ?? sch.weeklyHours?.[String(d)] ?? []).map((r) => [r[0], r[1]])),
    slotInterval: Number(sch.slotInterval),
    bufferMinutes: Number(sch.bufferMinutes),
    minNoticeHours: Number(sch.minNoticeHours),
    maxDaysAhead: Number(sch.maxDaysAhead),
  };
}

function scheduleBody() {
  const f = $('schedule-form').elements;
  return {
    weeklyHours: state.schedule.weeklyHours,
    slotInterval: Number(f.slotInterval.value),
    bufferMinutes: Number(f.bufferMinutes.value),
    minNoticeHours: Number(f.minNoticeHours.value),
    maxDaysAhead: Number(f.maxDaysAhead.value),
  };
}

/** After any change to the hours or the settings: kept on this device until it's saved. */
function scheduleChanged() {
  if (!state.schedule) return;
  const now = scheduleShape(scheduleBody());
  const unsaved = JSON.stringify(now) !== JSON.stringify(state.savedSchedule);
  if (unsaved) saveDraft('schedule', now);
  else clearDraft('schedule');
  const note = $('schedule-unsaved');
  note.hidden = !unsaved;
  note.textContent = state.scheduleRestoredAt ? t('admin.scheduleRestored', { when: draftWhen(state.scheduleRestoredAt) }) : t('admin.unsavedSchedule');
}

async function loadSchedule() {
  const data = await guarded(() => api('/api/admin/schedule'));
  state.savedSchedule = scheduleShape(data.schedule);
  state.schedule = scheduleShape(data.schedule);
  state.scheduleRestoredAt = null;
  // Changes made here and not saved yet come back.
  const draft = loadDraft('schedule');
  if (draft && JSON.stringify(scheduleShape(draft.data)) !== JSON.stringify(state.savedSchedule)) {
    state.schedule = scheduleShape(draft.data);
    state.scheduleRestoredAt = draft.at;
  } else if (draft) clearDraft('schedule');
  state.blocked = data.blocked;
  renderSettings(state.schedule);
  renderHours();
  renderBlocked();
  scheduleChanged();
}

/** The settings as choices in words (again after a language switch, keeping what's chosen). */
function renderSettings(values) {
  const form = $('schedule-form');
  for (const [name, spec] of Object.entries(SETTINGS)) {
    const fresh = choiceSelect({ name, value: values[name], choices: spec.choices.map((v) => [v, spec.text(v)]), other: spec.text });
    form.elements[name].replaceChildren(...fresh.children);
    form.elements[name].value = String(values[name]);
  }
}

function renderHours() {
  const hours = state.schedule.weeklyHours;
  $('hours').replaceChildren(
    ...Array.from({ length: 7 }, (_, day) => {
      const ranges = (hours[day] ??= []);
      return el(
        'div',
        { class: 'hours-row' },
        el('strong', {}, dayName(day)),
        el(
          'div',
          { class: 'ranges' },
          ranges.length ? '' : el('span', { class: 'closed' }, t('admin.closed')),
          ranges.map((range, i) => {
            const from = timeSelect({ value: range[0], step: 15, label: t('admin.rangeFrom', { day: dayName(day) }) });
            const to = timeSelect({ value: range[1], step: 15, label: t('admin.rangeTo', { day: dayName(day) }) });
            from.addEventListener('change', () => {
              range[0] = from.value;
              scheduleChanged();
            });
            to.addEventListener('change', () => {
              range[1] = to.value;
              scheduleChanged();
            });
            return el(
              'div',
              { class: 'range' },
              from,
              el('span', { 'aria-hidden': 'true' }, '–'),
              to,
              el('button', {
                type: 'button',
                class: 'icon-btn',
                'aria-label': t('admin.removeRange'),
                title: t('admin.removeRange'),
                html: svg('close'),
                onclick: () => {
                  ranges.splice(i, 1);
                  renderHours();
                  scheduleChanged();
                },
              }),
            );
          }),
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-sm',
              html: svg('plus'),
              onclick: () => {
                const last = ranges.at(-1);
                ranges.push(last ? [last[1] < '20:00' ? last[1] : '16:00', '20:00'] : ['09:00', '14:00']);
                renderHours();
                scheduleChanged();
              },
            },
            t('admin.addRange'),
          ),
        ),
      );
    }),
  );
}

$('schedule-form').addEventListener('change', scheduleChanged);

onSave($('schedule-form'), async () => {
  alertIn('schedule-alert');
  // Each range must end after it starts.
  const wrong = state.schedule.weeklyHours.some?.((ranges) => ranges.some(([a, b]) => a >= b));
  if (wrong) return alertIn('schedule-alert', 'error', t('admin.rangeOrder'));
  try {
    const { schedule } = await api('/api/admin/schedule', { method: 'PUT', body: scheduleBody() });
    state.savedSchedule = scheduleShape(schedule);
    state.schedule = scheduleShape(schedule);
    state.scheduleRestoredAt = null;
    clearDraft('schedule');
    renderHours();
    scheduleChanged();
    toast(t('admin.saved'));
  } catch (err) {
    if (err.status === 401) return showLogin();
    alertIn('schedule-alert', 'error', t(err.status === 400 ? 'admin.invalid' : 'common.error'));
  }
});

// ---- Closed days: a run of days chosen in the calendar ----

let blockDays = null;
/** The field for the days to close (made again, keeping its days, after a language switch). */
function blockField(again = false) {
  if (blockDays && !again) return blockDays;
  const today = todayIn(state.config?.timezone || 'Asia/Jerusalem');
  const { from = '', to = '' } = blockDays?.value || {};
  blockDays = rangeField({ id: 'block-days', from, to, placeholder: t('admin.pickDays'), title: t('admin.pickBlockTitle'), min: today, today });
  $('block-days-slot').replaceChildren(blockDays.element);
  return blockDays;
}

/** Days next to each other with the same note (and closed the same way) show as one line. */
function blockedRuns(list) {
  const runs = [];
  for (const b of list) {
    const last = runs.at(-1);
    const notice = b.notice_id ?? null;
    if (last && shiftDays(last.to, 1) === b.date && last.note === (b.note || '') && last.notice === notice) last.to = b.date;
    else runs.push({ from: b.date, to: b.date, note: b.note || '', notice });
  }
  return runs;
}

function renderBlocked() {
  blockField();
  const list = $('blocked-list');
  if (!state.blocked.length) {
    list.replaceChildren(el('p', { class: 'empty-state' }, t('admin.noBlocked')));
    return;
  }
  list.replaceChildren(
    ...blockedRuns(state.blocked).map((run) =>
      el(
        'div',
        { class: 'item' },
        el('div', { class: 'item-when' }, el('strong', {}, rangeDates(run.from, run.to)), el('small', {}, rangeParts(run.from, run.to).count)),
        el('div', { class: 'item-body' }, el('p', {}, run.note), run.notice ? el('p', { class: 'field-hint' }, t('admin.closedByNotice')) : ''),
        el(
          'div',
          { class: 'item-actions' },
          // Days a notice closed open again with the notice (the "האתר" tab), not here.
          run.notice
            ? ''
            : el('button', {
                type: 'button',
                class: 'btn btn-danger btn-sm',
                onclick: async () => {
                  if (run.from !== run.to && !confirm(t('admin.openDaysConfirm', { days: formatRange(run.from, run.to) }))) return;
                  const path = run.from === run.to ? run.from : `${run.from}/${run.to}`;
                  const data = await guarded(() => api(`/api/admin/blocked/${path}`, { method: 'DELETE', body: {} }));
                  state.blocked = data.blocked;
                  renderBlocked();
                },
              }, t('admin.openDays')),
        ),
      ),
    ),
  );
}

onSave($('block-form'), async () => {
  alertIn('block-alert');
  const { from, to } = blockField().value;
  if (!from) {
    alertIn('block-alert', 'error', t('admin.pickDaysFirst'));
    return blockField().element.focus();
  }
  const data = await guarded(() => api('/api/admin/blocked', { method: 'POST', body: { from, to: to || from, note: $('block-note').value } }));
  state.blocked = data.blocked;
  blockField().value = {};
  $('block-note').value = '';
  renderBlocked();
  toast(t('admin.daysClosed'));
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function loadMessages() {
  const { messages } = await guarded(() => api('/api/admin/messages'));
  state.messages = messages;
  renderMessages();
}

function renderMessages() {
  const unread = state.messages.filter((m) => !m.is_read).length;
  $('unread-badge').hidden = !unread;
  $('unread-badge').textContent = String(unread);

  const list = $('messages-list');
  if (!state.messages.length) {
    list.replaceChildren(el('p', { class: 'empty-state' }, t('admin.noMessages')));
    return;
  }
  list.replaceChildren(
    ...state.messages.map((m) => {
      const { date, time } = fmtStamp(m.created_at);
      return el(
        'article',
        { class: `item${m.is_read ? '' : ' is-unread'}` },
        el('div', { class: 'item-when' }, el('strong', {}, time), el('small', {}, date)),
        el(
          'div',
          { class: 'item-body' },
          el('h3', {}, m.name),
          el(
            'p',
            {},
            m.phone ? el('a', { href: `tel:${m.phone.replace(/[^\d+]/g, '')}` }, el('bdi', {}, m.phone)) : '',
            m.phone && m.email ? ' · ' : '',
            m.email ? el('a', { href: `mailto:${m.email}` }, el('bdi', {}, m.email)) : '',
          ),
          el('p', { class: 'item-notes' }, m.message),
        ),
        el(
          'div',
          { class: 'item-actions' },
          m.is_read
            ? ''
            : el('button', {
                type: 'button',
                class: 'btn btn-outline btn-sm',
                onclick: async () => {
                  await guarded(() => api(`/api/admin/messages/${m.id}/read`, { method: 'POST', body: {} }));
                  m.is_read = 1;
                  renderMessages();
                },
              }, t('admin.markRead')),
          el('button', {
            type: 'button',
            class: 'btn btn-danger btn-sm',
            onclick: async () => {
              if (!confirm(t('admin.deleteConfirm'))) return;
              await guarded(() => api(`/api/admin/messages/${m.id}`, { method: 'DELETE', body: {} }));
              state.messages = state.messages.filter((x) => x !== m);
              renderMessages();
            },
          }, t('admin.delete')),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** A phone number as the client list keeps it (digits) → easy to read: 050-123-4567, 03-123-4567. */
function fmtPhone(digits) {
  const d = String(digits ?? '');
  if (/^0[57]\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^0[2-489]\d{7}$/.test(d)) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return d;
}

/** "YYYY-MM-DD HH:MM" or an ISO moment → a short date (and time) in the practice's time zone. */
function fmtMoment(value) {
  const at = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: state.config?.timezone }).format(at);
}

let searchTimer = null;
$('client-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.clientQuery = $('client-search').value;
    loadClients();
  }, 250);
});
$('client-add').addEventListener('click', () => openClient(null));

async function loadClients() {
  const { clients } = await guarded(() => api(`/api/admin/clients?q=${encodeURIComponent(state.clientQuery)}`));
  state.clients = clients;
  renderClients();
}

function renderClients() {
  const list = $('clients-list');
  if (!state.clients.length) {
    list.replaceChildren(el('p', { class: 'empty-state' }, t(state.clientQuery ? 'admin.noClientsFound' : 'admin.noClients')));
    return;
  }
  list.replaceChildren(
    ...state.clients.map((c) =>
      el(
        'article',
        { class: 'item item-plain' },
        el(
          'div',
          { class: 'item-body' },
          el('h3', {}, c.name),
          el(
            'p',
            {},
            el('a', { href: `tel:${c.phone}` }, el('bdi', {}, fmtPhone(c.phone))),
            c.email ? ' · ' : '',
            c.email ? el('a', { href: `mailto:${c.email}` }, el('bdi', {}, c.email)) : '',
          ),
          el(
            'p',
            {},
            [
              t('admin.visits', { n: c.visits }),
              c.last_visit ? t('admin.lastVisit', { date: fmtDate(c.last_visit) }) : '',
              c.next_visit ? t('admin.nextVisit', { date: `${fmtDate(c.next_visit.slice(0, 10))} ${c.next_visit.slice(11)}` }) : '',
              c.card_left ? t('admin.cardLeft', { n: c.card_left }) : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ),
        el('div', { class: 'item-actions' }, el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => openClient(c.id) }, t('admin.openClient'))),
      ),
    ),
  );
}

const STATUS = { cancelled: 'admin.statusCancelled', pending: 'admin.statusUnpaid', expired: 'admin.statusUnpaid' };

/** One client's card: details, private notes, sessions left on the card, and history. */
async function openClient(id) {
  const box = $('client-detail');
  let client = { name: '', phone: '', email: '', notes: '', card_left: 0 };
  let bookings = [];
  if (id) ({ client, bookings } = await guarded(() => api(`/api/admin/clients/${id}`)));
  const input = (name, label, value, attrs = {}) =>
    el('div', { class: 'field' }, el('label', { for: `c-${name}` }, t(label)), el('input', { id: `c-${name}`, name, value: value ?? '', ...attrs }));
  const card = el('input', { id: 'c-card', name: 'cardLeft', type: 'number', min: 0, max: 100, value: String(client.card_left ?? 0) });
  const bump = (n) => (card.value = String(Math.max(0, Math.min(100, (Number(card.value) || 0) + n))));
  const form = el(
    'form',
    { class: 'form panel client-form', novalidate: true },
    el('h2', { class: 'subhead' }, id ? client.name : t('admin.addClient')),
    input('name', 'admin.clientName', client.name, { autocomplete: 'off', maxlength: 80, required: true }),
    el(
      'div',
      { class: 'form-row' },
      input('phone', 'admin.clientPhone', fmtPhone(client.phone), { type: 'tel', maxlength: 30, required: true }),
      input('email', 'admin.clientEmail', client.email, { type: 'email', maxlength: 120 }),
    ),
    // Signing in on the site with Google: only with the address he connects here.
    state.clientGoogle
      ? el(
          'div',
          { class: 'field' },
          el('label', { for: 'c-google' }, t('admin.clientGoogle')),
          el('input', { id: 'c-google', name: 'google', type: 'email', maxlength: 120, autocomplete: 'off', value: client.google ?? '', 'aria-describedby': 'c-google-hint' }),
          el('small', { class: 'field-hint', id: 'c-google-hint' }, t('admin.clientGoogleHint')),
        )
      : '',
    client.lastSignIn ? el('p', { class: 'panel-sub' }, t('admin.lastSignInSite', { date: fmtMoment(client.lastSignIn) })) : '',
    el('div', { class: 'field' }, el('label', { for: 'c-notes' }, t('admin.clientNotes')), el('textarea', { id: 'c-notes', name: 'notes', maxlength: 2000 }, client.notes || '')),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'c-card' }, t('admin.cardSessions')),
      el(
        'div',
        { class: 'toolbar card-row' },
        card,
        el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => bump(4) }, t('admin.newCard')),
        el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => bump(-1) }, t('admin.useSession')),
      ),
    ),
    el('div', { id: 'client-alert', role: 'status' }),
    el(
      'div',
      { class: 'panel-actions' },
      el('button', { type: 'submit', class: 'btn btn-primary' }, t('admin.save')),
      el('button', { type: 'button', class: 'btn btn-ghost', onclick: closeClient }, t('admin.close')),
      id ? el('button', { type: 'button', class: 'btn btn-danger', onclick: () => forgetClient(client) }, t('admin.forget')) : '',
    ),
    id ? el('h3', { class: 'subhead' }, t('admin.history')) : '',
    id
      ? bookings.length
        ? el(
            'ul',
            { class: 'client-history' },
            bookings.map((b) =>
              el('li', {}, `${fmtDate(b.date)} · ${b.time} · ${serviceName(b.service_id)}${STATUS[b.status] ? ` · ${t(STATUS[b.status])}` : ''}`),
            ),
          )
        : el('p', { class: 'empty-state' }, t('admin.noHistory'))
      : '',
  );
  // What's typed and not saved is kept on this device (until it's saved, or he starts over).
  const key = `client:${id || 'new'}`;
  const original = Object.fromEntries(new FormData(form));
  const draft = loadDraft(key);
  const restart = el('button', { type: 'button', class: 'linklike' }, t('admin.startOver'));
  const draftNote = el('p', { class: 'draft-note', hidden: true }, `${t('admin.draftRestored', { when: draft ? draftWhen(draft.at) : '' })} · `, restart);
  form.querySelector('h2').after(draftNote);
  if (draft && JSON.stringify(draft.data) !== JSON.stringify(original)) {
    for (const [name, value] of Object.entries(draft.data)) if (form.elements[name]) form.elements[name].value = value;
    draftNote.hidden = false;
  } else if (draft) clearDraft(key);
  restart.addEventListener('click', () => {
    clearDraft(key);
    for (const [name, value] of Object.entries(original)) if (form.elements[name]) form.elements[name].value = value;
    draftNote.hidden = true;
  });
  const keep = () => {
    const now = Object.fromEntries(new FormData(form));
    if (JSON.stringify(now) === JSON.stringify(original)) clearDraft(key);
    else saveDraft(key, now);
  };
  form.addEventListener('input', keep);
  form.addEventListener('click', (e) => e.target.closest('.card-row button') && setTimeout(keep));
  onSave(form, async () => {
    clearFieldErrors(form);
    alertIn('client-alert');
    const data = Object.fromEntries(new FormData(form));
    const body = { name: data.name, phone: data.phone, email: data.email, notes: data.notes, cardLeft: Number(data.cardLeft) || 0 };
    if (form.elements.google) body.google = data.google;
    try {
      await api(id ? `/api/admin/clients/${id}` : '/api/admin/clients', { method: id ? 'PUT' : 'POST', body });
      clearDraft(key);
      toast(t('admin.saved'));
      closeClient();
      loadClients();
    } catch (err) {
      if (err.status === 401) return showLogin();
      if (err.status === 409) return alertIn('client-alert', 'error', t(err.data?.error === 'google_taken' ? 'admin.googleTakenClient' : 'admin.phoneTaken'));
      if (err.status === 400) return showFieldErrors(form, err.data.fields, { cardLeft: 'admin.cardInvalid', google: 'errors.email' });
      alertIn('client-alert', 'error', t('common.error'));
    }
  });
  box.replaceChildren(form);
  box.hidden = false;
  $('clients-list').hidden = true;
  form.querySelector('input').focus();
}

function closeClient() {
  $('client-detail').hidden = true;
  $('client-detail').replaceChildren();
  $('clients-list').hidden = false;
}

async function forgetClient(client) {
  if (!confirm(t('admin.forgetConfirm', { name: client.name }))) return;
  await guarded(() => api(`/api/admin/clients/${client.id}`, { method: 'DELETE', body: {} }));
  toast(t('admin.forgotten'));
  closeClient();
  loadClients();
}

// ---------------------------------------------------------------------------
// Who may sign in
// ---------------------------------------------------------------------------

async function loadPeople() {
  const { admins, me } = await guarded(() => api('/api/admin/admins'));
  state.people = admins;
  state.me = me;
  renderPeople();
}

function renderPeople() {
  $('people-list').replaceChildren(
    ...state.people.map((a) =>
      el(
        'article',
        { class: 'item item-plain' },
        el(
          'div',
          { class: 'item-body' },
          el('h3', {}, a.name, a.id === state.me ? ` ${t('admin.you')}` : ''),
          el(
            'p',
            {},
            [a.last_used ? t('admin.lastSignIn', { date: fmtMoment(a.last_used) }) : t('admin.neverSignedIn'), t('admin.devices', { n: a.passkeys })].join(' · '),
            a.google ? [' · ', el('bdi', { dir: 'ltr' }, t('admin.googleAccount', { email: a.google }))] : '',
          ),
        ),
        el(
          'div',
          { class: 'item-actions' },
          a.id === state.me
            ? [
                el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: addThisDevice }, t('admin.addDevice')),
                state.google && !a.google ? el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: (e) => toGoogle('link', e.currentTarget) }, t('admin.googleConnect')) : '',
                state.google && a.google
                  ? el('button', {
                      type: 'button',
                      class: 'btn btn-ghost btn-sm',
                      onclick: async () => {
                        if (!confirm(t('admin.googleDisconnectConfirm'))) return;
                        await guarded(() => api('/api/admin/google', { method: 'DELETE', body: {} }));
                        toast(t('admin.googleDisconnected'));
                        loadPeople();
                      },
                    }, t('admin.googleDisconnect'))
                  : '',
              ]
            : el('button', {
                type: 'button',
                class: 'btn btn-danger btn-sm',
                onclick: async () => {
                  if (!confirm(t('admin.removeConfirm', { name: a.name }))) return;
                  await guarded(() => api(`/api/admin/admins/${a.id}`, { method: 'DELETE', body: {} }));
                  loadPeople();
                },
              }, t('admin.remove')),
        ),
      ),
    ),
  );
}

onSave($('invite-form'), async () => {
  clearFieldErrors($('invite-form'));
  const name = $('invite-name').value.trim();
  if (name.length < 2) return showFieldErrors($('invite-form'), ['name'], { name: 'admin.inviteNameNeeded' });
  const { link, hours } = await guarded(() => api('/api/admin/invites', { method: 'POST', body: { name } }));
  const message = t('admin.inviteMessage', { link, hours });
  $('invite-result').replaceChildren(
    el(
      'div',
      { class: 'panel invite-panel' },
      el('p', {}, t('admin.inviteReady', { name, hours })),
      el('p', { class: 'invite-link' }, el('bdi', {}, link)),
      el(
        'div',
        { class: 'toolbar' },
        el('a', { class: 'btn btn-primary btn-sm', href: `https://wa.me/?text=${encodeURIComponent(message)}`, target: '_blank', rel: 'noopener' }, t('admin.shareWhatsapp')),
        el('button', {
          type: 'button',
          class: 'btn btn-outline btn-sm',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(link);
              toast(t('admin.copied'));
            } catch {
              toast(t('common.error'));
            }
          },
        }, t('admin.copy')),
      ),
    ),
  );
  $('invite-name').value = '';
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

onLangChange(() => {
  if ($('dashboard').hidden) return;
  renderBookings();
  if (state.schedule) {
    renderSettings(scheduleBody());
    renderHours();
    blockField(true);
    scheduleChanged();
  }
  renderBlocked();
  renderMessages();
  siteTab.render({ again: true });
});

Promise.all([loadConfig().catch(() => null), api('/api/admin/session')])
  .then(async ([cfg, { enabled, loggedIn, access, passkeys, editor, google, clientGoogle }]) => {
    state.config = cfg;
    state.passkeys = Boolean(passkeys);
    state.editor = Boolean(editor);
    state.access = Boolean(access) && !state.passkeys;
    state.enabled = Boolean(enabled);
    state.google = Boolean(google) && state.passkeys;
    state.clientGoogle = Boolean(clientGoogle);
    $('admin-disabled').hidden = enabled;
    $('login-form').hidden = !enabled || state.passkeys;
    // Opening a one-time link always adds this phone's passkey.
    const inside = loggedIn && !(state.passkeys && inviteCode());
    await (inside ? showDashboard() : showLogin());
    afterGoogle(inside);
  })
  .catch(() => showLogin());
