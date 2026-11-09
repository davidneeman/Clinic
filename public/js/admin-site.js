// The admin panel's "האתר" tab, made for a phone:
//   - notices at the top of the site ("the clinic is closed until …"), shown from/until a
//     time, and able to close the booking calendar on chosen days while they're on
//   - the site's texts (the quote too), treatments, prices and photos, as they come with the
//     site until David changes them (public/js/site-content.js says what can be changed).
//     Photos are framed on the phone (drag, pinch or the slider) and uploaded in the sizes the
//     site uses, as new JPEGs: what the phone put in the file (its location, the camera)
//     doesn't go with them.

import { api, el, locale, pick, pristineHebrew, t, toast } from './site.js';
import { svg } from './icons.js';
import { clearDraft, dateField, draftWhen, loadDraft, rangeField, saveDraft, shiftDays, timeSelect, todayIn } from './admin-pickers.js';
import {
  BUILTIN_PHOTOS,
  CONTENT_SECTIONS,
  DEFAULT_ABOUT_ALT,
  DEFAULT_GALLERY,
  DEFAULT_PHOTOS,
  GALLERY_LIMITS,
  PHOTO_SLOTS,
  PRICE_LIMITS,
  SERVICE_LIMITS,
  photoSource,
  serviceDefaultPhoto,
} from './site-content.js';

const $ = (id) => document.getElementById(id);
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const count = (s) => [...String(s ?? '')].length;
// The window in the arch, as on the home page (index.html), over the opening photo.
const FANLIGHT =
  '<svg class="fanlight" viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path pathLength="1" d="M100 100H0"/><path pathLength="1" d="M100 100H200"/><path pathLength="1" d="M124 100A24 24 0 0 0 76 100"/><path pathLength="1" d="M122.17 90.82L192.39 61.73"/><path pathLength="1" d="M116.97 83.03L170.71 29.29"/><path pathLength="1" d="M109.18 77.83L138.27 7.61"/><path pathLength="1" d="M100 76L100 0"/><path pathLength="1" d="M90.82 77.83L61.73 7.61"/><path pathLength="1" d="M83.03 83.03L29.29 29.29"/><path pathLength="1" d="M77.83 90.82L7.61 61.73"/></svg>';

