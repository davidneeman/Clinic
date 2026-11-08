import { dictionaries } from './i18n.js';
import { hydrateIcons, svg } from './icons.js';
import { applyContentTexts } from './site-content.js';

const root = document.documentElement;
const listeners = new Set();

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode – ignore */
  }
}

// ---------------------------------------------------------------------------
// David's content and notices (the admin panel's "האתר" tab). The Worker puts them in the page
// as a data block (#site-data); his texts replace the dictionary's own before anything is
// written on the page.
// ---------------------------------------------------------------------------

/** The Hebrew texts as they come with the site (for "back to the original"). */
export const pristineHebrew = structuredClone(dictionaries.he);
const siteDataListeners = new Set();
let siteData = readSiteData();

function readSiteData() {
  const node = document.getElementById('site-data');
  if (!node) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

export const getSiteData = () => siteData;
/** Where his uploaded photos are: this site ('' – the GitHub Pages copy asks the site's address). */
export const mediaBase = () => '';
export function onSiteData(fn) {
  siteDataListeners.add(fn);
}

/** Newer content (the GitHub Pages copy fetches it after the page opens): show it everywhere. */
export function setSiteData(data) {
  siteData = data;
  useSiteTexts();
  applyTranslations();
  renderNotices();
  siteDataListeners.forEach((fn) => fn(data));
}

function useSiteTexts() {
  applyContentTexts(dictionaries.he, pristineHebrew, siteData?.content?.texts);
}
useSiteTexts();

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export function getLang() {
  return root.lang === 'en' ? 'en' : 'he';
}

export function locale() {
  return getLang() === 'he' ? 'he-IL' : 'en-GB';
}

/** Look up "section.key" in the current language; `{name}` placeholders are filled from vars. */
export function t(path, vars) {
  const lookup = (lang) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), dictionaries[lang]);
  let str = lookup(getLang()) ?? lookup('he') ?? path;
  if (vars) str = str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
  return str;
}

/** Pick the current language out of a { he, en } object from the config. */
export function pick(obj) {
  if (obj == null || typeof obj === 'string') return obj ?? '';
  return obj[getLang()] ?? obj.he ?? '';
}

export function onLangChange(fn) {
  listeners.add(fn);
}

export function setLang(lang) {
  root.lang = lang;
  root.dir = lang === 'he' ? 'rtl' : 'ltr';
  storageSet('lang', lang);
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.delete('lang');
    history.replaceState(null, '', url);
  }
  applyTranslations();
  listeners.forEach((fn) => fn(lang));
}

/**
 * Fill text from the dictionary:
 *   data-i18n="section.key"                     → textContent
 *   data-i18n-attr="placeholder:key;aria-label:key" → attributes
 */
export function applyTranslations(scope = document) {
  for (const el of scope.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
    // A paragraph he can leave empty (data-optional) disappears when it is.
    const box = el.closest('[data-optional]');
    if (box) box.hidden = !el.textContent.trim();
  }
  for (const el of scope.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  const titleKey = document.body.dataset.titleKey;
  if (titleKey && siteConfig) document.title = `${t(titleKey)} | ${pick(siteConfig.business.name)}`;
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.content = t('meta.description');
  updateToggles();
  renderBusiness();
  renderStatus();
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function getTheme() {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}

function setTheme(theme) {
  root.dataset.theme = theme;
  storageSet('theme', theme);
  updateToggles();
  syncThemeColor();
}

// Phone browsers tint their address bar with the page's background color.
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (meta && bg) meta.setAttribute('content', bg);
}

function updateToggles() {
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    const dark = getTheme() === 'dark';
    themeBtn.innerHTML = svg(dark ? 'sun' : 'moon');
    themeBtn.setAttribute('aria-label', t(dark ? 'a11y.toLight' : 'a11y.toDark'));
    themeBtn.title = themeBtn.getAttribute('aria-label');
  }
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.textContent = t('nav.switchLang');
    langBtn.lang = getLang() === 'he' ? 'en' : 'he';
  }
}

// ---------------------------------------------------------------------------
// Config (business details + services from the server)
// ---------------------------------------------------------------------------

