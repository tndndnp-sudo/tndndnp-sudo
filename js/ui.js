/* оболочка: тема, хедер, меню, появление, часы, прожектор, cmd+k */
import {
  $, $$, h, clamp, feed, beat, onTick, addCommand, commands,
  WEEKDAYS, MONTHS, days, pad2
} from './util.js';

const root = document.documentElement;
const body = document.body;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const narrow = matchMedia('(max-width: 920px)');
export const fine = matchMedia('(pointer: fine)');

const DAY_START = 6 * 60 + 30;   // подъём
const DAY_END = 23 * 60 + 30;    // отбой
const CIRC_DAY = 326.7;

/* ---------- тема + view transition ---------- */
function paintThemeColor(t) {
  const m = $('#meta-theme');
  if (m) m.content = t === 'dark' ? '#07070A' : '#FFFFFF';
}
export function setTheme(t, origin, animate = true) {
  const apply = () => {
    root.dataset.theme = t;
    try { localStorage.setItem('tnd:theme', t); } catch {}
    paintThemeColor(t);
  };
  if (!animate || reduced.matches || typeof document.startViewTransition !== 'function') { apply(); return; }
  const vt = document.startViewTransition(apply);
  const max = Math.hypot(innerWidth, innerHeight);
  const x = origin?.x ?? innerWidth - 24, y = origin?.y ?? 34;
  vt.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${max}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }
    );
  }).catch(() => {});
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('tnd:theme'); } catch {}
  setTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'), null, false);
  $('#theme').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark',
      { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  });
  addCommand('сменить тему', 'тёмная / светлая', () => {
    const r = $('#theme').getBoundingClientRect();
    setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', { x: r.right, y: r.bottom });
  }, 'T');
}

/* ---------- хедер: залипание + полоса прокрутки ---------- */
function initHeader() {
  const hdr = $('#hdr'), bar = $('#scrollbar');
  let raf = 0;
  const upd = () => {
    raf = 0;
    const max = document.documentElement.scrollHeight - innerHeight;
    hdr.classList.toggle('is-stuck', scrollY > 6);
    bar.style.transform = `scaleX(${max > 0 ? clamp(scrollY / max, 0, 1) : 0})`;
  };
  addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(upd); }, { passive: true });
  addEventListener('resize', upd, { passive: true });
  upd();
}

