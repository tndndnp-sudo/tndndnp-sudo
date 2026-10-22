/* обо мне: ссылки, чем собран, вес страницы */
import { ME, LINKS, SPECS } from './data.js';
import { $, h, addCommand } from './util.js';

function weight() {
  try {
    const res = performance.getEntriesByType('resource')
      .filter((e) => !e.name.includes('fonts.g'))
      .reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0);
    const nav = performance.getEntriesByType('navigation')[0];
    const total = res + ((nav?.encodedBodySize || nav?.transferSize) || 0);
    if (!total) return '—';
    return `≈ ${Math.round(total / 1024)} КБ на всё`;
  } catch { return '—'; }
}

export function initAbout() {
  const me = $('#me-line');
  if (me) me.textContent = `личная панель · ${ME.city} · ${ME.klass}`;
  const who = $('#foot-who');
  if (who) who.textContent = `${ME.name}, ${ME.city} · собрано руками за вечер`;

  const links = $('#link-list');
  LINKS.forEach(([label, value, href]) => {
    const a = h('a', 'link', `<b>${label}</b><span>${value}</span>`);
    a.href = href;
    if (href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    links.append(a);
  });

  const specs = $('#spec-list');
  SPECS.forEach(([k, v]) => {
    const li = h('li', 'spec');
    li.innerHTML = `<span>${k}</span><b data-v="${v}">${v === 'auto' ? weight() : v}</b>`;
    specs.append(li);
  });
  // вес догружается после всех запросов
  addEventListener('load', () => {
    const auto = $('#spec-list b[data-v=auto]');
    if (auto) auto.textContent = weight();
  });

  const t = document.querySelector('.logo__txt');
  if (t) t.textContent = ME.nick;
  addCommand('обо мне', 'раздел', () => $('#about').scrollIntoView({ block: 'start' }));
}
