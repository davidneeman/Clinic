// Picking dates and times in the admin panel, made for a phone: a calendar in the panel's
// language (weeks from Sunday, as in Israel, like the booking page's) instead of the browser's
// own date field, a run of days in two taps, and times as a list of 24-hour times (a phone
// shows its own wheel for it). Plus drafts: what's typed and not saved yet is kept on the
// device, so a closed page or a sign-in that ran out loses nothing.

import { el, locale, t } from './site.js';
import { svg } from './icons.js';

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const parse = (date) => new Date(`${date}T00:00:00Z`);
const monthOf = (date) => date.slice(0, 7);
function shiftMonth(month, n) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

export const shiftDays = (date, n) => new Date(parse(date).getTime() + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((parse(to) - parse(from)) / DAY);
/** Today ("YYYY-MM-DD") in the clinic's time zone. */
export const todayIn = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** "יום ראשון, 15 בנובמבר" – with the year when it isn't this year. */
export function formatDate(date, { weekday = 'long', month = 'long' } = {}) {
  if (!date) return '';
  const d = parse(date);
  const year = d.getUTCFullYear() !== new Date().getUTCFullYear() ? 'numeric' : undefined;
  return new Intl.DateTimeFormat(locale(), { weekday, day: 'numeric', month, year, timeZone: 'UTC' }).format(d);
}

/** "יום אחד", "יומיים", "4 ימים". */
export const daysText = (n) => (n === 1 ? t('admin.oneDay') : n === 2 ? t('admin.twoDays') : t('admin.nDays', { n }));

/** A run of days in words: the first and last day ("יום ה׳, 12 בנוב׳") and how many days ("4 ימים"). */
export function rangeParts(from, to) {
  if (!from) return { days: [], dates: '', count: '' };
  const short = (d) => formatDate(d, { weekday: 'short', month: 'short' });
  const one = !to || to === from;
  const days = one ? [short(from)] : [short(from), short(to)];
  return { days, dates: days.join(' – '), count: daysText(one ? 1 : daysBetween(from, to) + 1) };
}

/** "יום ה׳, 12 בנוב׳ – יום א׳, 15 בנוב׳ · 4 ימים", or one day. */
export function formatRange(from, to) {
  const { dates, count } = rangeParts(from, to);
  return dates && `${dates} · ${count}`;
}

/** The first and last day on the page: a date is never split over two lines. */
export const rangeDates = (from, to) => rangeParts(from, to).days.flatMap((d, i) => [i ? '\u00a0– ' : null, el('span', { class: 'nowrap' }, d)]);

/** …and the number of days under them. */
const rangeNodes = (from, to) => [el('span', { class: 'range-dates' }, rangeDates(from, to)), el('span', { class: 'range-count' }, rangeParts(from, to).count)];

let pickerCount = 0;

/**
 * Opens a calendar. With `range`, two taps choose the first and last day (the same day twice
 * for one day) and resolves to { from, to }; otherwise one tap resolves to the date. Resolves
 * to null when it's closed without choosing.
 */
export function pickDate({ title, value = '', from = '', to = '', range = false, min = '', max = '', today = '', quick = [] }) {
  return new Promise((resolve) => {
    const uid = ++pickerCount;
    let start = range ? from : '';
    let end = range ? to : '';
    let month = monthOf(value || from || (min && min > today ? min : today) || new Date().toISOString().slice(0, 10));
    const label = el('h3', { id: `pick-month-${uid}`, 'aria-live': 'polite' });
    const grid = el('div', { class: 'calendar-grid picker-grid', role: 'group', 'aria-labelledby': `pick-month-${uid}` });
    const prev = el('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('a11y.prevMonth'),
      html: `<span class="flip-rtl">${svg('chevronPrev')}</span>`,
      onclick: () => {
        month = shiftMonth(month, -1);
        draw();
      },
    });
    const next = el('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': t('a11y.nextMonth'),
      html: `<span class="flip-rtl">${svg('chevronNext')}</span>`,
      onclick: () => {
        month = shiftMonth(month, 1);
        draw();
      },
    });
    const status = el('p', { class: 'picker-status', role: 'status' });
    const oneDay = el('button', { type: 'button', class: 'linklike', hidden: true }, t('admin.pickOneDay'));
    const ok = el('button', { type: 'button', class: 'btn btn-primary' }, t('admin.pickOk'));
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost' }, t('admin.cancelAction'));
    const dialog = el(
      'dialog',
      { class: 'dialog picker-dialog', 'aria-labelledby': `pick-title-${uid}` },
      el(
        'div',
        { class: 'dialog-inner' },
        el('h2', { id: `pick-title-${uid}` }, title),
        quick.length
          ? el(
              'div',
              { class: 'picker-quick' },
              quick.map((q) => el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => tap(q.date, true) }, q.label)),
            )
          : '',
        el('div', { class: 'calendar-head' }, prev, label, next),
        grid,
        range ? el('div', { class: 'picker-range-note' }, status, oneDay) : '',
        el('div', { class: 'panel-actions' }, range ? ok : '', cancel),
      ),
    );

    function draw() {
      const first = parse(`${month}-01`);
      label.textContent = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
      prev.disabled = Boolean(min) && month <= monthOf(min);
      next.disabled = Boolean(max) && month >= monthOf(max);
      const dow = new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' });
      const cells = [];
      for (let i = 0; i < 7; i++) cells.push(el('span', { class: 'dow', 'aria-hidden': 'true' }, dow.format(new Date(Date.UTC(2023, 0, 1 + i)))));
      for (let i = 0; i < first.getUTCDay(); i++) cells.push(el('span'));
      const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      for (let d = 1; d <= count; d++) {
        const date = `${month}-${pad(d)}`;
        const off = Boolean((min && date < min) || (max && date > max));
        const edge = range ? date === start || date === end : date === value;
        const between = range && start && end && date > start && date < end;
        cells.push(
          el(
            'button',
            {
              type: 'button',
              class: ['day', !off && 'is-available', date === today && 'is-today', between && 'in-range'].filter(Boolean).join(' '),
              disabled: off,
              'aria-pressed': String(Boolean(edge || between)),
              'aria-label': formatDate(date),
              'data-date': date,
              onclick: () => tap(date),
            },
            String(d),
          ),
        );
      }
      // (the days are drawn again: the one that had the keys keeps them, for keyboard and screen reader)
      const focused = grid.contains(document.activeElement) ? document.activeElement.dataset.date : null;
      grid.replaceChildren(...cells);
      if (focused) grid.querySelector(`.day[data-date="${focused}"]`)?.focus({ preventScroll: true });
      if (range) {
        if (start && end) status.replaceChildren(...rangeNodes(start, end));
        else status.textContent = !start ? t('admin.pickFirst') : t('admin.pickLast', { date: formatDate(start, { weekday: 'short', month: 'short' }) });
        oneDay.hidden = !start || Boolean(end);
        ok.disabled = !(start && end);
      }
    }

    function tap(date, quickPick = false) {
      if (!range) return finish(date);
      if (quickPick || !start || end || date < start) {
        start = date;
        end = '';
      } else end = date;
      month = monthOf(date);
      draw();
    }

    function finish(result) {
      dialog.close();
      dialog.remove();
      resolve(result);
    }
    oneDay.addEventListener('click', () => {
      end = start;
      draw();
    });
    ok.addEventListener('click', () => finish({ from: start, to: end }));
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dialog.addEventListener('click', (e) => e.target === dialog && finish(null));
    document.body.append(dialog);
    draw();
    dialog.showModal();
    (grid.querySelector('.day[aria-pressed="true"]') || grid.querySelector('.day:not([disabled])'))?.focus({ preventScroll: true });
  });
}

