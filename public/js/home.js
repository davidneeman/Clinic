import {
  api,
  clearFieldErrors,
  clinicNow,
  dayName,
  el,
  formatPrice,
  getLang,
  loadConfig,
  onLangChange,
  pick,
  showFieldErrors,
  t,
} from './site.js';
import { svg } from './icons.js';

const $ = (id) => document.getElementById(id);
const bookHref = (id) => `/book?service=${encodeURIComponent(id)}`;
const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('a11y-still');
const isRtl = () => document.documentElement.dir === 'rtl';
let config = null;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
let refreshScrollFx = () => {};

const arrow = () => el('span', { class: 'flip-rtl', html: svg('arrow') });

// Each treatment photo also exists in a small and a large copy (scripts/make-images.py),
// so every screen gets a sharp version without downloading more than it needs.
const sized = (image, width) => image.replace(/\.jpg$/, `-${width}.jpg`);

// ---------------------------------------------------------------------------
// Treatments: cards that stack as you scroll
// ---------------------------------------------------------------------------

// Each card's photo opens like a curtain the first time it comes into view.
const cardObserver =
  'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add('is-in');
              cardObserver.unobserve(e.target);
            }
          }
        },
        { rootMargin: '0px 0px -12% 0px' },
      )
    : null;

function renderServices() {
  if (!config) return;
  const list = $('services-list');
  list.replaceChildren(
    ...config.services.map((s, i) => {
      const card = el(
        'li',
        { class: 'stack-card', id: `svc-${s.id}` },
        el(
          'div',
          { class: 'stack-img', 'data-parallax': '14' },
          s.image
            ? el('img', {
                // lazy and the size options first, so the browser fetches only the one it needs
                loading: 'lazy',
                srcset: `${s.image} 700w, ${sized(s.image, 1200)} 1200w, ${sized(s.image, 1600)} 1600w`,
                sizes: '(max-width: 860px) 92vw, 50vw',
                src: s.image,
                alt: pick(s.name),
                width: 700,
                height: 700,
              })
            : null,
        ),
        el(
          'div',
          { class: 'stack-body' },
          el('span', { class: 'stack-num', 'aria-hidden': 'true' }, `0${i + 1}`),
          el('h3', { class: 'stack-name' }, pick(s.name)),
          el('p', { class: 'stack-desc' }, pick(s.description)),
          el(
            'div',
            { class: 'stack-foot' },
            el(
              'a',
              { class: 'btn btn-primary btn-arrow', href: bookHref(s.id), 'data-service': s.id },
              el('span', {}, t('treatments.book')),
              arrow(),
            ),
            s.price == null ? null : el('span', { class: 'duration' }, formatPrice(s.price)),
          ),
        ),
      );
      card.style.setProperty('--i', String(i));
      return card;
    }),
  );
  for (const card of list.children) {
    if (cardObserver && !reducedMotion()) cardObserver.observe(card);
    else card.classList.add('is-in');
  }
  refreshScrollFx();
}

// ---------------------------------------------------------------------------
// Prices: a session, and a card of sessions (config/site.json → prices)
// ---------------------------------------------------------------------------

function renderPrices() {
  const box = $('prices');
  const p = config?.prices;
  if (!box || !p) return;
  const items = [
    p.session &&
      el(
        'li',
        { class: 'price' },
        el('span', { class: 'price-name' }, t('prices.session')),
        el('span', { class: 'price-meta' }, t('prices.minutes', { n: p.session.minutes })),
        el('span', { class: 'price-sum' }, formatPrice(p.session.price)),
      ),
    p.pack &&
      el(
        'li',
        { class: 'price price-pack' },
        el('span', { class: 'price-name' }, t('prices.pack', { n: p.pack.sessions })),
        el('span', { class: 'price-sum' }, formatPrice(p.pack.price)),
      ),
  ].filter(Boolean);
  $('price-list').replaceChildren(...items);
  box.hidden = !items.length;
}

