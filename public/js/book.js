import {
  api,
  clearFieldErrors,
  el,
  formatPrice,
  getLang,
  loadConfig,
  locale,
  onLangChange,
  pick,
  showFieldErrors,
  t,
  toast,
} from './site.js';
import { svg } from './icons.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  step: 1,
  service: null,
  month: null, // "YYYY-MM"
  date: null,
  time: null,
  loading: false,
  autoAdvanced: false,
};
const cache = new Map(); // `${serviceId}|${month}` → { "YYYY-MM-DD": ["HH:MM"] }

// ---------------------------------------------------------------------------
// Date helpers (plain strings, no time-zone surprises)
// ---------------------------------------------------------------------------

const utc = (s) => {
  const [y, m, d = 1] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const iso = (date) => date.toISOString().slice(0, 10);
const monthOf = (dateStr) => dateStr.slice(0, 7);
function shiftMonth(month, n) {
  const d = utc(month);
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d).slice(0, 7);
}
function lastDay(month) {
  const d = utc(month);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}
function maxDate() {
  const d = utc(state.config.today);
  d.setUTCDate(d.getUTCDate() + state.config.maxDaysAhead);
  return iso(d);
}
function fmtDate(dateStr, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: 'UTC' }).format(utc(dateStr));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// The phone's Back button goes back a step (with what was chosen), not off the page. One entry in
// the browser's history stands for "a step back"; once the booking is made, Back doesn't open the
// form again (the payment details stay on the screen).
let stepBack = false;
function keepBack(step) {
  if (step > 1 && !stepBack) {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    history.pushState(history.state, '');
    stepBack = true;
  } else if (step === 1 && stepBack) {
    stepBack = false;
    history.back();
  }
}
window.addEventListener('popstate', () => {
  if (!stepBack) return;
  stepBack = false;
  if (!$('confirmation').hidden || state.step <= 1) return;
  goTo(state.step - 1);
});

