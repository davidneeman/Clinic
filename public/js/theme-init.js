// Runs synchronously in <head> so the page never flashes the wrong theme, direction or text size.
(function () {
  // Only over https (the admin page and the other files come without the server's own move to
  // https): on this computer, while developing, plain http is fine.
  if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    location.replace('https:' + location.href.slice(5));
    return;
  }
  var root = document.documentElement;
  var theme = 'light';
  var lang = 'he';
  root.classList.add('js');
  try {
    var saved = localStorage.getItem('theme');
    // Light unless the visitor picked dark with the button (David: light is the default).
    theme = saved === 'dark' ? 'dark' : 'light';
    lang = new URLSearchParams(location.search).get('lang') || localStorage.getItem('lang') || 'he';
    var a11y = JSON.parse(localStorage.getItem('a11y') || '{}') || {};
    if (a11y.text) root.classList.add('a11y-text-' + a11y.text);
    ['contrast', 'links', 'still', 'font'].forEach(function (k) {
      if (a11y[k]) root.classList.add('a11y-' + k);
    });
  } catch (e) {}
  // The design: ערפל (mist).
  root.setAttribute('data-look', '2ln');
  // Its colour options: ?options shows a switcher to compare them (?options=dune opens on one)
  // and remembers the pick. The normal site always has the first.
  try {
    var opt = /[?&]options(?:=([a-z]*))?(?:&|$)/.exec(location.search);
    if (opt) {
      root.classList.add('show-palettes');
      var pal = opt[1] || localStorage.getItem('palette') || '';
      if (/^(oat|dune)$/.test(pal)) {
        root.setAttribute('data-palette', pal);
        localStorage.setItem('palette', pal);
      }
    }
  } catch (e) {}
  // Phones: on the home page the bottom bar waits until the opening button scrolls away.
  if (location.pathname === '/' || /\/index\.html$/.test(location.pathname)) root.classList.add('bar-wait');
  // The home page opens with a short intro – once per visit.
  try {
    if (sessionStorage.getItem('intro')) root.classList.add('no-intro');
    else sessionStorage.setItem('intro', '1');
  } catch (e) {}
  if (lang !== 'en') lang = 'he';
  root.setAttribute('data-theme', theme);
  root.lang = lang;
  root.dir = lang === 'he' ? 'rtl' : 'ltr';
})();