/** "YYYY-MM-DDTHH:MM" in the clinic's time zone, for a moment (ISO). */
function localInput(iso, timeZone) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** A text box as tall as its text (up to most of the screen), so all of it shows on a phone. */
function grow(box) {
  if (!box.getClientRects().length) return;
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight + 2, Math.max(160, window.innerHeight * 0.6))}px`;
}


/** The parts of the editor that were open last time. */
function readOpen() {
  try {
    const list = JSON.parse(localStorage.getItem('admin-open') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function keepOpen(set) {
  try {
    localStorage.setItem('admin-open', JSON.stringify([...set]));
  } catch {
    /* private mode */
  }
}

/**
 * The content with his unsaved changes on top (a draft is kept as the changes only, so what
 * someone else saved meanwhile in other parts stays).
 */
function withChanges(base, p) {
  const next = structuredClone(base || {});
  for (const [k, v] of Object.entries(p?.texts || {})) {
    if (v === null) delete next.texts?.[k];
    else (next.texts ??= {})[k] = v;
  }
  for (const [id, change] of Object.entries(p?.services || {})) {
    const mine = { ...(next.services?.[id] || {}) };
    for (const [k, v] of Object.entries(change || {})) {
      if (v === null) delete mine[k];
      else mine[k] = v;
    }
    if (Object.keys(mine).length) (next.services ??= {})[id] = mine;
    else delete next.services?.[id];
  }
  for (const [slot, ref] of Object.entries(p?.photos || {})) {
    if (ref === null) delete next.photos?.[slot];
    else (next.photos ??= {})[slot] = ref;
  }
  for (const key of ['aboutAlt', 'gallery', 'prices']) {
    if (!(key in (p || {}))) continue;
    if (p[key] === null) delete next[key];
    else next[key] = p[key];
  }
  return next;
}

/** A random id for an uploaded photo (16 letters and digits, as the server expects). */
function uploadId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567';
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => abc[b & 31]).join('');
}

export function createSiteTab({ getConfig, onUnauthorized, onClosedDaysChanged }) {
  const s = {
    loaded: false,
    media: false,
    saved: {},
    work: {},
    defaults: null,
    notices: [],
    editing: null, // the notice being edited (or {} for a new one)
    previews: new Map(), // upload id → a local preview (blob: URL) of the photo just uploaded
    open: new Set(readOpen()), // the parts of the editor that are open (remembered on this device)
    errors: new Set(), // fields the server refused
    saving: false,
  };
  const tz = () => getConfig()?.timezone || 'Asia/Jerusalem';

  async function guarded(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      throw err;
    }
  }

  async function load() {
    // The notices load on their own: if they can't, the rest of the editor still works.
    const [content, notices] = await Promise.all([
      guarded(() => api('/api/admin/content')),
      guarded(() => api('/api/admin/notices')).catch(() => null),
    ]);
    s.saved = content.content || {};
    s.work = structuredClone(s.saved);
    // Changes made here and not saved yet (the page was closed, or the sign-in ran out) come back.
    const draft = loadDraft('site');
    s.restoredAt = null;
    if (draft) {
      s.work = withChanges(s.saved, draft.data);
      tidy();
      if (dirty()) s.restoredAt = draft.at;
      else clearDraft('site');
    }
    s.defaults = content.defaults;
    s.media = Boolean(content.media);
    s.notices = notices?.notices || [];
    s.noticesFailed = !notices;
    s.loaded = true;
    render();
  }

  /** `again`: after a language switch an open notice form is made again too (what's typed comes back from its draft). */
  function render({ again = false } = {}) {
    if (!s.loaded) return;
    if (again) $('notice-editor').dataset.for = '';
    renderNotices();
    renderEditor();
    renderSaveBar();
  }

  // -------------------------------------------------------------------------
  // Notices
  // -------------------------------------------------------------------------

  const fmtWhen = (iso) =>
    new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz() }).format(
      new Date(iso),
    );
  const fmtDay = (date) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

  function noticeStatus(n) {
    const now = new Date().toISOString();
    if (!n.active) return { key: 'paused', text: t('admin.noticePaused') };
    if (n.starts_at && n.starts_at > now) return { key: 'later', text: t('admin.noticeScheduled', { date: fmtWhen(n.starts_at) }) };
    if (n.ends_at && n.ends_at <= now) return { key: 'ended', text: t('admin.noticeEnded', { date: fmtWhen(n.ends_at) }) };
    return { key: 'live', text: n.ends_at ? t('admin.noticeShowingUntil', { date: fmtWhen(n.ends_at) }) : t('admin.noticeShowing') };
  }

  /** The notice as the site shows it (the same look), for the list and the preview. */
  function noticePreview(kind, text) {
    const icon = { info: 'info', news: 'sparkle', alert: 'alert' }[kind] || 'info';
    return el(
      'div',
      { class: `notice notice-${kind} notice-preview` },
      el('span', { class: 'notice-icon', 'aria-hidden': 'true', html: svg(icon) }),
      el('p', { class: 'notice-text' }, kind === 'news' ? el('strong', { class: 'notice-tag' }, t('notice.new')) : '', text || t('admin.noticeEmpty')),
    );
  }

  function renderNotices() {
    const list = $('notices-list');
    $('notice-add').hidden = Boolean(s.editing) || s.noticesFailed;
    if (s.noticesFailed) {
      list.replaceChildren(el('p', { class: 'alert alert-error' }, t('admin.noticesUnavailable')));
      return;
    }
    if (!s.notices.length) {
      list.replaceChildren(el('p', { class: 'empty-state' }, t('admin.noticeNone')));
    } else {
      list.replaceChildren(
        ...s.notices.map((n) => {
          const status = noticeStatus(n);
          return el(
            'article',
            { class: `item item-plain notice-item is-${status.key}` },
            el(
              'div',
              { class: 'item-body' },
              noticePreview(n.kind, n.text),
              el('p', { class: 'notice-status' }, el('span', { class: `chip notice-chip-${status.key}` }, status.text)),
              n.close_from ? el('p', { class: 'notice-closing' }, t('admin.noticeClosing', { from: fmtDay(n.close_from), to: fmtDay(n.close_to) })) : '',
            ),
            el(
              'div',
              { class: 'item-actions' },
              el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => editNotice(n) }, t('admin.edit')),
              el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => toggleNotice(n) }, t(n.active ? 'admin.noticePause' : 'admin.noticeResume')),
              el('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => deleteNotice(n) }, t('admin.delete')),
            ),
          );
        }),
      );
    }
    renderNoticeEditor();
  }

  function editNotice(n) {
    s.editing = n || {};
    renderNotices();
    $('notice-editor').querySelector('textarea')?.focus();
    $('notice-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** The form's fields as the server takes them. */
  const noticeBody = (n, overrides = {}) => ({
    kind: n.kind,
    text: n.text,
    startsAt: localInput(n.starts_at, tz()),
    endsAt: localInput(n.ends_at, tz()),
    closeFrom: n.close_from || '',
    closeTo: n.close_to || '',
    active: Boolean(n.active),
    ...overrides,
  });

  async function toggleNotice(n) {
    try {
      await guarded(() => api(`/api/admin/notices/${n.id}`, { method: 'PUT', body: noticeBody(n, { active: !n.active }) }));
      toast(t(n.active ? 'admin.noticePausedToast' : 'admin.noticeOnToast'));
    } catch (err) {
      toast(t(err.status === 400 ? 'admin.noticeCantResume' : 'common.error'));
    }
    await reloadNotices();
  }

  async function deleteNotice(n) {
    if (!confirm(t('admin.noticeDeleteConfirm'))) return;
    try {
      await guarded(() => api(`/api/admin/notices/${n.id}`, { method: 'DELETE', body: {} }));
      toast(t('admin.noticeDeleted'));
    } catch {
      toast(t('common.error'));
    }
    if (s.editing?.id === n.id) s.editing = null;
    await reloadNotices();
  }

  async function reloadNotices() {
    try {
      s.notices = (await guarded(() => api('/api/admin/notices'))).notices;
      s.noticesFailed = false;
    } catch {
      /* the list stays as it was */
    }
    renderNotices();
    onClosedDaysChanged?.();
  }

  function renderNoticeEditor() {
    const box = $('notice-editor');
    if (!s.editing) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const key = `notice:${s.editing.id ?? 'new'}`;
    if (box.firstChild && box.dataset.for === key) return; // already open
    box.dataset.for = key;
    const n = s.editing;
    const today = todayIn(tz());
    const startAt = localInput(n.starts_at, tz());
    const endAt = localInput(n.ends_at, tz());
    // The form as the notice is saved – or, if something was typed and not saved, as it was left.
    const saved = {
      kind: n.kind || 'info',
      text: n.text || '',
      startMode: startAt ? 'at' : 'now',
      startDate: startAt.slice(0, 10) || today,
      startTime: startAt.slice(11) || '00:00',
      endMode: endAt ? 'at' : 'off',
      endDate: endAt.slice(0, 10) || shiftDays(today, 7),
      endTime: endAt.slice(11) || '23:59',
      closing: Boolean(n.close_from),
      closeFrom: n.close_from || '',
      closeTo: n.close_to || '',
    };
    const draft = loadDraft(key);
    const f = draft && !same({ ...saved, ...draft.data }, saved) ? { ...saved, ...draft.data } : saved;

    const form = el('form', { class: 'form panel notice-form', novalidate: true });
    const preview = el('div', { class: 'notice-preview-box' });
    const radio = (name, value, checked, label) =>
      el('label', { class: 'choice' }, el('input', { type: 'radio', name, value, checked }), el('span', {}, t(label)));
    const kindField = el(
      'fieldset',
      { class: 'kind-options' },
      el('legend', {}, t('admin.noticeKind')),
      ['info', 'news', 'alert'].map((k) =>
        el(
          'label',
          { class: 'kind-option' },
          el('input', { type: 'radio', name: 'kind', value: k, checked: f.kind === k }),
          el('span', { class: 'kind-icon', 'aria-hidden': 'true', html: svg({ info: 'info', news: 'sparkle', alert: 'alert' }[k]) }),
          el('span', { class: 'kind-text' }, el('strong', {}, t(`admin.kind_${k}`)), el('small', {}, t(`admin.kind_${k}_sub`))),
        ),
      ),
    );
    const text = el('textarea', { id: 'n-text', name: 'text', rows: 3, maxlength: 280, required: true }, f.text);
    const counter = el('span', { class: 'char-count', 'aria-live': 'polite' });

    // When it shows: from now or from a day and time; until it's turned off or until a day and time.
    const startDate = dateField({
      id: 'n-start-date',
      value: f.startDate,
      title: t('admin.pickStartTitle'),
      min: saved.startDate < today ? saved.startDate : today,
      today,
      quick: [
        { label: t('admin.today'), date: today },
        { label: t('admin.tomorrow'), date: shiftDays(today, 1) },
      ],
      onChange: sync,
    });
    const startTime = timeSelect({ id: 'n-start-time', value: f.startTime, labels: { '00:00': t('admin.dayStart') }, label: t('admin.startTime') });
    const endDate = dateField({
      id: 'n-end-date',
      value: f.endDate,
      title: t('admin.pickEndTitle'),
      min: () => (form.elements.startMode.value === 'at' ? startDate.value : today),
      today,
      quick: [
        { label: t('admin.tomorrow'), date: shiftDays(today, 1) },
        { label: t('admin.inAWeek'), date: shiftDays(today, 7) },
      ],
      onChange: sync,
    });
    const endTime = timeSelect({ id: 'n-end-time', value: f.endTime, labels: { '23:59': t('admin.dayEnd') }, label: t('admin.endTime') });
    const startAtBox = el('div', { class: 'when-at' }, startDate.element, startTime);
    const endAtBox = el('div', { class: 'when-at' }, endDate.element, endTime);
    const whenStart = el(
      'fieldset',
      { class: 'when-field' },
      el('legend', {}, t('admin.noticeStartLegend')),
      radio('startMode', 'now', f.startMode === 'now', 'admin.startNow'),
      radio('startMode', 'at', f.startMode === 'at', 'admin.startAt'),
      startAtBox,
    );
    const whenEnd = el(
      'fieldset',
      { class: 'when-field' },
      el('legend', {}, t('admin.noticeEndLegend')),
      radio('endMode', 'off', f.endMode === 'off', 'admin.endOff'),
      radio('endMode', 'at', f.endMode === 'at', 'admin.endAt'),
      endAtBox,
    );

    // Closing the booking calendar on some days, chosen as a run of days.
    const closing = el('input', { type: 'checkbox', name: 'closing', checked: f.closing });
    const closeDays = rangeField({
      id: 'n-close-days',
      from: f.closeFrom,
      to: f.closeTo,
      placeholder: t('admin.pickDays'),
      title: t('admin.pickCloseTitle'),
      min: saved.closeFrom && saved.closeFrom < today ? saved.closeFrom : today,
      today,
      onChange: sync,
    });
    const closeBox = el(
      'div',
      { class: 'close-days' },
      el('div', { class: 'field' }, el('label', { for: 'n-close-days' }, t('admin.noticeCloseDays')), closeDays.element),
      el('p', { class: 'field-hint' }, t('admin.noticeCloseHint')),
    );

    const restart = el('button', { type: 'button', class: 'linklike' }, t('admin.startOver'));
    const draftNote = el('p', { class: 'draft-note' }, `${t('admin.draftRestored', { when: draft ? draftWhen(draft.at) : '' })} · `, restart);
    draftNote.hidden = f === saved;
    restart.addEventListener('click', () => {
      clearDraft(key);
      box.dataset.for = '';
      renderNoticeEditor();
    });
    const alert = el('div', { role: 'status' });
    form.append(
      el('h3', { class: 'subhead' }, t(n.id ? 'admin.noticeEdit' : 'admin.noticeAdd')),
      draftNote,
      kindField,
      el('div', { class: 'field' }, el('label', { for: 'n-text' }, t('admin.noticeText')), text, counter),
      whenStart,
      whenEnd,
      el('label', { class: 'checkbox' }, closing, el('span', {}, t('admin.noticeClose'))),
      closeBox,
      el('h4', { class: 'minihead' }, t('admin.noticePreview')),
      preview,
      alert,
      el(
        'div',
        { class: 'panel-actions' },
        el('button', { type: 'submit', class: 'btn btn-primary' }, t('admin.save')),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost',
            onclick: () => {
              s.editing = null;
              renderNotices();
            },
          },
          t('admin.close'),
        ),
      ),
      el('p', { class: 'field-hint' }, t('admin.draftKept')),
    );

    /** What the form says now, in the same shape as `saved`. */
    const read = () => ({
      kind: form.elements.kind.value || 'info',
      text: text.value,
      startMode: form.elements.startMode.value,
      startDate: startDate.value,
      startTime: startTime.value,
      endMode: form.elements.endMode.value,
      endDate: endDate.value,
      endTime: endTime.value,
      closing: closing.checked,
      closeFrom: closeDays.value.from,
      closeTo: closeDays.value.to,
    });

    function sync() {
      const now = read();
      preview.replaceChildren(noticePreview(now.kind, now.text.trim()));
      counter.textContent = `${count(now.text)}/280`;
      startAtBox.hidden = now.startMode !== 'at';
      endAtBox.hidden = now.endMode !== 'at';
      closeBox.hidden = !now.closing;
      // Kept on this device until it's saved (or he starts over).
      if (same(now, saved)) clearDraft(key);
      else saveDraft(key, now);
    }
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    closing.addEventListener('change', () => {
      // A first guess: from when the notice starts (or today) for a week, or until it ends.
      if (closing.checked && !closeDays.value.from) {
        const now = read();
        const from = now.startMode === 'at' ? now.startDate : today;
        const to = now.endMode === 'at' && now.endDate >= from ? now.endDate : shiftDays(from, 6);
        closeDays.value = { from, to };
        sync();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      alert.replaceChildren();
      for (const x of form.querySelectorAll('.has-error')) x.classList.remove('has-error');
      const now = read();
      const body = {
        kind: now.kind,
        text: now.text,
        startsAt: now.startMode === 'at' ? `${now.startDate}T${now.startTime}` : '',
        endsAt: now.endMode === 'at' ? `${now.endDate}T${now.endTime}` : '',
        closeFrom: now.closing ? now.closeFrom : '',
        closeTo: now.closing ? now.closeTo : '',
        active: n.id ? Boolean(n.active) : true,
      };
      const problems = [];
      if (count(body.text.trim()) < 2) problems.push([text, 'admin.noticeTextNeeded']);
      if (body.startsAt && body.endsAt && body.endsAt <= body.startsAt) problems.push([endDate.element, 'admin.noticeEndInvalid']);
      else if (body.endsAt && body.endsAt <= localInput(new Date().toISOString(), tz()) && body.endsAt !== `${saved.endDate}T${saved.endTime}`) {
        problems.push([endDate.element, 'admin.noticeEndPast']);
      }
      if (now.closing && !(body.closeFrom && body.closeTo)) problems.push([closeDays.element, 'admin.noticeCloseInvalid']);
      const show = (list) => {
        for (const [field] of list) field?.closest('.field, .when-field, .close-days')?.classList.add('has-error');
        alert.replaceChildren(el('p', { class: 'alert alert-error' }, list.map(([, k]) => t(k)).join(' ')));
        list[0][0]?.focus();
      };
      if (problems.length) return show(problems);
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await guarded(() => api(n.id ? `/api/admin/notices/${n.id}` : '/api/admin/notices', { method: n.id ? 'PUT' : 'POST', body }));
        clearDraft(key);
        s.editing = null;
        toast(t('admin.noticeSaved'));
        await reloadNotices();
      } catch (err) {
        if (err.status === 400) {
          const fields = { text, startsAt: startDate.element, endsAt: endDate.element, closeFrom: closeDays.element, closeTo: closeDays.element };
          const keys = { text: 'admin.noticeTextNeeded', startsAt: 'admin.noticeWhenInvalid', endsAt: 'admin.noticeEndInvalid', closeFrom: 'admin.noticeCloseInvalid', closeTo: 'admin.noticeCloseInvalid' };
          show((err.data?.fields || ['kind']).map((x) => [fields[x], keys[x] || 'admin.invalid']));
        } else if (err.status !== 401) alert.replaceChildren(el('p', { class: 'alert alert-error' }, t('common.error')));
      } finally {
        button.disabled = false;
      }
    });
    box.replaceChildren(form);
    box.hidden = false;
    sync();
  }

  // -------------------------------------------------------------------------
  // The site's content
  // -------------------------------------------------------------------------

  const defaultsFor = (id) => s.defaults?.services?.find((x) => x.id === id) || {};
  const dirty = () => !same(s.work, s.saved);

  /** Shown while there are changes to save; leaving the page then asks first. */
  function renderSaveBar() {
    const on = dirty();
    $('save-bar').hidden = !on;
    document.body.classList.toggle('has-save-bar', on);
    const note = $('save-restored');
    note.hidden = !(on && s.restoredAt);
    if (on && s.restoredAt) note.textContent = t('admin.siteDraftRestored', { when: draftWhen(s.restoredAt) });
  }
  window.addEventListener('beforeunload', (e) => {
    if (s.loaded && dirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /** Keeps a value in the working copy, or takes it out when it's back to the original. */
  function setOwn(obj, key, value, original) {
    if (same(value, original) || value === undefined) delete obj[key];
    else obj[key] = value;
  }
  function tidy() {
    for (const key of ['texts', 'photos', 'services']) if (s.work[key] && !Object.keys(s.work[key]).length) delete s.work[key];
    for (const [id, svc] of Object.entries(s.work.services || {})) if (!Object.keys(svc).length) delete s.work.services[id];
    if (s.work.services && !Object.keys(s.work.services).length) delete s.work.services;
  }
  function changed() {
    tidy();
    // Kept on this device until it's saved, so closing the page loses nothing.
    if (dirty()) saveDraft('site', patch());
    else {
      clearDraft('site');
      s.restoredAt = null;
    }
    renderSaveBar();
  }

  function renderEditor() {
    const box = $('content-editor');
    // Keep the parts that are open, and where the page is scrolled to.
    for (const d of box.querySelectorAll('details[data-section]')) (d.open ? s.open.add(d.dataset.section) : s.open.delete(d.dataset.section));
    const y = window.scrollY;
    box.replaceChildren(
      ...CONTENT_SECTIONS.map((section) => {
        const changedHere = sectionChanged(section);
        const details = el(
          'details',
          { class: 'edit-section', 'data-section': section.id, open: s.open.has(section.id) },
          el(
            'summary',
            {},
            el('span', { class: 'edit-section-name' }, pick(section.label)),
            changedHere ? el('span', { class: 'chip chip-accent edit-changed' }, t('admin.changedHere')) : '',
            el('span', { class: 'edit-chevron', 'aria-hidden': 'true', html: svg('down') }),
          ),
          el('div', { class: 'edit-body' }, section.items.map((item) => renderItem(item))),
        );
        details.addEventListener('toggle', () => {
          if (details.open) {
            s.open.add(section.id);
            details.querySelectorAll('textarea[data-grow]').forEach(grow);
          } else s.open.delete(section.id);
          keepOpen(s.open);
        });
        return details;
      }),
    );
    // What the server refused last time (a text, a price, a photo of the gallery…)
    for (const f of s.errors) box.querySelector(`[data-field="${CSS.escape(f)}"]`)?.closest('.field, .photo-field')?.classList.add('has-error');
    box.querySelectorAll('details[open] textarea[data-grow]').forEach(grow);
    window.scrollTo({ top: y, behavior: 'instant' });
  }

  function sectionChanged(section) {
    const w = s.work;
    const v = s.saved;
    return section.items.some((item) => {
      if (item.text) return Boolean(v.texts?.[item.text] ?? w.texts?.[item.text]);
      if (item.photo) return Boolean(v.photos?.[item.photo] || w.photos?.[item.photo] || (item.photo === 'about' && (v.aboutAlt != null || w.aboutAlt != null)));
      if (item.services) return Boolean(v.services || w.services);
      if (item.prices) return Boolean(v.prices || w.prices);
      if (item.gallery) return Boolean(v.gallery || w.gallery);
      return false;
    });
  }

  function renderItem(item) {
    if (item.text) return textField(item);
    if (item.photo === 'hero') return heroPhotoField(item);
    if (item.photo === 'about') return aboutPhotoField(item);
    if (item.services) return servicesFields();
    if (item.prices) return pricesFields();
    if (item.gallery) return galleryFields();
    return '';
  }

  /** One text: the field, how long it may be, and the way back to the original. */
  function textInput({ id, label, value, original, max, multiline, optional, hides = optional, field, onValue }) {
    const input = multiline
      ? el('textarea', { id, rows: 3, maxlength: max, 'data-field': field, 'data-grow': '' }, value)
      : el('input', { id, value, maxlength: max, 'data-field': field, autocomplete: 'off' });
    const counter = el('span', { class: 'char-count' });
    const back = el('button', { type: 'button', class: 'linklike', hidden: true }, t('admin.toOriginal'));
    const note = el('small', { class: 'field-hint' });
    const error = el('span', { class: 'field-error', role: 'alert', hidden: true });
    const emptyNote = el('small', { class: 'field-hint' }, t('admin.emptyHides'));
    const wrap = el(
      'div',
      { class: 'field edit-field' },
      el('label', { for: id }, label, optional ? el('span', { class: 'optional' }, ` · ${t('admin.optional')}`) : ''),
      input,
      el('div', { class: 'field-foot' }, back, counter),
      note,
      hides ? emptyNote : '',
      error,
    );
    const refresh = () => {
      const v = input.value;
      counter.textContent = `${count(v)}/${max}`;
      emptyNote.hidden = Boolean(v.trim());
      const own = v !== original;
      back.hidden = !own;
      note.textContent = own && original ? t('admin.originally', { text: original.length > 140 ? `${original.slice(0, 140)}…` : original }) : '';
      note.hidden = !note.textContent;
      const empty = !v.trim() && !optional;
      const refused = s.errors.has(field);
      wrap.classList.toggle('has-error', empty || refused);
      error.hidden = !(empty || refused);
      error.textContent = empty ? t('admin.required') : refused ? t('admin.fieldRefused') : '';
      input.setAttribute('aria-invalid', String(empty || refused));
    };
    input.addEventListener('input', () => {
      s.errors.delete(field);
      onValue(input.value === original ? undefined : input.value);
      refresh();
      grow(input);
      changed();
    });
    back.addEventListener('click', () => {
      input.value = original;
      s.errors.delete(field);
      onValue(undefined);
      refresh();
      grow(input);
      changed();
      input.focus();
    });
    refresh();
    return wrap;
  }

  function textField(item) {
    const original = getPath(pristineHebrew, item.text) ?? '';
    return textInput({
      id: `f-${item.text.replace(/\./g, '-')}`,
      label: pick(item.label),
      value: s.work.texts?.[item.text] ?? original,
      original,
      max: item.max,
      multiline: item.multiline,
      optional: item.optional,
      field: `texts.${item.text}`,
      onValue: (v) => {
        s.work.texts ??= {};
        setOwn(s.work.texts, item.text, v, undefined);
      },
    });
  }

  // ---- Photos ----

  /** A photo's small preview: the photo just uploaded from here, or the site's copy. */
  function previewSrc(ref, slot) {
    if (ref?.upload && s.previews.has(ref.upload)) return s.previews.get(ref.upload);
    const p = photoSource(ref, slot);
    return p ? p.byWidth[Math.min(...Object.keys(p.byWidth).map(Number))] || p.src : '';
  }

  /** The photo in the shape it has on the site, and the buttons to change it. */
  function photoField({ slot, label, ref, original, onPick, builtins = [], frameClass = '' }) {
    const frame = el(
      'div',
      { class: `photo-frame photo-frame-${slot} ${frameClass}`.trim() },
      el('img', { src: previewSrc(ref, slot), alt: '', loading: 'lazy' }),
      slot === 'hero' ? el('span', { class: 'photo-fan', html: FANLIGHT }) : '',
    );
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
    file.addEventListener('change', async () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked) return;
      const uploaded = await cropAndUpload(picked, slot);
      if (uploaded) onPick(uploaded);
    });
    const own = !same(ref, original);
    return el(
      'div',
      { class: 'photo-field', 'data-field': `photo.${slot}` },
      el('p', { class: 'photo-label' }, label),
      el(
        'div',
        { class: 'photo-row' },
        frame,
        el(
          'div',
          { class: 'photo-actions' },
          s.media
            ? el(
                'button',
                { type: 'button', class: 'btn btn-outline btn-sm', html: svg('image'), onclick: () => file.click() },
                el('span', {}, t('admin.photoChange')),
              )
            : el('p', { class: 'field-hint' }, t('admin.mediaOff')),
          s.media ? el('small', { class: 'field-hint' }, t('admin.photoPickHint')) : '',
          own ? el('button', { type: 'button', class: 'linklike', onclick: () => onPick(null) }, t('admin.toOriginal')) : '',
          file,
        ),
      ),
      builtins.length > 1
        ? el(
            'div',
            { class: 'builtin-choice', role: 'group', 'aria-label': t('admin.photoBuiltin') },
            el('p', { class: 'field-hint' }, t('admin.photoBuiltin')),
            el(
              'div',
              { class: 'builtin-list' },
              builtins.map((id) =>
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'builtin-photo',
                    'aria-pressed': String(ref?.builtin === id || (!ref && original?.builtin === id)),
                    onclick: () => onPick({ builtin: id }),
                  },
                  el('img', { src: BUILTIN_PHOTOS[id].set[0][0], alt: '', loading: 'lazy' }),
                  el('span', {}, pick(BUILTIN_PHOTOS[id].label) || id),
                ),
              ),
            ),
          )
        : '',
    );
  }

  function setPhoto(slot, ref) {
    s.work.photos ??= {};
    setOwn(s.work.photos, slot, ref ?? undefined, DEFAULT_PHOTOS[slot]);
    changed();
    renderEditor();
  }

  function heroPhotoField(item) {
    return photoField({
      slot: 'hero',
      label: pick(item.label),
      ref: s.work.photos?.hero || DEFAULT_PHOTOS.hero,
      original: DEFAULT_PHOTOS.hero,
      builtins: PHOTO_SLOTS.hero.builtins,
      onPick: (ref) => setPhoto('hero', ref),
    });
  }

  function aboutPhotoField(item) {
    const altOriginal = DEFAULT_ABOUT_ALT;
    return el(
      'div',
      { class: 'photo-group' },
      photoField({
        slot: 'about',
        label: pick(item.label),
        ref: s.work.photos?.about || DEFAULT_PHOTOS.about,
        original: DEFAULT_PHOTOS.about,
        onPick: (ref) => setPhoto('about', ref),
      }),
      textInput({
        id: 'f-about-alt',
        label: t('admin.photoAlt'),
        value: s.work.aboutAlt ?? altOriginal,
        original: altOriginal,
        max: GALLERY_LIMITS.alt,
        optional: true,
        hides: false,
        field: 'aboutAlt',
        onValue: (v) => setOwn(s.work, 'aboutAlt', v, undefined),
      }),
      el('small', { class: 'field-hint' }, t('admin.photoAltHint')),
    );
  }

  // ---- Treatments and prices ----

  function servicesFields() {
    const services = getConfig()?.services || [];
    return el(
      'div',
      { class: 'service-edit-list' },
      (s.defaults?.services || []).map((d) => {
        const mine = s.work.services?.[d.id] || {};
        const set = (key, value, original) => {
          s.work.services ??= {};
          s.work.services[d.id] ??= {};
          setOwn(s.work.services[d.id], key, value, original);
        };
        const photoOriginal = serviceDefaultPhoto(d);
        const current = services.find((x) => x.id === d.id);
        return el(
          'fieldset',
          { class: 'service-edit' },
          el('legend', {}, mine.name ?? d.name ?? pick(current?.name)),
          textInput({
            id: `f-svc-${d.id}-name`,
            label: t('admin.serviceName'),
            value: mine.name ?? d.name,
            original: d.name,
            max: SERVICE_LIMITS.name,
            field: `services.${d.id}.name`,
            onValue: (v) => set('name', v, undefined),
          }),
          textInput({
            id: `f-svc-${d.id}-description`,
            label: t('admin.serviceDescription'),
            value: mine.description ?? d.description,
            original: d.description,
            max: SERVICE_LIMITS.description,
            multiline: true,
            field: `services.${d.id}.description`,
            onValue: (v) => set('description', v, undefined),
          }),
          photoField({
            slot: 'service',
            label: t('admin.servicePhoto'),
            ref: mine.photo || photoOriginal,
            original: photoOriginal,
            onPick: (ref) => {
              set('photo', ref ?? undefined, photoOriginal);
              changed();
              renderEditor();
            },
          }),
        );
      }),
    );
  }

  function pricesFields() {
    const d = s.defaults?.prices || {};
    const now = s.work.prices || d;
    const input = (key, label) => {
      const [min, max] = PRICE_LIMITS[key];
      const id = `f-price-${key}`;
      const field = el(
        'div',
        { class: 'field' },
        el('label', { for: id }, t(label)),
        el('input', {
          id,
          type: 'number',
          inputmode: 'numeric',
          min,
          max,
          step: 1,
          value: String(now[key] ?? ''),
          'data-field': `prices.${key}`,
          oninput: (e) => {
            const prices = { ...(s.work.prices || d), [key]: e.target.value === '' ? NaN : Number(e.target.value) };
            const ok = Number.isInteger(prices[key]) && prices[key] >= min && prices[key] <= max;
            field.classList.toggle('has-error', !ok);
            e.target.setAttribute('aria-invalid', String(!ok));
            s.errors.delete(`prices.${key}`);
            setOwn(s.work, 'prices', prices, d);
            changed();
          },
        }),
      );
      return field;
    };
    return el(
      'fieldset',
      { class: 'service-edit prices-edit' },
      el('legend', {}, t('admin.pricesTitle')),
      el('div', { class: 'form-row form-row-3' }, input('session', 'admin.priceSession'), input('packSessions', 'admin.pricePackSessions'), input('pack', 'admin.pricePack')),
      el('small', { class: 'field-hint' }, t('admin.pricesNote')),
      s.work.prices
        ? el(
            'button',
            {
              type: 'button',
              class: 'linklike',
              onclick: () => {
                delete s.work.prices;
                changed();
                renderEditor();
              },
            },
            t('admin.toOriginal'),
          )
        : '',
    );
  }

  // ---- The gallery ----

  function galleryFields() {
    const list = s.work.gallery || DEFAULT_GALLERY;
    const edit = (fn) => {
      const next = structuredClone(s.work.gallery || DEFAULT_GALLERY);
      fn(next);
      setOwn(s.work, 'gallery', next, DEFAULT_GALLERY);
      changed();
      renderEditor();
    };
    const addFile = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
    addFile.addEventListener('change', async () => {
      const picked = addFile.files?.[0];
      addFile.value = '';
      if (!picked) return;
      const ref = await cropAndUpload(picked, 'gallery');
      if (ref) edit((g) => g.push({ photo: ref, alt: '' }));
    });
    return el(
      'div',
      { class: 'gallery-edit' },
      el('p', { class: 'field-hint' }, t('admin.galleryHint', { n: GALLERY_LIMITS.photos })),
      el(
        'ol',
        { class: 'gallery-rows' },
        list.map((g, i) => {
          const replace = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
          replace.addEventListener('change', async () => {
            const picked = replace.files?.[0];
            replace.value = '';
            if (!picked) return;
            const ref = await cropAndUpload(picked, 'gallery');
            if (ref) edit((next) => (next[i].photo = ref));
          });
          const alt = el('input', {
            id: `f-gal-${i}`,
            value: g.alt || '',
            maxlength: GALLERY_LIMITS.alt,
            'data-field': `gallery.${i}`,
            autocomplete: 'off',
            oninput: (e) => {
              const next = structuredClone(s.work.gallery || DEFAULT_GALLERY);
              next[i].alt = e.target.value;
              setOwn(s.work, 'gallery', next, DEFAULT_GALLERY);
              changed();
            },
          });
          const label = t('admin.galleryPhoto', { n: i + 1 });
          return el(
            'li',
            { class: 'gallery-row', 'aria-label': label },
            el('img', { class: 'gallery-thumb', src: previewSrc(g.photo, 'gallery'), alt: '', loading: 'lazy' }),
            el('div', { class: 'field' }, el('label', { for: `f-gal-${i}` }, `${label} · ${t('admin.photoAlt')}`), alt),
            el(
              'div',
              { class: 'gallery-row-actions' },
              el('button', {
                type: 'button',
                class: 'icon-btn',
                'aria-label': `${t('admin.galleryUp')} (${label})`,
                title: t('admin.galleryUp'),
                disabled: i === 0,
                html: svg('up'),
                onclick: () => edit((next) => next.splice(i - 1, 0, ...next.splice(i, 1))),
              }),
              el('button', {
                type: 'button',
                class: 'icon-btn',
                'aria-label': `${t('admin.galleryDown')} (${label})`,
                title: t('admin.galleryDown'),
                disabled: i === list.length - 1,
                html: svg('down'),
                onclick: () => edit((next) => next.splice(i + 1, 0, ...next.splice(i, 1))),
              }),
              s.media
                ? el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => replace.click() }, t('admin.galleryReplace'))
                : '',
              el(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-danger btn-sm',
                  disabled: list.length <= 1,
                  onclick: () => confirm(t('admin.galleryRemoveConfirm')) && edit((next) => next.splice(i, 1)),
                },
                t('admin.galleryRemove'),
              ),
              replace,
            ),
          );
        }),
      ),
      el(
        'div',
        { class: 'toolbar' },
        s.media && list.length < GALLERY_LIMITS.photos
          ? el('button', { type: 'button', class: 'btn btn-outline btn-sm', html: svg('plus'), onclick: () => addFile.click() }, el('span', {}, t('admin.galleryAdd')))
          : '',
        s.work.gallery
          ? el(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost btn-sm',
                onclick: () => {
                  if (!confirm(t('admin.galleryResetConfirm'))) return;
                  delete s.work.gallery;
                  changed();
                  renderEditor();
                },
              },
              t('admin.galleryReset'),
            )
          : '',
        addFile,
      ),
    );
  }

  // ---- Saving ----

  /** Only what changed since the last save, so two people editing different parts don't clash. */
  function patch() {
    const out = {};
    const w = s.work;
    const v = s.saved;
    const texts = {};
    for (const key of new Set([...Object.keys(w.texts || {}), ...Object.keys(v.texts || {})])) {
      if (w.texts?.[key] !== v.texts?.[key]) texts[key] = w.texts?.[key] ?? null;
    }
    if (Object.keys(texts).length) out.texts = texts;
    const services = {};
    for (const id of new Set([...Object.keys(w.services || {}), ...Object.keys(v.services || {})])) {
      const a = w.services?.[id] || {};
      const b = v.services?.[id] || {};
      const change = {};
      for (const key of ['name', 'description', 'photo']) if (!same(a[key], b[key])) change[key] = a[key] ?? null;
      if (Object.keys(change).length) services[id] = change;
    }
    if (Object.keys(services).length) out.services = services;
    const photos = {};
    for (const slot of ['hero', 'about']) if (!same(w.photos?.[slot], v.photos?.[slot])) photos[slot] = w.photos?.[slot] ?? null;
    if (Object.keys(photos).length) out.photos = photos;
    if (w.aboutAlt !== v.aboutAlt) out.aboutAlt = w.aboutAlt ?? null;
    if (!same(w.gallery, v.gallery)) out.gallery = w.gallery ?? null;
    if (!same(w.prices, v.prices)) out.prices = w.prices ?? null;
    return out;
  }

  async function save() {
    if (s.saving) return;
    const alert = $('save-alert');
    alert.replaceChildren();
    // Don't send what can't be kept: empty texts that must have something, wrong prices.
    const invalid = $('content-editor').querySelector('.has-error');
    if (invalid) {
      alert.replaceChildren(el('p', { class: 'alert alert-error' }, t('admin.fixFields')));
      invalid.closest('details')?.setAttribute('open', '');
      invalid.querySelector('input, textarea')?.focus();
      return;
    }
    s.saving = true;
    $('content-save').disabled = true;
    try {
      const { content } = await guarded(() => api('/api/admin/content', { method: 'PUT', body: patch() }));
      s.saved = content;
      s.work = structuredClone(content);
      s.errors.clear();
      clearDraft('site');
      s.restoredAt = null;
      toast(t('admin.contentSaved'));
      render();
    } catch (err) {
      if (err.status === 400) {
        for (const f of err.data?.fields || []) s.errors.add(f.replace(/^photos\./, 'photo.'));
        renderEditor();
        const missing = (err.data?.fields || []).includes('photo_missing');
        alert.replaceChildren(el('p', { class: 'alert alert-error' }, t(missing ? 'admin.photoMissing' : 'admin.fixFields')));
        const first = $('content-editor').querySelector('.has-error');
        first?.closest('details')?.setAttribute('open', '');
        first?.querySelector('input, textarea')?.focus();
      } else if (err.status !== 401) alert.replaceChildren(el('p', { class: 'alert alert-error' }, t('common.error')));
    } finally {
      s.saving = false;
      $('content-save').disabled = false;
    }
  }

  $('content-save').addEventListener('click', save);
  $('content-discard').addEventListener('click', () => {
    if (!confirm(t('admin.discardConfirm'))) return;
    s.work = structuredClone(s.saved);
    s.errors.clear();
    clearDraft('site');
    s.restoredAt = null;
    $('save-alert').replaceChildren();
    render();
  });
  $('notice-add').addEventListener('click', () => editNotice(null));

  // -------------------------------------------------------------------------
  // Framing and uploading a photo
  // -------------------------------------------------------------------------

  /**
   * Opens the photo, lets him frame it in the shape it has on the site, then uploads it in
   * every size the site uses. Resolves to { upload: id }, or null if he cancels.
   */
  async function cropAndUpload(file, slot) {
    const spec = PHOTO_SLOTS[slot];
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      toast(t('admin.photoUnreadable'));
      return null;
    }
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    return new Promise((resolve) => {
      const view = el('img', { class: 'crop-img', src: url, alt: '', draggable: 'false' });
      const frame = el(
        'div',
        { class: `crop-frame crop-frame-${slot}`, tabindex: 0, 'aria-label': t('admin.cropFrame'), 'aria-describedby': 'crop-help' },
        view,
        slot === 'hero' ? el('span', { class: 'photo-fan', html: FANLIGHT }) : '',
      );
      // The frame takes the room the screen has (the dialog fills a phone's screen).
      const stage = el('div', { class: 'crop-stage' }, frame);
      const zoom = el('input', { id: 'crop-zoom', type: 'range', min: 1, max: 4, step: 0.01, value: 1 });
      const status = el('p', { class: 'crop-status', role: 'status' });
      const use = el('button', { type: 'button', class: 'btn btn-primary' }, t('admin.cropUse'));
      const cancel = el('button', { type: 'button', class: 'btn btn-ghost' }, t('admin.cancelAction'));
      const dialog = el(
        'dialog',
        { class: 'dialog crop-dialog', 'aria-labelledby': 'crop-title' },
        el(
          'div',
          { class: 'dialog-inner' },
          el('h2', { id: 'crop-title' }, t('admin.cropTitle')),
          el('p', { id: 'crop-help', class: 'panel-sub' }, t('admin.cropHelp')),
          stage,
          el('div', { class: 'field crop-zoom' }, el('label', { for: 'crop-zoom' }, t('admin.cropZoom')), zoom),
          status,
          el('div', { class: 'panel-actions' }, use, cancel),
        ),
      );
      document.body.append(dialog);

      // The photo covers the frame at zoom 1; (x, y) is its top-left corner inside the frame.
      let fw = 0;
      let fh = 0;
      let base = 1;
      let z = 1;
      let x = 0;
      let y = 0;
      const scale = () => base * z;
      const clamp = () => {
        x = Math.min(0, Math.max(fw - W * scale(), x));
        y = Math.min(0, Math.max(fh - H * scale(), y));
      };
      const paint = () => {
        view.style.width = `${W * scale()}px`;
        view.style.height = `${H * scale()}px`;
        view.style.transform = `translate(${x}px, ${y}px)`;
      };
      const zoomTo = (next, cx = fw / 2, cy = fh / 2) => {
        const k = Math.min(4, Math.max(1, next));
        const ix = (cx - x) / scale();
        const iy = (cy - y) / scale();
        z = k;
        x = cx - ix * scale();
        y = cy - iy * scale();
        clamp();
        paint();
        zoom.value = String(z);
      };
      const layout = () => {
        const room = stage.getBoundingClientRect();
        const width = Math.max(150, Math.min(room.width, room.height * spec.ratio, 440));
        frame.style.width = `${width}px`;
        frame.style.height = `${width / spec.ratio}px`;
        const r = frame.getBoundingClientRect();
        const first = !fw;
        const keep = fw ? { ix: (fw / 2 - x) / scale(), iy: (fh / 2 - y) / scale() } : null;
        fw = r.width;
        fh = r.height;
        base = Math.max(fw / W, fh / H);
        if (first) {
          x = (fw - W * scale()) / 2;
          y = (fh - H * scale()) / 2;
        } else {
          x = fw / 2 - keep.ix * scale();
          y = fh / 2 - keep.iy * scale();
        }
        clamp();
        paint();
      };
      // A small photo looks soft on big screens: say so (it can still be used).
      if (Math.min(W, H * spec.ratio) < spec.widths[1]) status.textContent = t('admin.photoSmall');

      // Dragging with a finger or the mouse; pinching with two fingers.
      const pointers = new Map();
      frame.addEventListener('pointerdown', (e) => {
        try {
          frame.setPointerCapture(e.pointerId);
        } catch {
          /* (a pointer the browser no longer tracks) */
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      });
      frame.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        if (pointers.size === 1) {
          x += e.clientX - prev.x;
          y += e.clientY - prev.y;
          clamp();
          paint();
        } else if (pointers.size === 2) {
          const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)[1];
          const before = Math.hypot(prev.x - other.x, prev.y - other.y);
          const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
          const r = frame.getBoundingClientRect();
          if (before > 0) zoomTo(z * (after / before), (e.clientX + other.x) / 2 - r.left, (e.clientY + other.y) / 2 - r.top);
        }
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      });
      const lift = (e) => pointers.delete(e.pointerId);
      frame.addEventListener('pointerup', lift);
      frame.addEventListener('pointercancel', lift);
      frame.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const r = frame.getBoundingClientRect();
          zoomTo(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX - r.left, e.clientY - r.top);
        },
        { passive: false },
      );
      frame.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 12;
        // the photo moves the way the arrow points
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (moves[e.key]) {
          x += moves[e.key][0];
          y += moves[e.key][1];
          clamp();
          paint();
        } else if (e.key === '+' || e.key === '=') zoomTo(z + 0.1);
        else if (e.key === '-') zoomTo(z - 0.1);
        else return;
        e.preventDefault();
      });
      zoom.addEventListener('input', () => zoomTo(Number(zoom.value)));
      const onResize = () => layout();
      window.addEventListener('resize', onResize);

      let busy = false;
      const finish = (result) => {
        window.removeEventListener('resize', onResize);
        dialog.close();
        dialog.remove();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      cancel.addEventListener('click', () => !busy && finish(null));
      dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        if (!busy) finish(null);
      });
      use.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        use.disabled = true;
        cancel.disabled = true;
        try {
          const k = scale();
          const sw = Math.min(W, fw / k);
          const sh = Math.min(H, fh / k);
          const rect = [Math.min(W - sw, Math.max(0, -x / k)), Math.min(H - sh, Math.max(0, -y / k)), sw, sh];
          const id = uploadId();
          const widths = [...spec.widths].sort((a, b) => b - a);
          let source = img;
          let from = rect;
          let done = 0;
          let middle = null;
          for (const w of widths) {
            status.textContent = t('admin.uploading', { n: done + 1, total: widths.length });
            const h = Math.round(w / spec.ratio);
            const canvas = drawScaled(source, from, w, h);
            const blob = await jpeg(canvas);
            const res = await fetch(`/api/admin/media/${slot}/${id}/${w}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'image/jpeg' },
              body: blob,
              credentials: 'same-origin',
            });
            if (res.status === 401) {
              onUnauthorized();
              throw new Error('signed out');
            }
            if (!res.ok) throw new Error(`upload ${res.status}`);
            if (w === spec.widths[1] || !middle) middle = blob;
            if (source !== img) source.width = 0;
            source = canvas; // the next, smaller size comes from this one
            from = [0, 0, w, h];
            done++;
          }
          if (source !== img) source.width = 0;
          s.previews.set(id, URL.createObjectURL(middle));
          finish({ upload: id });
        } catch (err) {
          console.error(err);
          status.textContent = t('admin.uploadFailed');
          busy = false;
          use.disabled = false;
          cancel.disabled = false;
        }
      });

      dialog.showModal();
      requestAnimationFrame(() => {
        layout();
        frame.focus({ preventScroll: true });
      });
    });
  }

  return { load, render, isDirty: () => s.loaded && dirty() };
}

/** Draws part of a picture at a new size, halving step by step so it stays sharp. */
function drawScaled(source, [sx, sy, sw, sh], tw, th) {
  let src = source;
  let rect = [sx, sy, sw, sh];
  while (rect[2] > tw * 2 && rect[3] > th * 2) {
    const c = document.createElement('canvas');
    c.width = Math.round(rect[2] / 2);
    c.height = Math.round(rect[3] / 2);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, ...rect, 0, 0, c.width, c.height);
    if (src !== source) src.width = 0;
    src = c;
    rect = [0, 0, c.width, c.height];
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff'; // a photo with see-through parts gets a white background
  ctx.fillRect(0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, ...rect, 0, 0, tw, th);
  if (src !== source) src.width = 0;
  return out;
}

/** The canvas as a JPEG, smaller if it comes out too big. */
async function jpeg(canvas) {
  const encode = (q) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', q));
  let blob = await encode(0.84);
  if (blob.size > 1_400_000) blob = await encode(0.7);
  if (blob.size > 1_850_000) blob = await encode(0.55);
  return blob;
}
