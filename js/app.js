/* точка входа: подключает всё остальное */
import { bootUI, renderTicker } from './ui.js';
import { initStudy } from './study.js';
import { initPlay } from './play.js';
import { initLife } from './life.js';
import { initAbout } from './about.js';

document.documentElement.classList.add('js');

bootUI();
initStudy();
initPlay();
initLife();
initAbout();
renderTicker();

/* офлайн-режим: после первого визита панель открывается без сети */
if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* если пришли по якорю — докручиваем после отрисовки */
if (location.hash.length > 1) {
  const target = document.querySelector(location.hash);
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}