let siteConfig = null;
let configPromise = null;

export function loadConfig() {
  configPromise ??= fetch('/api/config')
    .then((r) => {
      if (!r.ok) throw new Error(`config ${r.status}`);
      return r.json();
    })
    .then((cfg) => {
      siteConfig = cfg;
      applyTranslations();
      return cfg;
    });
  return configPromise;
}

export function formatPrice(price) {
  if (!price) return t('common.free');
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: siteConfig?.currency || 'ILS',
    maximumFractionDigits: 0,
  }).format(price);
}

function telHref(phone) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

function renderBusiness() {
  if (!siteConfig) return;
  const b = siteConfig.business;
  const address = pick(b.address);
  // "Street 5, City (Building)" → street line for maps/navigation, building shown separately.
  const street = address.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  // On screen, a house number stays on the same line as its street name.
  const keepNumber = (text) => text.replace(/ (?=\d)/g, ' ');
  const values = {
    name: pick(b.name),
    tagline: pick(b.tagline),
    phone: b.phone,
    email: b.email,
    address: keepNumber(address),
    street: keepNumber(street),
    building: (address.match(/\((.*?)\)/) || [])[1] || '',
    year: String(new Date().getFullYear()),
  };
  for (const el of document.querySelectorAll('[data-biz]')) {
    const v = values[el.dataset.biz];
    if (v != null) el.textContent = v;
  }
  for (const el of document.querySelectorAll('[data-biz-href]')) {
    const kind = el.dataset.bizHref;
    const href =
      kind === 'phone' ? b.phone && telHref(b.phone)
      : kind === 'email' ? b.email && `mailto:${b.email}`
      : kind === 'whatsapp' ? b.whatsapp && `https://wa.me/${b.whatsapp}`
      : kind === 'instagram' ? b.instagram
      : kind === 'facebook' ? b.facebook
      : kind === 'maps' ? street && `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(street)}`
      : kind === 'waze' ? street && `https://waze.com/ul?q=${encodeURIComponent(street)}&navigate=yes`
      : '';
    const item = el.closest('[data-biz-item]') || el;
    item.hidden = !href;
    if (href) el.href = href;
  }
}

// ---------------------------------------------------------------------------
// Opening hours: "open now" / "opens tomorrow at…" from the weekly schedule
// ---------------------------------------------------------------------------

const hhmmToMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Day of week (0 = Sunday) and minute of the day in the clinic's time zone. */
export function clinicNow(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function dayName(day, style = 'long') {
  return new Intl.DateTimeFormat(locale(), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

/** "YYYY-MM-DD" in the clinic's time zone, `offset` days from `at`. */
function clinicDate(timeZone, at, offset = 0) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

export function clinicStatus(cfg = siteConfig, at = new Date()) {
  if (!cfg?.hours) return null;
  const now = clinicNow(cfg.timezone, at);
  // Days closed in the admin panel (by hand, or by a notice on the site) aren't open.
  const closed = new Set(cfg.closedDays || []);
  const isClosed = (offset) => closed.size > 0 && closed.has(clinicDate(cfg.timezone, at, offset));
  if (!isClosed(0)) {
    for (const [from, to] of cfg.hours[now.day] || []) {
      if (now.minutes >= hhmmToMinutes(from) && now.minutes < hhmmToMinutes(to)) return { open: true, until: to, today: now.day };
    }
  }
  for (let offset = 0; offset < 8; offset++) {
    if (isClosed(offset)) continue;
    const day = (now.day + offset) % 7;
    for (const [from] of cfg.hours[day] || []) {
      if (offset > 0 || hhmmToMinutes(from) > now.minutes) return { open: false, day, offset, at: from, today: now.day };
    }
  }
  return { open: false, today: now.day };
}

function renderStatus() {
  const s = clinicStatus();
  if (!s) return;
  const text = s.open
    ? t('status.open', { time: s.until })
    : s.at == null
      ? ''
      : s.offset === 0
        ? t('status.today', { time: s.at })
        : s.offset === 1
          ? t('status.tomorrow', { time: s.at })
          : t('status.later', { day: dayName(s.day), time: s.at });
  for (const node of document.querySelectorAll('[data-status]')) {
    node.textContent = text;
    node.classList.toggle('is-open', s.open);
    node.hidden = !text;
  }
}

// ---------------------------------------------------------------------------
// Notices at the top of the site ("the clinic is closed until …"), from the admin panel.
// A visitor can close a notice or a piece of news (it stays closed for them until it's
// changed); an alert stays.
// ---------------------------------------------------------------------------

const NOTICE_ICONS = { info: 'info', news: 'sparkle', alert: 'alert' };
const noticeKey = (n) => `${n.id}:${n.v}`;
const closedNotices = () => {
  try {
    const list = JSON.parse(storageGet('notices-closed') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export function renderNotices() {
  document.querySelector('.site-notices')?.remove();
  const header = document.querySelector('.site-header');
  if (!header || header.classList.contains('admin-header')) return;
  const closed = closedNotices();
  const list = (siteData?.notices || []).filter((n) => n && n.text && (n.kind === 'alert' || !closed.includes(noticeKey(n))));
  if (!list.length) return;
  const box = el(
    'div',
    { class: 'site-notices', role: 'region', 'aria-label': t('notice.region') },
    list.map((n) => {
      const kind = NOTICE_ICONS[n.kind] ? n.kind : 'info';
      const item = el(
        'div',
        { class: `notice notice-${kind}` },
        el('span', { class: 'notice-icon', 'aria-hidden': 'true', html: svg(NOTICE_ICONS[kind]) }),
        el('p', { class: 'notice-text' }, kind === 'news' ? el('strong', { class: 'notice-tag' }, t('notice.new')) : '', n.text),
        kind === 'alert'
          ? ''
          : el('button', {
              type: 'button',
              class: 'notice-close',
              'aria-label': t('notice.close'),
              title: t('notice.close'),
              html: svg('close'),
              onclick: () => {
                storageSet('notices-closed', JSON.stringify([...closed.filter((k) => k.split(':')[0] !== String(n.id)), noticeKey(n)].slice(-20)));
                const next = item.nextElementSibling || item.previousElementSibling;
                item.remove();
                if (!box.querySelector('.notice')) box.remove();
                (next?.querySelector('.notice-close') || document.getElementById('main'))?.focus?.({ preventScroll: true });
              },
            }),
      );
      return item;
    }),
  );
  header.before(box);
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // only ever used with trusted icon markup
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Mark invalid fields in a form. `fields` are server field names; `messages` can give one another text. */
export function showFieldErrors(form, fields = [], messages = {}) {
  for (const f of form.querySelectorAll('.has-error')) f.classList.remove('has-error');
  for (const e of form.querySelectorAll('.field-error')) e.remove();
  let first = null;
  for (const name of new Set(fields)) {
    const input = form.elements[name];
    if (!input) continue;
    const wrap = input.closest('.field, .checkbox');
    wrap?.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    if (wrap?.classList.contains('field')) {
      const id = `${input.id}-error`;
      wrap.append(el('span', { class: 'field-error', id, role: 'alert' }, t(messages[name] || `errors.${name}`)));
      input.setAttribute('aria-describedby', id);
    }
    first ??= input;
  }
  first?.focus();
}

export function clearFieldErrors(form) {
  showFieldErrors(form, []);
  for (const i of form.querySelectorAll('[aria-invalid]')) {
    i.removeAttribute('aria-invalid');
    i.removeAttribute('aria-describedby');
  }
}

export function toast(message) {
  const node = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

// ---------------------------------------------------------------------------
// Accessibility menu (text size, contrast, links, motion, font) + statement
// ---------------------------------------------------------------------------

const a11yState = (() => {
  try {
    return JSON.parse(storageGet('a11y')) || {};
  } catch {
    return {};
  }
})();
let a11yPanel = null;

function applyA11y() {
  const c = root.classList;
  c.remove('a11y-text-1', 'a11y-text-2');
  if (a11yState.text) c.add(`a11y-text-${a11yState.text}`);
  for (const k of ['contrast', 'links', 'still', 'font']) c.toggle(`a11y-${k}`, Boolean(a11yState[k]));
  storageSet('a11y', JSON.stringify(a11yState));
  if (!a11yPanel) return;
  for (const b of a11yPanel.querySelectorAll('.a11y-opt')) {
    const v = a11yState[b.dataset.key];
    b.setAttribute('aria-pressed', String(Boolean(v)));
    b.querySelector('.level').textContent = b.dataset.key === 'text' && v ? `+${v}` : '';
  }
}

function initA11yMenu() {
  const toggle = document.getElementById('a11y-toggle');
  if (!toggle) return;
  const options = [
    ['text', 'text'],
    ['contrast', 'contrast'],
    ['links', 'link'],
    ['still', 'pause'],
    ['font', 'font'],
  ];
  a11yPanel = el(
    'div',
    { class: 'a11y-panel', id: 'a11y-panel', role: 'dialog', 'aria-labelledby': 'a11y-title', hidden: true },
    el('h2', { id: 'a11y-title' }, el('span', { html: svg('a11y') }), el('span', { 'data-i18n': 'a11y.panelTitle' }, t('a11y.panelTitle'))),
    el(
      'div',
      { class: 'a11y-grid' },
      options.map(([key, icon]) =>
        el(
          'button',
          {
            type: 'button',
            class: 'a11y-opt',
            'data-key': key,
            'aria-pressed': 'false',
            html: svg(icon),
            onclick: () => {
              a11yState[key] = key === 'text' ? ((a11yState.text || 0) + 1) % 3 : !a11yState[key];
              applyA11y();
            },
          },
          el('span', { 'data-i18n': `a11y.${key}` }, t(`a11y.${key}`)),
          el('span', { class: 'level' }),
        ),
      ),
    ),
    el(
      'div',
      { class: 'a11y-foot' },
      el('button', { type: 'button', class: 'linklike', 'data-open-statement': '', 'data-i18n': 'a11y.statement' }, t('a11y.statement')),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn-ghost btn-sm',
          'data-i18n': 'a11y.reset',
          onclick: () => {
            for (const k of Object.keys(a11yState)) delete a11yState[k];
            applyA11y();
          },
        },
        t('a11y.reset'),
      ),
    ),
  );
  document.body.append(a11yPanel);

  const setOpen = (open) => {
    a11yPanel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) a11yPanel.querySelector('.a11y-opt')?.focus();
  };
  toggle.addEventListener('click', () => setOpen(a11yPanel.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !a11yPanel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!a11yPanel.hidden && !a11yPanel.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
  });
  applyA11y();
}

let statementDialog = null;

function openStatement() {
  if (!statementDialog) {
    const para = (key) => el('p', { 'data-i18n': key }, t(key));
    statementDialog = el(
      'dialog',
      { class: 'dialog', 'aria-labelledby': 'statement-title' },
      el(
        'div',
        { class: 'dialog-inner' },
        el('button', {
          type: 'button',
          class: 'icon-btn dialog-close',
          html: svg('close'),
          'aria-label': t('a11y.close'),
          onclick: () => statementDialog.close(),
        }),
        el('h2', { id: 'statement-title', 'data-i18n': 'statement.title' }, t('statement.title')),
        para('statement.p1'),
        para('statement.p2'),
        para('statement.p3'),
        el('p', { 'data-statement-contact': '' }),
        el('p', { class: 'caption', 'data-i18n': 'statement.updated' }, t('statement.updated')),
      ),
    );
    statementDialog.addEventListener('click', (e) => e.target === statementDialog && statementDialog.close());
    document.body.append(statementDialog);
  }
  const b = siteConfig?.business;
  // Isolate the phone number so it stays left-to-right inside Hebrew text.
  statementDialog.querySelector('[data-statement-contact]').textContent = b
    ? t('statement.contact', { name: pick(b.name), phone: `\u2066${b.phone}\u2069` })
    : '';
  if (a11yPanel) a11yPanel.hidden = true;
  statementDialog.showModal();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-statement]')) openStatement();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initHeader() {
  const header = document.querySelector('.site-header');
  const nav = document.getElementById('main-nav');
  const toggle = document.getElementById('nav-toggle');

  if (header) {
    const progress = header.querySelector('.scroll-progress');
    const a11yToggle = document.getElementById('a11y-toggle');
    let queued = false;
    let anchorY = window.scrollY;
    const onScroll = () => {
      queued = false;
      const y = window.scrollY;
      header.classList.toggle('is-scrolled', y > 8);
      // Slide the header away while reading down the page; bring it back on the way up.
      const busy =
        nav?.classList.contains('is-open') ||
        a11yToggle?.getAttribute('aria-expanded') === 'true' ||
        header.contains(document.activeElement);
      if (y < 320 || busy) {
        header.classList.remove('is-hidden');
        anchorY = y;
      } else if (y - anchorY > 12) {
        header.classList.add('is-hidden');
        anchorY = y;
      } else if (anchorY - y > 12) {
        header.classList.remove('is-hidden');
        anchorY = y;
      }
      if (progress) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.setProperty('--progress', String(max > 0 ? Math.min(1, window.scrollY / max) : 0));
      }
    };
    onScroll();
    header.addEventListener('focusin', () => header.classList.remove('is-hidden'));
    window.addEventListener(
      'scroll',
      () => {
        if (!queued) {
          queued = true;
          requestAnimationFrame(onScroll);
        }
      },
      { passive: true },
    );
  }

  if (nav && toggle) {
    const isOpen = () => nav.classList.contains('is-open');
    const setOpen = (open) => {
      if (open === isOpen()) return;
      nav.classList.toggle('is-open', open);
      root.classList.toggle('menu-open', open); // dims the page behind the menu
      toggle.setAttribute('aria-expanded', String(open));
      toggle.innerHTML = svg(open ? 'close' : 'menu');
    };
    toggle.addEventListener('click', () => setOpen(!isOpen()));
    nav.addEventListener('click', (e) => e.target.closest('a') && setOpen(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        setOpen(false);
        toggle.focus();
      }
    });
    // A tap outside the open menu closes it. On the page itself the tap does only
    // that (it doesn't also open a photo or follow a link underneath); the other
    // header buttons still work.
    document.addEventListener(
      'click',
      (e) => {
        if (!isOpen() || nav.contains(e.target) || toggle.contains(e.target)) return;
        setOpen(false);
        if (!header?.contains(e.target)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
    // Wide screens show the links in the header instead.
    window.matchMedia('(min-width: 1141px)').addEventListener('change', () => setOpen(false));
  }

  // Theme switch: the new colors spread out from the button in a soft circle
  // (where the browser supports it; the look is in styles.css). While it runs,
  // no color fades on its own, so the whole page changes together.
  let switches = 0;
  document.getElementById('theme-toggle')?.addEventListener('click', (e) => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || root.classList.contains('a11y-still');
    const id = ++switches;
    root.classList.add('theme-switch');
    const done = () => {
      if (id !== switches) return; // a newer switch (a quick second tap) is still running
      root.classList.remove('theme-switch');
      for (const p of ['--vt-x', '--vt-y', '--vt-end']) root.style.removeProperty(p);
    };
    if (!document.startViewTransition || still) {
      setTheme(next);
      requestAnimationFrame(() => requestAnimationFrame(done));
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || box.left + box.width / 2;
    const y = e.clientY || box.top + box.height / 2;
    const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty('--vt-x', `${Math.round(x)}px`);
    root.style.setProperty('--vt-y', `${Math.round(y)}px`);
    root.style.setProperty('--vt-end', `${Math.ceil(reach)}px`);
    document.startViewTransition(() => setTheme(next)).finished.finally(done);
  });
  document.getElementById('lang-toggle')?.addEventListener('click', () =>
    setLang(getLang() === 'he' ? 'en' : 'he'),
  );
}

// ---------------------------------------------------------------------------
// Mouse only: buttons lean slightly toward the pointer.
// ---------------------------------------------------------------------------

function initMagneticButtons() {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let pulled = null;
  const release = () => {
    if (pulled) pulled.style.translate = '';
    pulled = null;
  };
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse' || root.classList.contains('a11y-still')) return release();
      const button = e.target instanceof Element ? e.target.closest('.btn') : null;
      if (button !== pulled) release();
      if (!button || button.disabled) return;
      const r = button.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * 0.18;
      const dy = (e.clientY - (r.top + r.height / 2)) * 0.28;
      button.style.translate = `${dx.toFixed(1)}px ${dy.toFixed(1)}px`;
      pulled = button;
    },
    { passive: true },
  );
  root.addEventListener('mouseleave', release);
  window.addEventListener('blur', release);
}

// ---------------------------------------------------------------------------
// Colour options: open the site with ?options to compare the ways of wearing the
// client's colours (data-palette on <html>, set in theme-init). Never on the normal site.
// ---------------------------------------------------------------------------

// [id, name, page, bands, cards, buttons]
const PALETTES = [
  ['oat', 'שיבולת', '#ede3ce', '#e5d9be', '#d9c7a5', '#5f4630'],
  ['dune', 'דיונה', '#d9c7a5', '#cbaf88', '#ede3ce', '#2e241b'],
];

function initPaletteSwitcher() {
  if (!root.classList.contains('show-palettes')) return;
  const current = () => (PALETTES.some(([id]) => id === root.dataset.palette) ? root.dataset.palette : PALETTES[0][0]);
  const chips = (colors) =>
    el(
      'span',
      { class: 'pal-chips', 'aria-hidden': 'true' },
      ...colors.map((c) => {
        const chip = el('i');
        chip.style.background = c;
        return chip;
      }),
    );
  const buttons = PALETTES.map(([id, name, ...colors]) => el('button', { type: 'button', 'data-palette-id': id }, chips(colors), name));
  // On phones (and screens not tall enough for the bar) the list folds into one round button.
  const toggle = el('button', { type: 'button', class: 'pal-toggle', 'aria-expanded': 'false', 'aria-label': 'בחירת צבעים' });
  const list = el('div', { class: 'pal-list' }, ...buttons);
  const bar = el('div', { class: 'pal-switcher', role: 'group', 'aria-label': 'בחירת צבעים' }, toggle, list);
  const setOpen = (open) => {
    bar.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  const sync = () => {
    const id = current();
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.paletteId === id)));
    const [, name, ...colors] = PALETTES.find(([p]) => p === id);
    toggle.replaceChildren(chips(colors), el('span', {}, name));
  };
  toggle.addEventListener('click', () => setOpen(!bar.classList.contains('is-open')));
  list.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    root.dataset.palette = button.dataset.paletteId;
    storageSet('palette', button.dataset.paletteId);
    syncThemeColor();
    sync();
    setOpen(false);
  });
  document.addEventListener('click', (e) => bar.contains(e.target) || setOpen(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
  sync();
  document.body.append(bar);
}

// Underline the nav link of the section on screen.
function initScrollSpy() {
  const links = [...document.querySelectorAll('.main-nav a[href^="#"]')];
  if (!links.length || !('IntersectionObserver' in window)) return;
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) links.forEach((l) => l.classList.toggle('is-current', l === byId.get(e.target.id)));
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  for (const id of byId.keys()) {
    const section = document.getElementById(id);
    if (section) io.observe(section);
  }
}

function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((i) => i.classList.add('is-visible'));
    return;
  }
  let answered = false;
  const io = new IntersectionObserver(
    (entries) => {
      answered = true;
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  items.forEach((i) => io.observe(i));
  // Some embedded browsers never report visibility; never leave content hidden there.
  setTimeout(() => {
    if (!answered) items.forEach((i) => i.classList.add('is-visible'));
  }, 3000);
}

hydrateIcons();
renderNotices();
initHeader();
initA11yMenu();
applyTranslations();
initReveal();
initScrollSpy();
initMagneticButtons();
initPaletteSwitcher();
syncThemeColor();
loadConfig().catch(() => {});
setInterval(renderStatus, 60_000);