// ---------------------------------------------------------------------------
// His quote: each word lights up as it scrolls through the screen
// ---------------------------------------------------------------------------

function renderWords() {
  for (const node of document.querySelectorAll('[data-words]')) {
    const parts = [];
    t(node.dataset.words)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((word, i) => {
        if (i) parts.push(' ');
        parts.push(el('span', { class: 'w' }, word));
      });
    node.replaceChildren(...parts);
    node.dataset.lit = '-1';
  }
  refreshScrollFx();
}

// ---------------------------------------------------------------------------
// Scroll effects: treatment cards sink back as the next one covers them, the
// quote lights up word by word, gallery columns drift.
// ---------------------------------------------------------------------------

function initScrollFx() {
  const list = $('services-list');
  const mosaic = $('mosaic');
  const cols = [...document.querySelectorAll('.mosaic-col')];
  const wide = window.matchMedia('(min-width: 761px)');
  const deco = document.querySelector('.page-deco');
  let queued = false;

  function update() {
    queued = false;
    const vh = window.innerHeight;
    const still = reducedMotion();

    if (list) {
      const cards = [...list.children];
      // Only where the cards actually stack (depends on the look and the screen).
      const stacked = cards.length > 1 && getComputedStyle(cards[0]).position === 'sticky';
      cards.forEach((card, i) => {
        let depth = 0;
        const next = cards[i + 1];
        if (next && stacked && !still) {
          const top = card.getBoundingClientRect().top;
          const h = card.offsetHeight;
          depth = clamp01((top + h - next.getBoundingClientRect().top) / Math.max(1, h - 16));
        }
        card.style.setProperty('--depth', depth.toFixed(3));
      });
    }

    for (const node of document.querySelectorAll('.words')) {
      const words = node.children;
      if (!words.length) continue;
      let lit = words.length;
      if (!still) {
        const r = node.getBoundingClientRect();
        lit = Math.round(clamp01((vh * 0.88 - r.top) / (r.height + vh * 0.4)) * words.length);
      }
      if (Number(node.dataset.lit) !== lit) {
        node.dataset.lit = String(lit);
        for (let i = 0; i < words.length; i++) words[i].classList.toggle('is-lit', i < lit);
      }
    }

    if (mosaic && cols.length) {
      const on = wide.matches && !still;
      const r = mosaic.getBoundingClientRect();
      const d = (r.top + r.height / 2 - vh / 2) / vh;
      for (const col of cols) {
        col.style.setProperty('--shift', on ? `${(d * Number(col.dataset.speed) * vh * 1.5).toFixed(1)}px` : '0px');
      }
    }

    // How far down the page we are (0–1), for backgrounds that change while scrolling.
    if (deco) deco.style.setProperty('--p', (window.scrollY / Math.max(1, document.documentElement.scrollHeight - vh)).toFixed(4));

    // Photos drift a little inside their frames (--py), and frames can grow as
    // they come up the screen (--enter: 0 at the bottom edge, 1 at the top).
    const moving = [...document.querySelectorAll('[data-parallax]')];
    const rects = moving.map((node) => node.getBoundingClientRect());
    moving.forEach((node, i) => {
      const r = rects[i];
      let py = 0;
      let enter = 1;
      if (!still && r.height) {
        // Photos are only 4% larger than their frames, so they never drift past the edge.
        const amp = Math.min(Number(node.dataset.parallax) || 0, r.height * 0.017);
        const c = Math.max(-1, Math.min(1, (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2)));
        py = -c * amp;
        enter = clamp01((vh - r.top) / vh);
      }
      node.style.setProperty('--py', `${py.toFixed(1)}px`);
      node.style.setProperty('--enter', enter.toFixed(3));
    });
  }

  const request = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request);
  refreshScrollFx = request;
  update();
}

