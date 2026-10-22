/* мелкие помощники: локальное хранилище, dom, время, тосты */

const P = 'tnd:';

export function get(key, fallback) {
  try {
    const raw = localStorage.getItem(P + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
export function set(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value)); } catch { /* приватный режим — просто не сохраняем */ }
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}
export const uid = () => Math.random().toString(36).slice(2, 9);
export const pad2 = (n) => String(n).padStart(2, '0');
export const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
export const rub = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';

export const plural = (n, forms) => forms[
  (n % 100 > 4 && n % 100 < 21) ? 2 : [2, 0, 1, 1, 1, 2][Math.min(n % 10, 5)]
];
export const days = (n, w) => `${n} ${plural(n, w)}`;

/* даты */
export const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function addDays(n) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return d; }
export function daysBetween(from, to) {
  const a = new Date(from); a.setHours(0, 0, 0, 0);
  const b = new Date(to); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 864e5);
}
export const mins = (hm) => { const [a, b] = hm.split(':').map(Number); return a * 60 + b; };
export const nowMins = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
/* 0 = понедельник ... 6 = воскресенье */
export const weekIdx = (d = new Date()) => (d.getDay() + 6) % 7;

export const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const WEEK_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/* общий поток для бегущей строки в карточке «сейчас» */
export const feed = { items: [] };

/* тик раз в секунду: подписка, чтобы не плодить интервалы */
const tickers = new Set();
export const onTick = (cb) => { tickers.add(cb); return () => tickers.delete(cb); };
export const beat = () => tickers.forEach((cb) => { try { cb(); } catch (e) { console.debug(e); } });

/* тосты */
let toastT;
export function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('is-on'), 2100);
}

/* пик-звук на завершение таймера — без аудиофайлов */
let actx;
export function beep(freq = 660, ms = 130, gain = .06) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, actx.currentTime);
    g.gain.linearRampToValueAtTime(gain, actx.currentTime + .01);
    g.gain.exponentialRampToValueAtTime(.0001, actx.currentTime + ms / 1000);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000 + .02);
  } catch { /* без звука тоже нормально */ }
}

/* команды для cmd+k */
export const commands = [];
export const addCommand = (label, hint, run, key) => commands.push({ label, hint, run, key });