function goTo(step, { focus = true, back = true } = {}) {
  if (back) keepBack(step);
  state.step = step;
  for (let i = 1; i <= 3; i++) $(`step-${i}`).hidden = i !== step;
  for (const li of $('stepper').children) {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-active', n === step);
    li.classList.toggle('is-done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  if (step === 2) loadMonth();
  if (focus) {
    $(`step-${step}-title`).focus({ preventScroll: true });
    $('stepper').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---------------------------------------------------------------------------
// Step 1 – service
// ---------------------------------------------------------------------------

function renderServices() {
  $('service-options').replaceChildren(
    ...state.config.services.map((s) =>
      el(
        'button',
        {
          type: 'button',
          class: 'service-option',
          'aria-pressed': String(state.service?.id === s.id),
          onclick: () => selectService(s),
        },
        s.image
          ? el('span', { class: 'service-thumb' }, el('img', { src: s.image, alt: '', width: 700, height: 700 }))
          : el('span', { class: 'card-icon', html: svg(s.icon) }),
        el(
          'span',
          {},
          el('strong', {}, pick(s.name)),
          s.price == null
            ? null
            : el('span', { class: 'service-meta' }, el('span', { class: 'chip chip-accent' }, formatPrice(s.price))),
        ),
        el('span', { class: 'check-mark', 'aria-hidden': 'true' }),
      ),
    ),
  );
  $('to-step-2').disabled = !state.service;
}

function selectService(service) {
  if (state.service?.id !== service.id) {
    state.service = service;
    state.date = null;
    state.time = null;
  }
  renderServices();
  renderSummary();
}

// ---------------------------------------------------------------------------
// Step 2 – calendar & slots
// ---------------------------------------------------------------------------

async function loadMonth() {
  const key = `${state.service.id}|${state.month}`;
  renderCalendar();
  if (!cache.has(key)) {
    state.loading = true;
    renderCalendar();
    try {
      const params = new URLSearchParams({ service: state.service.id, from: `${state.month}-01`, to: lastDay(state.month) });
      const { days } = await api(`/api/availability?${params}`);
      cache.set(key, days);
    } catch {
      setAlert('time-alert', 'error', t('common.error'));
    } finally {
      state.loading = false;
    }
  }
  // Pre-select the first open day of the month for a quicker flow.
  const days = cache.get(key) || {};
  const anyOpen = Object.values(days).some((s) => s.length);
  // Near the end of a month there may be no open days left: start on next month instead.
  if (!anyOpen && !state.autoAdvanced && cache.has(key) && state.month === monthOf(state.config.today) && shiftMonth(state.month, 1) <= monthOf(maxDate())) {
    state.autoAdvanced = true;
    state.month = shiftMonth(state.month, 1);
    return loadMonth();
  }
  if (!state.date || monthOf(state.date) !== state.month || !days[state.date]?.length) {
    const first = Object.keys(days).sort().find((d) => days[d].length);
    if (first) {
      state.date = first;
      state.time = null;
    }
  }
  renderCalendar();
  renderSlots();
  renderSummary();
}

function renderCalendar() {
  const cal = $('calendar');
  const days = cache.get(`${state.service?.id}|${state.month}`) || {};
  const start = utc(state.month);
  const offset = start.getUTCDay(); // weeks start on Sunday (Israeli calendar)
  const count = utc(lastDay(state.month)).getUTCDate();

  $('month-label').textContent = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(start);
  $('prev-month').disabled = state.month <= monthOf(state.config.today);
  $('next-month').disabled = shiftMonth(state.month, 1) > monthOf(maxDate());
  cal.classList.toggle('is-loading', state.loading);

  const dowFmt = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' });
  const cells = [];
  for (let i = 0; i < 7; i++) {
    cells.push(el('span', { class: 'dow', 'aria-hidden': 'true' }, dowFmt.format(new Date(Date.UTC(2023, 0, 1 + i)))));
  }
  for (let i = 0; i < offset; i++) cells.push(el('span'));
  for (let d = 1; d <= count; d++) {
    const date = `${state.month}-${String(d).padStart(2, '0')}`;
    const open = (days[date] || []).length > 0;
    cells.push(
      el(
        'button',
        {
          type: 'button',
          class: ['day', open && 'is-available', date === state.config.today && 'is-today'].filter(Boolean).join(' '),
          'data-date': date,
          disabled: !open,
          'aria-pressed': String(date === state.date),
          'aria-label': fmtDate(date),
          onclick: () => {
            state.date = date;
            state.time = null;
            renderCalendar();
            renderSlots();
            renderSummary();
          },
        },
        String(d),
      ),
    );
  }
  cal.replaceChildren(...cells);
}

function renderSlots() {
  const wrap = $('slots');
  const days = cache.get(`${state.service.id}|${state.month}`);
  const anyOpen = days && Object.values(days).some((s) => s.length);

  if (!state.date || monthOf(state.date) !== state.month) {
    $('slots-title').textContent = '';
    wrap.replaceChildren(
      el('p', { class: 'empty-state' }, state.loading ? t('common.loading') : t(days && !anyOpen ? 'book.noSlotsMonth' : 'book.pickDay')),
    );
  } else {
    const slots = days?.[state.date] || [];
    $('slots-title').textContent = t('book.slotsFor', { date: fmtDate(state.date) });
    wrap.replaceChildren(
      slots.length
        ? el(
            'div',
            { class: 'slots' },
            slots.map((time) =>
              el(
                'button',
                {
                  type: 'button',
                  class: 'slot',
                  'aria-pressed': String(time === state.time),
                  onclick: () => {
                    state.time = time;
                    renderSlots();
                    renderSummary();
                  },
                },
                time,
              ),
            ),
          )
        : el('p', { class: 'empty-state' }, t('book.noSlots')),
    );
  }
  $('to-step-3').disabled = !(state.date && state.time);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function renderSummary() {
  const s = state.service;
  const rows = [
    ['book.service', s && pick(s.name)],
    ['book.date', state.date && fmtDate(state.date)],
    ['book.time', state.time],
    s?.price != null && ['book.price', viaTransfer() ? planPrice(selectedPlan()) : formatPrice(s.price)],
  ].filter(Boolean);
  $('summary').replaceChildren(
    ...rows.flatMap(([label, value]) => [
      el('dt', {}, t(label)),
      el('dd', {}, value ? el('bdi', {}, value) : el('span', { class: 'placeholder' }, t('book.notChosen'))),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Step 3 – details & submit
// ---------------------------------------------------------------------------

function setAlert(id, kind, message) {
  $(id).replaceChildren(message ? el('p', { class: `alert alert-${kind}` }, message) : '');
}

// On a static host (GitHub Pages) there's no server: the request is sent to the
// practitioner on WhatsApp instead, and they confirm the time with the client.
const viaWhatsApp = () => state.config?.handoff === 'whatsapp';

function whatsappMessage(data) {
  const lines = [
    t('book.waIntro', { name: data.name.trim() }),
    `${t('book.service')}: ${pick(state.service.name)}`,
    `${t('book.date')}: ${fmtDate(state.date)}`,
    `${t('book.time')}: ${state.time}`,
  ];
  if (data.notes?.trim()) lines.push(`${t('book.waNotes')}: ${data.notes.trim()}`);
  return lines.join('\n');
}

function handOffToWhatsApp(data) {
  const href = `https://wa.me/${state.config.business.whatsapp}?text=${encodeURIComponent(whatsappMessage(data))}`;
  window.open(href, '_blank', 'noopener');
  const booking = { date: state.date, time: state.time, duration: state.service.duration, name: data.name.trim() };
  showConfirmation(booking, false, href);
}

const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Paying on the site (Grow): the client pays on Grow's secure page and comes back here. The
// payment company asks for a full name and an Israeli mobile number.
const viaPayment = () => state.config?.payments === true;

// Paying by Bit or PayBox to David's phone: the client picks one session, the card of
// sessions (this one included) or a session from a card they have; the booking then waits
// for David to see the payment and approve it.
const viaTransfer = () => Boolean(state.config?.transfer);
const selectedPlan = () => document.querySelector('#plan-options input[name="plan"]:checked')?.value || 'single';
function planAmount(plan) {
  const prices = state.config.prices;
  return plan === 'pack' ? prices.pack.price : plan === 'card' ? 0 : (state.service?.price ?? prices.session.price);
}
const planPrice = (plan) => (plan === 'card' ? t('book.fromCard') : formatPrice(planAmount(plan)));

function renderPlans() {
  if (!viaTransfer()) return;
  const { pack } = state.config.prices;
  $('plan-pack-name').textContent = t('prices.pack', { n: pack.sessions });
  $('plan-pack-sub').textContent = t('book.planPackSub', { n: pack.sessions - 1 });
  for (const node of document.querySelectorAll('[data-plan-price]')) node.textContent = formatPrice(planAmount(node.dataset.planPrice));
}
const isFullName = (name) => name.trim().split(/\s+/).filter((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length >= 2).length >= 2;
function isMobile(phone) {
  let digits = phone.replace(/\D+/g, '');
  if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  return /^05\d{8}$/.test(digits);
}
const PAY_MESSAGES = { name: 'errors.fullName', phone: 'errors.mobile' };
const saved = {
  key: (ref) => `pay:${ref}`,
  get(ref) {
    try {
      return JSON.parse(sessionStorage.getItem(this.key(ref)) || 'null');
    } catch {
      return null;
    }
  },
  set(ref, value) {
    try {
      sessionStorage.setItem(this.key(ref), JSON.stringify(value));
    } catch {}
  },
};

// Agreeing to the terms, with a link to them: the payment company requires it on this form.
function renderConsent() {
  if (!viaPayment()) return;
  const span = document.querySelector('#details-form [name="consent"] + span');
  span.removeAttribute('data-i18n');
  span.replaceChildren(t('book.termsBefore'), el('a', { href: '/terms', target: '_blank', rel: 'noopener' }, t('book.termsLink')));
}

async function submit(e) {
  e.preventDefault();
  const form = $('details-form');
  const data = Object.fromEntries(new FormData(form));
  clearFieldErrors(form);
  setAlert('details-alert');

  const bad = [];
  const paying = viaPayment();
  const transfer = viaTransfer();
  if ((data.name || '').trim().length < 2 || (paying && !isFullName(data.name))) bad.push('name');
  if (paying || transfer || !viaWhatsApp()) {
    if (!PHONE_RE.test((data.phone || '').trim()) || (paying && !isMobile(data.phone))) bad.push('phone');
    if (data.email && !EMAIL_RE.test(data.email.trim())) bad.push('email');
  }
  if (!data.consent) bad.push('consent');
  const messages = paying ? PAY_MESSAGES : {};
  if (bad.length) return showFieldErrors(form, bad, messages);
  if (!paying && !transfer && viaWhatsApp()) return handOffToWhatsApp(data);

  const button = $('confirm-btn');
  button.disabled = true;
  button.textContent = t(paying ? 'book.paying' : transfer ? 'book.saving' : 'book.confirming');
  let leaving = false;
  try {
    const { booking, payUrl, token, transfer: payTo } = await api('/api/bookings', {
      method: 'POST',
      body: {
        serviceId: state.service.id,
        date: state.date,
        time: state.time,
        name: data.name,
        phone: data.phone,
        email: data.email,
        notes: data.notes,
        consent: true,
        lang: getLang(),
        plan: transfer ? selectedPlan() : undefined,
      },
    });
    if (payTo) return showConfirmation(booking, false, null, payTo);
    if (payUrl) {
      // Off to Grow's page. This tab remembers the booking for when the client comes back.
      saved.set(booking.ref, { token, booking });
      leaving = true;
      location.assign(payUrl);
      return;
    }
    showConfirmation(booking, Boolean(data.email));
  } catch (err) {
    if (err.status === 409 || err.data?.fields?.some((f) => ['date', 'time', 'serviceId'].includes(f))) {
      cache.clear();
      state.time = null;
      goTo(2);
      setAlert('time-alert', 'error', t('book.slotTaken'));
    } else if (err.status === 400) {
      showFieldErrors(form, (err.data.fields || []).filter((f) => f !== 'plan'), messages);
    } else {
      const key = err.status === 429 ? 'errors.rate' : paying && (err.status === 502 || err.status === 503) ? 'book.payError' : 'common.error';
      setAlert('details-alert', 'error', t(key));
    }
  } finally {
    if (!leaving) {
      button.disabled = false;
      button.textContent = t(button.dataset.i18n);
    }
  }
}

// ---------------------------------------------------------------------------
// Back from the payment page
// ---------------------------------------------------------------------------

/** Paid: wait for the payment company to confirm it (a few seconds), then show the booking. */
async function returnFromPayment(ref) {
  const mine = saved.get(ref);
  const booking = mine?.booking || { ref };
  state.service = state.config.services.find((s) => s.id === booking.serviceId) || state.service;
  $('booking-flow').hidden = true;
  document.querySelector('.page-hero').hidden = true;
  $('confirmation').hidden = false;
  $('confirm-email').hidden = true;
  $('confirm-whatsapp').hidden = true;
  const title = $('confirm-title');
  title.dataset.i18n = 'book.payChecking';
  title.textContent = t('book.payChecking');
  $('confirm-text').textContent = '';
  $('confirm-details').replaceChildren();

  // The client came back through Grow's "paid" address, so a payment was made: wait for it,
  // even past the end of its hold (a late payment still counts while the time is free).
  let status = 'pending';
  for (let i = 0; i < 15 && status !== 'confirmed'; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    try {
      ({ status } = await api(`/api/bookings/status?ref=${encodeURIComponent(ref)}`));
    } catch {
      status = 'pending';
    }
  }
  if (status === 'confirmed' && state.service && booking.date) return showConfirmation({ ...booking, paid: true }, false);
  const key = status === 'confirmed' ? 'book.successTitle' : 'book.payPending';
  title.dataset.i18n = key;
  title.textContent = t(key);
  if (status === 'confirmed') {
    $('confirm-details').replaceChildren(el('dt', {}, t('book.ref')), el('dd', {}, el('span', { class: 'ref' }, ref)));
  }
}

/** The client cancelled on the payment page: free the held time and let them choose again. */
async function returnCancelled(ref) {
  const mine = saved.get(ref);
  if (mine?.token) await api('/api/bookings/release', { method: 'POST', body: { ref, token: mine.token } }).catch(() => {});
  const s = mine && state.config.services.find((x) => x.id === mine.booking.serviceId);
  if (s) {
    state.service = s;
    state.month = monthOf(mine.booking.date);
  }
  return s;
}

let confirmed = null;

function renderConfirmation() {
  if (!confirmed) return;
  const { booking, whatsappHref, payTo, status } = confirmed;
  const title = $('confirm-title');
  title.dataset.i18n = payTo ? (status === 'confirmed' ? 'book.statusConfirmed' : 'book.transferTitle') : whatsappHref ? 'book.waTitle' : 'book.successTitle';
  title.textContent = t(title.dataset.i18n);
  $('confirm-text').textContent = payTo
    ? booking.plan === 'card'
      ? t('book.transferCardText')
      : t('book.transferText', { amount: formatPrice(booking.price) })
    : whatsappHref
      ? t('book.waText')
      : t('book.successText', { name: booking.name });
  // Bit or PayBox: where to send it, and the booking's state while David hasn't approved yet.
  $('confirm-pay').hidden = !(payTo && booking.plan !== 'card' && status === 'pending');
  if (payTo) {
    // His own Bit and PayBox links (when he set them): the app opens straight to him, and the
    // phone number stays as the other way.
    let apps = 0;
    for (const app of ['bit', 'paybox']) {
      const link = /^https:\/\//.test(payTo[app] || '') ? payTo[app] : '';
      $(`pay-${app}`).hidden = !link;
      if (link) {
        $(`pay-${app}`).href = link;
        apps++;
      }
    }
    $('pay-apps').hidden = !apps;
    $('pay-apps-hint').textContent = apps ? t('book.payAppsHint', { amount: formatPrice(booking.price) }) : '';
    $('pay-to-label').dataset.i18n = apps ? 'book.payToOr' : 'book.payTo';
    $('pay-to-label').textContent = t($('pay-to-label').dataset.i18n);
    $('pay-phone').textContent = payTo.phone;
    $('pay-note').replaceChildren(t('book.payNoteBefore'), el('strong', { class: 'ref' }, booking.ref));
    const statusKey = { confirmed: 'book.statusConfirmed', cancelled: 'book.statusCancelled', expired: 'book.statusCancelled' }[status] || 'book.statusPending';
    $('pay-status').textContent = t(statusKey);
    $('pay-status').classList.toggle('is-done', status === 'confirmed');
    $('pay-status').hidden = false;
  } else {
    $('pay-status').hidden = true;
  }
  $('confirm-whatsapp').hidden = !whatsappHref;
  if (whatsappHref) $('confirm-whatsapp').href = whatsappHref;
  const rows = [
    booking.ref && ['book.ref', el('span', { class: 'ref' }, booking.ref)],
    ['book.service', pick(state.service.name)],
    ['book.date', fmtDate(booking.date)],
    ['book.time', el('bdi', {}, booking.time)],
    booking.paid && booking.price != null && ['book.paid', formatPrice(booking.price)],
    payTo && ['book.amount', booking.plan === 'card' ? t('book.fromCard') : formatPrice(booking.price)],
  ].filter(Boolean);
  $('confirm-details').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, t(k)), el('dd', {}, v)]));
}

function showConfirmation(booking, emailed, whatsappHref = null, payTo = null) {
  confirmed = { booking, whatsappHref, payTo, status: payTo ? 'pending' : null };
  if (payTo) watchApproval(booking.ref);
  $('booking-flow').hidden = true;
  document.querySelector('.page-hero').hidden = true;
  $('confirmation').hidden = false;
  $('confirm-email').hidden = !emailed;
  renderConfirmation();
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('confirm-title').focus({ preventScroll: true });
}

/** While the page stays open, shows when David approves the booking (or cancels it). */
function watchApproval(ref) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const { status } = await api(`/api/bookings/status?ref=${encodeURIComponent(ref)}`);
      if (status !== confirmed?.status) {
        confirmed.status = status;
        renderConfirmation();
      }
      if (status !== 'pending') clearInterval(timer);
    } catch {}
    if (tries >= 80) clearInterval(timer); // about 20 minutes
  }, 15_000);
}

// Opening Bit or PayBox: the booking number is copied on the way, to paste in the payment's note.
for (const app of ['bit', 'paybox']) {
  $(`pay-${app}`).addEventListener('click', () => {
    const ref = confirmed?.booking?.ref;
    if (ref) navigator.clipboard?.writeText(ref).then(() => toast(t('book.refCopied')), () => {});
  });
}

$('copy-phone').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(confirmed.payTo.phone.replace(/\D+/g, ''));
    toast(t('book.copied'));
  } catch {
    toast(confirmed.payTo.phone);
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function renderAll() {
  if (!state.config) return;
  renderServices();
  if (state.service) {
    renderCalendar();
    renderSlots();
  }
  renderSummary();
  renderConsent();
  renderPlans();
  renderConfirmation();
}

$('to-step-2').addEventListener('click', () => {
  setAlert('time-alert');
  goTo(2);
});
$('to-step-3').addEventListener('click', () => goTo(3));
for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => goTo(Number(b.dataset.go)));
$('prev-month').addEventListener('click', () => {
  state.month = shiftMonth(state.month, -1);
  loadMonth();
});
$('next-month').addEventListener('click', () => {
  state.month = shiftMonth(state.month, 1);
  loadMonth();
});
$('details-form').addEventListener('submit', submit);
onLangChange(renderAll);

loadConfig()
  .then((config) => {
    state.config = config;
    state.month = monthOf(config.today);
    if (viaPayment()) {
      $('confirm-btn').dataset.i18n = 'book.toPayment';
      $('confirm-btn').textContent = t('book.toPayment');
    } else if (viaTransfer()) {
      $('plan-options').hidden = false;
      $('confirm-btn').dataset.i18n = 'book.saveBooking';
      $('confirm-btn').textContent = t('book.saveBooking');
      const wanted = new URLSearchParams(location.search).get('plan');
      const pick = document.querySelector(`#plan-options input[value="${wanted === 'pack' || wanted === 'card' ? wanted : 'single'}"]`);
      if (pick) pick.checked = true;
      $('plan-options').addEventListener('change', renderSummary);
    } else if (viaWhatsApp()) {
      // The request is sent from the client's own WhatsApp, so the practitioner
      // already sees their number: no phone or email fields.
      $('b-phone').closest('.form-row').hidden = true;
      $('confirm-btn').dataset.i18n = 'book.confirmWhatsapp';
      $('confirm-btn').textContent = t('book.confirmWhatsapp');
    }
    const preset = config.services.find((s) => s.id === new URLSearchParams(location.search).get('service'));
    if (preset) state.service = preset;
    const back = viaPayment() ? new URLSearchParams(location.search) : null;
    const paidRef = back?.get('paid');
    const cancelledRef = back?.get('cancelled');
    if (paidRef || cancelledRef) history.replaceState(null, '', '/book');
    renderAll();
    if (paidRef) return returnFromPayment(paidRef);
    if (cancelledRef) {
      return returnCancelled(cancelledRef).then((s) => {
        renderAll();
        goTo(s ? 2 : 1, { focus: false, back: false });
        setAlert('time-alert', 'info', t('book.payCancelled'));
      });
    }
    goTo(preset ? 2 : 1, { focus: false, back: false });
  })
  .catch(() => {
    $('service-options').replaceChildren(el('p', { class: 'alert alert-error' }, t('common.error')));
  });