// ---------------------------------------------------------------------------
// Gallery: full-screen viewer
// ---------------------------------------------------------------------------

function initLightbox(items) {
  let index = 0;
  const img = el('img', { alt: '' });
  const counter = el('span');
  const navButton = (icon, labelKey, step) =>
    el(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': t(labelKey), onclick: () => show(index + step) },
      el('span', { class: 'flip-rtl', html: svg(icon) }),
    );
  const dialog = el(
    'dialog',
    { class: 'lightbox', 'aria-label': t('gallery.title') },
    el(
      'div',
      { class: 'lightbox-inner' },
      el(
        'div',
        { class: 'lightbox-top' },
        counter,
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': t('gallery.close'), html: svg('close'), onclick: () => dialog.close() }),
      ),
      el('figure', {}, img),
      el('div', { class: 'lightbox-nav' }, navButton('chevronPrev', 'gallery.prev', -1), navButton('chevronNext', 'gallery.next', 1)),
    ),
  );
  document.body.append(dialog);

  function show(i) {
    const step = i - index;
    index = (i + items.length) % items.length;
    const item = items[index];
    img.src = item.dataset.large;
    img.alt = item.querySelector('img').alt;
    counter.textContent = t('gallery.count', { n: index + 1, total: items.length });
    // The next photo slides in from the side you're heading to.
    if (dialog.open && step && !reducedMotion() && img.animate) {
      const dx = step > 0 === isRtl() ? -36 : 36;
      const slide = () =>
        img.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      if (img.decode) img.decode().then(slide, slide);
      else slide();
    }
  }

  items.forEach((item, i) =>
    item.addEventListener('click', () => {
      show(i);
      dialog.showModal();
      // The photo grows out of the tile that was tapped.
      if (reducedMotion() || !img.animate) return;
      const from = item.getBoundingClientRect();
      const grow = () => {
        const to = img.getBoundingClientRect();
        if (!to.width || !dialog.open) return;
        const dx = from.left + from.width / 2 - (to.left + to.width / 2);
        const dy = from.top + from.height / 2 - (to.top + to.height / 2);
        img.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})`, opacity: 0.4 },
            { transform: 'none', opacity: 1 },
          ],
          { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      };
      if (img.decode) img.decode().then(grow, grow);
      else grow();
    }),
  );
  dialog.addEventListener('click', (e) => e.target === dialog && dialog.close());
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(index + (isRtl() ? 1 : -1));
    if (e.key === 'ArrowRight') show(index + (isRtl() ? -1 : 1));
  });
  let touchX = null;
  dialog.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
  dialog.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 40) show(index + ((dx > 0) === isRtl() ? 1 : -1));
  });
}

// ---------------------------------------------------------------------------
// Opening hours table
// ---------------------------------------------------------------------------

function renderHours() {
  const body = $('hours-body');
  if (!body || !config?.hours) return;
  const today = clinicNow(config.timezone).day;
  const range = (from, to) => el('span', {}, `${from}–${to}`);
  body.replaceChildren(
    ...[0, 1, 2, 3, 4, 5, 6].map((day) => {
      const ranges = config.hours[day] || [];
      return el(
        'tr',
        { class: day === today ? 'is-today' : null },
        el('th', { scope: 'row' }, dayName(day)),
        el(
          'td',
          { class: ranges.length ? null : 'is-closed' },
          ...(ranges.length
            ? ranges.flatMap(([from, to], i) => (i ? [', ', range(from, to)] : [range(from, to)]))
            : [t('visit.closed')]),
        ),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Contact form
// ---------------------------------------------------------------------------

const form = $('contact-form');
const status = $('contact-status');

function setStatus(kind, message) {
  status.replaceChildren(message ? el('p', { class: `alert alert-${kind}` }, message) : '');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  clearFieldErrors(form);
  setStatus();

  if (config?.handoff === 'whatsapp') {
    const missing = [];
    if (data.name.trim().length < 2) missing.push('name');
    if (data.message.trim().length < 2) missing.push('message');
    if (missing.length) return showFieldErrors(form, missing);
    const text = `${t('contact.waIntro', { name: data.name.trim() })}\n${data.message.trim()}`;
    const href = `https://wa.me/${config.business.whatsapp}?text=${encodeURIComponent(text)}`;
    window.open(href, '_blank', 'noopener');
    status.replaceChildren(
      el(
        'p',
        { class: 'alert alert-success' },
        `${t('contact.waSuccess')} `,
        el('a', { href, target: '_blank', rel: 'noopener' }, t('contact.waLink')),
      ),
    );
    return;
  }

  const bad = [];
  if (data.name.trim().length < 2) bad.push('name');
  if (!data.phone.trim() && !data.email.trim()) {
    bad.push('phone');
    setStatus('error', t('contact.needContact'));
  }
  if (data.message.trim().length < 2) bad.push('message');
  if (bad.length) return showFieldErrors(form, bad);

  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  button.textContent = t('contact.sending');
  try {
    await api('/api/contact', { method: 'POST', body: { ...data, lang: getLang() } });
    form.reset();
    setStatus('success', t('contact.success'));
  } catch (err) {
    if (err.status === 400) showFieldErrors(form, err.data.fields);
    else setStatus('error', t(err.status === 429 ? 'errors.rate' : 'common.error'));
  } finally {
    button.disabled = false;
    button.textContent = t(button.dataset.i18n);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// The treatments, right under the headline: a small photo and the name,
// each jumping to its card below.
function renderHeroTreatments() {
  const list = $('hero-treatments');
  if (!list || !config) return;
  list.replaceChildren(
    ...config.services.map((s, i) => {
      const item = el(
        'li',
        {},
        el(
          'a',
          { href: `#svc-${s.id}` },
          el('span', { class: 'ht-num', 'aria-hidden': 'true' }, `0${i + 1}`),
          s.image
            ? el('img', { srcset: `${sized(s.image, 300)} 300w, ${s.image} 700w`, sizes: '84px', src: sized(s.image, 300), alt: '', width: 76, height: 76 })
            : null,
          el('span', { class: 'ht-name' }, pick(s.name)),
          el('span', { class: 'ht-go flip-rtl', 'aria-hidden': 'true', html: svg('arrow') }),
        ),
      );
      item.style.setProperty('--i', String(i)); // staggers the entrance
      return item;
    }),
  );
}

// ---------------------------------------------------------------------------
// Effects that some design versions switch on with CSS
// ---------------------------------------------------------------------------

// The headline's letters each get their own span (with --ci, their position), so a
// version can bring them in one by one. Screen readers get the words via aria-label.
function splitHeadline() {
  const title = document.querySelector('.hero-title');
  if (!title) return;
  const words = [...title.querySelectorAll('.line > span')];
  const split = () => {
    let i = 0;
    for (const word of words) {
      if (word.firstElementChild?.classList.contains('ch')) {
        i += word.children.length;
        continue;
      }
      const letters = [...word.textContent].map((c) => {
        const span = el('span', { class: 'ch' }, c);
        span.style.setProperty('--ci', String(i++));
        return span;
      });
      if (letters.length) word.replaceChildren(...letters);
    }
    title.setAttribute('aria-label', words.map((w) => w.textContent).join(' '));
  };
  split();
  // The words are rewritten whenever the page text is applied again; split them again.
  new MutationObserver(split).observe(title, { childList: true, subtree: true, characterData: true });
}

// Phones: the bottom bar (book · WhatsApp · call) waits until the opening
// screen's own booking button has scrolled away, so the two never show at once.
function initActionBar() {
  const html = document.documentElement;
  const cta = document.querySelector('.hero-ctas .btn');
  if (!cta || !('IntersectionObserver' in window)) {
    html.classList.remove('bar-wait');
    return;
  }
  let answered = false;
  new IntersectionObserver(
    ([entry]) => {
      answered = true;
      html.classList.toggle('bar-wait', entry.isIntersecting && entry.intersectionRatio > 0.5);
    },
    { threshold: [0, 0.5, 1] },
  ).observe(cta);
  // Some embedded browsers never report visibility; never hide the bar for good there.
  setTimeout(() => answered || html.classList.remove('bar-wait'), 3000);
}

// Phones: a thin line under the swipeable gallery shows how far along you are.
function initStripProgress() {
  const mosaic = $('mosaic');
  const strip = document.querySelector('.strip-progress');
  if (!mosaic || !strip) return;
  const update = () => {
    const total = mosaic.scrollWidth;
    const p = total ? Math.min(1, (Math.abs(mosaic.scrollLeft) + mosaic.clientWidth) / total) : 1;
    strip.style.setProperty('--p', p.toFixed(3));
  };
  mosaic.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
}

// The treatment video beside his quote: silent and looping, it plays only while
// on screen – never when motion is turned off or the phone is saving data – and
// a button pauses or plays it.
function initClinicVideo() {
  const box = document.querySelector('.statement-media');
  const video = box?.querySelector('video');
  const button = box?.querySelector('.video-toggle');
  if (!video || !button || !('IntersectionObserver' in window)) return;
  video.muted = true;
  let wanted = !reducedMotion() && !navigator.connection?.saveData;
  let onScreen = false;
  const render = () => {
    const playing = !video.paused;
    button.innerHTML = svg(playing ? 'pause' : 'play');
    button.setAttribute('aria-label', t(playing ? 'a11y.videoPause' : 'a11y.videoPlay'));
  };
  const sync = () => {
    if (wanted && onScreen) video.play().catch(render);
    else video.pause();
  };
  video.addEventListener('play', render);
  video.addEventListener('pause', render);
  button.addEventListener('click', () => {
    wanted = video.paused;
    sync();
  });
  new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    },
    { threshold: 0.2 },
  ).observe(box);
  // Turning on "stop animations" in the accessibility menu stops the video too.
  new MutationObserver(() => {
    if (reducedMotion() && !video.paused) {
      wanted = false;
      video.pause();
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  onLangChange(render);
  button.hidden = false;
  render();
}

function renderAll() {
  renderHeroTreatments();
  renderServices();
  renderPrices();
  renderWords();
  renderHours();
}

// The versions built around the logo (data-look 2l…): the curtain's logo lands on the
// opening screen's, and as the page scrolls the name rises out of its oval into the header
// (and comes back down on the way up). Nothing moves when motion is turned off.
function initLogoMotion() {
  const root = document.documentElement;
  const header = document.querySelector('.site-header');
  const heroLogo = document.querySelector('.hero .hero-logo');
  const brandLogo = header?.querySelector('.brand-logo');
  const word = heroLogo?.querySelector('.logo-word');
  if (!heroLogo || !brandLogo || !word) return;
  const logoLook = () => (root.dataset.look || '').startsWith('2l');
  const intro = document.querySelector('.intro');
  const introLogo = intro?.querySelector('.intro-logo');
  let introBusy = false;

  // ---- The curtain's logo lands on the opening screen ----
  if (introLogo && logoLook() && !reducedMotion() && getComputedStyle(intro).display !== 'none') {
    introBusy = true;
    const stop = new AbortController();
    const land = (quick) => {
      if (!introBusy) return;
      introBusy = false;
      stop.abort();
      for (const a of introLogo.getAnimations({ subtree: true })) a.finish();
      const from = introLogo.getBoundingClientRect();
      const to = heroLogo.getBoundingClientRect();
      const finish = () => {
        root.classList.toggle('logo-landed', true);
        intro.style.visibility = 'hidden';
        request();
      };
      if (!introLogo.animate) {
        finish();
        return;
      }
      const ms = quick ? 450 : 950;
      // no place to land on screen (the booking page, or opened further down): just fade out
      if (!from.width || !to.width || to.bottom < 0 || to.top > window.innerHeight) {
        intro.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.6, easing: 'ease-out', fill: 'forwards' }).finished.then(finish, finish);
        return;
      }
      const k = to.width / from.width;
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      introLogo.animate([{ transform: 'none' }, { transform: `translate(${dx}px, ${dy}px) scale(${k})` }], {
        duration: ms,
        easing: 'cubic-bezier(0.65, 0, 0.25, 1)',
        fill: 'forwards',
      });
      intro
        .animate([{ backgroundColor: getComputedStyle(intro).backgroundColor }, { backgroundColor: 'transparent' }], {
          duration: ms * 0.8,
          delay: ms * 0.2,
          easing: 'ease-in-out',
          fill: 'forwards',
        })
        .finished.then(finish, finish);
    };
    // once the logo has drawn itself (or straight away if the visitor scrolls, taps or types)
    Promise.all(introLogo.getAnimations({ subtree: true }).map((a) => a.finished)).then(
      () => land(false),
      () => {},
    );
    setTimeout(() => land(false), 2600);
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      window.addEventListener(type, () => land(true), { passive: true, signal: stop.signal });
    }
  }

  // ---- The name rises into the header ----
  const NS = 'http://www.w3.org/2000/svg';
  const dock = document.createElementNS(NS, 'svg');
  dock.setAttribute('class', 'logo-dock');
  dock.setAttribute('viewBox', '0 0 610 111');
  dock.setAttribute('aria-hidden', 'true');
  dock.setAttribute('focusable', 'false');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', brandLogo.querySelector('use')?.getAttribute('href') || 'images/logo-wordmark.svg#word');
  dock.append(use);
  document.body.append(dock);

  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  let queued = false;
  // (classList.toggle with a second argument changes nothing when the class is already right,
  // so the observer below isn't woken by these updates)
  function update() {
    queued = false;
    const active =
      logoLook() && !reducedMotion() && heroLogo.getClientRects().length > 0 && brandLogo.getClientRects().length > 0;
    root.classList.toggle('dock-on', active);
    if (!active) {
      root.classList.toggle('dock-done', false);
      heroLogo.classList.toggle('is-docking', false);
      heroLogo.style.removeProperty('--dock');
      dock.classList.toggle('is-flying', false);
      return;
    }
    const y = window.scrollY;
    const r = heroLogo.getBoundingClientRect();
    const u = r.width / 852;
    const tf = getComputedStyle(word).transform;
    const shift = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0; // the name sits lower when the small lines are left out
    const from = { left: r.left + 121 * u, top: r.top + (56 + shift) * u, width: 610 * u };
    from.height = (from.width * 111) / 610;
    // where the header's logo sits when the header is showing
    const hr = header.getBoundingClientRect();
    const br = brandLogo.getBoundingClientRect();
    const to = { left: br.left, top: (parseFloat(getComputedStyle(header).top) || 0) + (br.top - hr.top), width: br.width };
    to.height = br.height;
    const span = Math.max(48, from.top + y + from.height / 2 - (to.top + to.height / 2));
    const t = introBusy ? 0 : clamp01(y / span);
    heroLogo.style.setProperty('--dock', t.toFixed(3));
    if (t > 0) root.classList.toggle('logo-landed', true); // finish the drawing at once
    heroLogo.classList.toggle('is-docking', t > 0);
    root.classList.toggle('dock-done', t >= 1);
    const flying = t > 0 && t < 1;
    dock.classList.toggle('is-flying', flying);
    if (flying) {
      const e = ease(t);
      const left = from.left + (to.left - from.left) * e;
      const top = from.top + (to.top - from.top) * e;
      const width = from.width + (to.width - from.width) * e;
      dock.style.width = `${from.width}px`;
      dock.style.transform = `translate(${left.toFixed(2)}px, ${top.toFixed(2)}px) scale(${(width / from.width).toFixed(4)})`;
    }
  }
  function request() {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  }
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('resize', request);
  window.addEventListener('hashchange', request);
  window.addEventListener('load', request);
  document.fonts?.ready.then(request);
  // a version picked in the switcher, or motion turned off in the accessibility menu
  new MutationObserver(request).observe(root, { attributes: true, attributeFilter: ['data-look', 'class'] });
  request();
}

// The intro curtain is a one-off: once the hero has settled, take it out so
// it doesn't replay when the page is shown again.
const intro = document.querySelector('.intro');
const heroCtas = document.querySelector('.hero-ctas');
if (intro && heroCtas) {
  const settle = () => {
    intro.remove();
    document.documentElement.classList.add('no-intro');
  };
  if (getComputedStyle(intro).display === 'none') settle();
  else heroCtas.addEventListener('animationend', (e) => e.target === heroCtas && settle());
}

// Lazy photos load as you scroll; shortly after the page is ready, fetch any
// that are still waiting so none can stay empty (some in-app browsers stall).
window.addEventListener('load', () => {
  setTimeout(() => {
    for (const img of document.querySelectorAll('img[loading="lazy"]')) {
      if (img.getClientRects().length) img.loading = 'eager';
    }
  }, 2500);
});

const galleryItems = [...document.querySelectorAll('.mosaic-item')];
if (galleryItems.length) initLightbox(galleryItems);
renderWords();
initScrollFx();
initActionBar();
initStripProgress();
initClinicVideo();
splitHeadline();
initLogoMotion();

loadConfig()
  .then((cfg) => {
    config = cfg;
    renderAll();
    if (cfg.handoff === 'whatsapp') {
      // No server: messages go straight to WhatsApp, so phone/email fields aren't needed.
      form.elements.phone.closest('.form-row').hidden = true;
      const button = form.querySelector('[type="submit"]');
      button.dataset.i18n = 'contact.sendWhatsapp';
      button.textContent = t('contact.sendWhatsapp');
    }
  })
  .catch(() => {
    $('services-list').replaceChildren(el('li', { class: 'alert alert-error' }, t('common.error')));
  });

onLangChange(renderAll);
setInterval(renderHours, 60_000);

// ---------------------------------------------------------------------------
// Choosing the opening photo: open the site with ?photo (or ?photo=1, 2 or 3) to compare
// David's photos in the arch. Only with that link; the normal site keeps its photo until
// one is chosen.
// ---------------------------------------------------------------------------

const PHOTOS = [
  ['room', 'עכשיו'],
  ['david-1', '1'],
  ['david-2', '2'],
  ['david-3', '3'],
];

function initPhotoChooser() {
  const asked = /[?&]photo(?:=(\d))?(?:&|$)/.exec(location.search);
  const img = document.querySelector('.hero-room img');
  if (!asked || !img) return;
  const buttons = PHOTOS.map(([id, label]) =>
    el('button', { type: 'button', 'data-photo': id }, el('img', { src: `images/${id}-640.jpg`, alt: '' }), el('span', {}, label)),
  );
  const show = (id, scroll) => {
    img.srcset = `images/${id}-640.jpg 640w, images/${id}.jpg 960w, images/${id}-1440.jpg 1440w`;
    img.src = `images/${id}.jpg`;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.photo === id));
    // On phones the arch is below the opening buttons: bring it into view.
    if (scroll) img.closest('.hero-room').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const bar = el('div', { class: 'photo-chooser', role: 'group', 'aria-label': 'בחירת תמונה' }, ...buttons);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) show(b.dataset.photo, true);
  });
  document.body.append(bar);
  show((PHOTOS[Number(asked[1])] || PHOTOS[1])[0], false);
}

initPhotoChooser();