/** A calendar icon and the value in words; a screen reader reads the value after the field's label. */
function pickerButton(id) {
  const valueId = id ? `${id}-value` : null;
  const text = el('span', { class: 'picker-value', id: valueId });
  const button = el('button', { type: 'button', id, class: 'picker-field', 'aria-haspopup': 'dialog', 'aria-describedby': valueId, html: svg('calendar') }, text);
  return { text, button };
}

/**
 * A field that shows a date in words and opens the calendar. `get min()` may change while the
 * form is open. Returns { element, value } (value: "YYYY-MM-DD" or '').
 */
export function dateField({ id, value = '', placeholder, title, min = '', max = '', today = '', quick = [], onChange }) {
  let current = value;
  const { text, button } = pickerButton(id);
  const draw = () => {
    // "יום שלישי, 10 בנובמבר": on a narrow screen it may go over two lines, but not between 10 and נובמבר.
    const words = current ? formatDate(current) : placeholder;
    const cut = current ? words.indexOf(', ') : -1;
    text.replaceChildren(...(cut > 0 ? [words.slice(0, cut + 2), el('span', { class: 'nowrap' }, words.slice(cut + 2))] : [words]));
    button.classList.toggle('is-empty', !current);
  };
  button.addEventListener('click', async () => {
    const picked = await pickDate({ title, value: current, min: typeof min === 'function' ? min() : min, max, today, quick });
    if (!picked) return;
    current = picked;
    draw();
    onChange?.(current);
  });
  draw();
  return {
    element: button,
    get value() {
      return current;
    },
    set value(v) {
      current = v || '';
      draw();
    },
  };
}