/* ---------- меню: пилюля, скроллспай, мобильный лист ---------- */
const links = () => $$('.nav__link');
export function movePill(link) {
  const nav = $('#nav'), pill = $('.nav__pill');
  if (!link || narrow.matches) return;
  const r = link.getBoundingClientRect(), nr = nav.getBoundingClientRect();
  nav.classList.add('is-ready');
  pill.style.width = `${r.width}px`;
  pill.style.setProperty('--x', `${r.left - nr.left}px`);
}
function markActive(id) {
  let hit = null;
  links().forEach((a) => {
    const on = a.getAttribute('href') === '#' + id;
    if (on) { a.setAttribute('aria-current', 'true'); hit = a; } else a.removeAttribute('aria-current');
  });
  if (hit) movePill(hit);
}
function initNav() {
  const nav = $('#nav'), burger = $('#burger'), pill = $('.nav__pill');
  const sections = links().map((a) => $('#' + a.getAttribute('href').slice(1))).filter(Boolean);

  if (!reduced.matches && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) markActive(e.target.id); });
    }, { rootMargin: '-42% 0px -52% 0px', threshold: 0 });
    sections.forEach((s) => io.observe(s));
  } else {
    markActive('study');
  }

  const closeMenu = () => {
    if (!root.classList.contains('nav-open')) return;
    root.classList.remove('nav-open');
    if (!$('#cmdk') || $('#cmdk').hidden) body.classList.remove('lock');
    burger.setAttribute('aria-expanded', 'false');
  };
  burger.addEventListener('click', () => {
    const open = !root.classList.contains('nav-open');
    root.classList.toggle('nav-open', open);
    body.classList.toggle('lock', open);
    burger.setAttribute('aria-expanded', String(open));
    if (open) links()[0]?.focus({ preventScroll: true });
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
  narrow.addEventListener('change', (e) => {
    if (!e.matches) closeMenu();
    requestAnimationFrame(() => { nav.classList.add('is-ready'); movePill($('.nav__link[aria-current=true]') || links()[0]); });
  });

  links().forEach((a) => a.addEventListener('mouseenter', () => {
    if (!narrow.matches) movePill(a);
  }));
  nav.addEventListener('mouseleave', () => { if (!narrow.matches) movePill($('.nav__link[aria-current=true]') || links()[0]); });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const target = id ? $('#' + id) : null;
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' }); history.replaceState(null, '', '#' + id); markActive(id); }
    else if (id === '') { e.preventDefault(); scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  addEventListener('load', () => {
    nav.classList.add('is-ready');
    movePill($('.nav__link[aria-current=true]') || links()[0]);
  });
  addEventListener('resize', () => movePill($('.nav__link[aria-current=true]') || links()[0]), { passive: true });

  addCommand('меню', 'открыть список разделов', () => {
    if (narrow.matches) { root.classList.add('nav-open'); body.classList.add('lock'); }
    else scrollTo({ top: 0, behavior: 'smooth' });
  }, 'M');
  const go = (id, label) => addCommand(label, 'раздел', () => $('#' + id)?.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' }));
  go('study', 'учёба'); go('play', 'игры'); go('life', 'жизнь'); go('about', 'обо мне');
  pill.setAttribute('aria-hidden', 'true');
}

/* ---------- появление при скролле ---------- */
function initReveal() {
  if (reduced.matches || !('IntersectionObserver' in window)) {
    $$('[data-reveal]').forEach((n) => n.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -6% 0px', threshold: .05 });
  $$('[data-reveal]').forEach((n) => io.observe(n));
}

/* ---------- часы, прогресс дня, бегущая строка ---------- */
export function renderTicker() {
  const track = $('#ticker-track');
  if (!track) return;
  const items = feed.items.length ? feed.items : ['панель загружается…'];
  const one = items.map((t) => `<span>${t}</span>`).join('');
  track.innerHTML = one + one;
}
function fmtLeft(min) {
  const t = Math.max(0, Math.floor(min));
  const d = Math.floor(t / 1440), hh = Math.floor((t % 1440) / 60), mm = t % 60;
  if (!t) return 'прямо сейчас';
  if (d) return days(d, ['день', 'дня', 'дней']) + (hh ? `, ${hh} ч` : '');
  if (hh) return `${hh} ч ${mm} мин`;
  return `${mm} мин`;
}
function initClock() {
  const fClock = $('#f-clock'), fDay = $('#f-day'), nowClock = $('#now-clock'), nowDate = $('#now-date'),
    ring = $('#ring-day'), ringPct = $('#ring-pct'), weekend = $('#row-weekend');
  const upd = () => {
    const d = new Date();
    const hh = pad2(d.getHours()), mm = pad2(d.getMinutes()), ss = pad2(d.getSeconds());
    fClock.textContent = `${hh}:${mm}`;
    nowClock.textContent = `${hh}:${mm}:${ss}`;
    nowDate.textContent = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;

    const cur = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    const p = clamp((cur - DAY_START) / (DAY_END - DAY_START), 0, 1);
    ring.style.strokeDashoffset = String(CIRC_DAY * (1 - p));
    const pc = Math.round(p * 100);
    ringPct.textContent = pc + '%';
    fDay.textContent = pc + '%';

    const wd = (d.getDay() + 6) % 7;
    const left = (4 - wd) * 1440 + (DAY_END - cur);
    weekend.textContent = wd > 4 ? 'выходные — гуляй' : fmtLeft(left);
  };
  upd();
  onTick(upd);
}

/* ---------- прожектор за курсором + лёгкий наклон карточек ---------- */
function initPointerFx() {
  if (!fine.matches) { root.classList.remove('fine'); return; }
  root.classList.add('fine');
  const bg = $('.bg');
  let px = 0, py = 0, raf = 0;
  addEventListener('pointermove', (e) => {
    px = e.clientX; py = e.clientY;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      bg.style.setProperty('--mx', px + 'px');
      bg.style.setProperty('--my', py + 'px');
    });
  }, { passive: true });

  if (reduced.matches) return;
  const max = 3.4;
  const tilt = (el) => {
    el.addEventListener('pointermove', (e) => {
      if (narrow.matches) return;
      const r = el.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - .5) * -max;
      const ry = ((e.clientX - r.left) / r.width - .5) * max;
      el.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-4px)`;
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  };
  $$('.game, .nowcard').forEach(tilt);
  new MutationObserver(() => $$('.game').forEach((g) => {
    if (g.dataset.tilt) return; g.dataset.tilt = '1'; tilt(g);
  })).observe($('#game-grid'), { childList: true });
}

/* ---------- cmd+k ---------- */
function initCmdk() {
  const box = $('#cmdk'), input = $('#cmdk-input'), list = $('#cmdk-list');
  let sel = 0, shown = [];
  const close = () => { box.hidden = true; if (!root.classList.contains('nav-open')) body.classList.remove('lock'); };
  const open = () => {
    box.hidden = false; body.classList.add('lock'); input.value = ''; draw('');
    input.focus({ preventScroll: true });
  };
  const draw = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    shown = commands.filter((c) => !words.length || words.every((w) => (c.label + ' ' + (c.hint || '')).toLowerCase().includes(w)));
    sel = 0;
    list.innerHTML = '';
    shown.slice(0, 40).forEach((c, i) => {
      const b = h('li');
      const btn = h('button', 'cmdk__i' + (i === 0 ? ' is-sel' : ''));
      btn.type = 'button';
      btn.innerHTML = `<span class="k"></span><span>${c.label}</span>` +
        (c.hint ? `<em>${c.hint}</em>` : '') + (c.key ? `<small>${c.key}</small>` : '');
      btn.addEventListener('mouseenter', () => pick(i));
      btn.addEventListener('click', () => { close(); run(i); });
      b.append(btn); list.append(b);
    });
  };
  const pick = (i) => {
    const items = $$('.cmdk__i', list);
    if (!items.length) return;
    sel = (i + items.length) % items.length;
    items.forEach((n, k) => n.classList.toggle('is-sel', k === sel));
    items[sel].scrollIntoView({ block: 'nearest' });
  };
  const run = (i) => { const c = shown[i]; if (c?.run) c.run(); };

  input.addEventListener('input', () => draw(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(sel - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); close(); run(sel); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); box.hidden ? open() : close(); }
    if (k === 'k' && e.metaKey) e.preventDefault();
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const kbd = $$('#cmd-open kbd');
  if (mac && kbd.length === 2) { kbd[0].textContent = '⌘'; kbd[1].textContent = 'K'; }
  $('#cmd-open').addEventListener('click', open);
  addCommand('в начало', 'прокрутить наверх', () => scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ---------- сборка ---------- */
export function bootUI() {
  initTheme(); initHeader(); initNav(); initReveal(); initClock(); initPointerFx(); initCmdk();
  $('#year').textContent = new Date().getFullYear();
  $('#to-top').addEventListener('click', () => scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' }));
  addEventListener('offline', () => toast('без сети. панель это умеет, данные никуда не денутся'));
  addEventListener('online', () => toast('сеть вернулась'));
  renderTicker();

  let iv = 0;
  const start = () => { if (!iv) iv = setInterval(beat, 1000); };
  const stop = () => { clearInterval(iv); iv = 0; };
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();
}