/** A field that shows a run of days and opens the calendar to choose the first and last. */
export function rangeField({ id, from = '', to = '', placeholder, title, min = '', max = '', today = '', onChange }) {
  let range = { from, to };
  const { text, button } = pickerButton(id);
  const draw = () => {
    if (range.from) text.replaceChildren(...rangeNodes(range.from, range.to));
    else text.textContent = placeholder;
    button.classList.toggle('is-empty', !range.from);
  };
  button.addEventListener('click', async () => {
    const picked = await pickDate({ title, range: true, from: range.from, to: range.to, min, max, today });
    if (!picked) return;
    range = picked;
    draw();
    onChange?.(range);
  });
  draw();
  return {
    element: button,
    get value() {
      return { ...range };
    },
    set value(v) {
      range = { from: v?.from || '', to: v?.to || '' };
      draw();
    },
  };
}

/**
 * 24-hour times every `step` minutes as a list (the value it has is always in it, so nothing
 * is lost). `labels` adds words to some times, e.g. { '23:59': 'end of the day' }.
 */
export function timeSelect({ id, value, step = 15, extra = [], labels = {}, name, label }) {
  const times = new Set();
  for (let m = 0; m < 24 * 60; m += step) times.add(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  for (const x of [value, ...extra, ...Object.keys(labels)]) if (x) times.add(x);
  return el(
    'select',
    { id, name, class: 'time-select', 'aria-label': label },
    [...times].sort().map((v) => el('option', { value: v, selected: v === value }, labels[v] ? `${v} · ${labels[v]}` : v)),
  );
}

/** A list of choices ([value, text]); the value it has is kept even when it isn't one of them. */
export function choiceSelect({ id, name, value, choices, other }) {
  const list = choices.some(([v]) => String(v) === String(value)) ? choices : [...choices, [value, other(value)]].sort((a, b) => a[0] - b[0]);
  return el(
    'select',
    { id, name },
    list.map(([v, text]) => el('option', { value: String(v), selected: String(v) === String(value) }, text)),
  );
}

// ---------------------------------------------------------------------------
// Drafts: kept on this device until they're saved (or he starts over)
// ---------------------------------------------------------------------------

const DRAFT = 'admin-draft:';
const DRAFT_DAYS = 30;

export function saveDraft(name, data) {
  try {
    localStorage.setItem(DRAFT + name, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* private mode – nothing to keep it in */
  }
}

export function loadDraft(name) {
  try {
    const kept = JSON.parse(localStorage.getItem(DRAFT + name) || 'null');
    if (!kept || Date.now() - kept.at > DRAFT_DAYS * DAY) return null;
    return kept;
  } catch {
    return null;
  }
}

export function clearDraft(name) {
  try {
    localStorage.removeItem(DRAFT + name);
  } catch {
    /* nothing kept */
  }
}

/** All drafts (signing out takes them off the device). */
export function draftNames() {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(DRAFT))
      .map((k) => k.slice(DRAFT.length));
  } catch {
    return [];
  }
}

/** "שעה 14:05" / "אתמול" style: when a draft was kept. */
export function draftWhen(at) {
  return new Intl.DateTimeFormat(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}
