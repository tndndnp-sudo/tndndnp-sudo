/* игры: библиотека, вишлист, катки с друзьями */
import { GAMES, WISHLIST, MATES } from './data.js';
import { $, $$, h, get, set, toast, feed, addCommand, clamp } from './util.js';

const ST = { play: 'играю', drop: 'заброшено', done: 'пройдено' };
const FILTERS = [['all', 'все'], ['play', 'живое'], ['drop', 'дропнуто'], ['done', 'пройдено']];

let filter = 'all';
let sort = 'hours';

function render() {
  const grid = $('#game-grid');
  grid.innerHTML = '';
  const max = Math.max(...GAMES.map((g) => g.hours), 1);
  const list = GAMES
    .filter((g) => filter === 'all' || g.status === filter)
    .sort((a, b) => sort === 'hours' ? b.hours - a.hours : b.score - a.score);

  if (!list.length) {
    grid.append(h('p', 'games__empty', 'тут пусто. в этом статусе у меня ничего не лежит'));
  }

  list.forEach((g, i) => {
    const el = h('article', 'game');
    el.dataset.status = g.status;
    el.style.setProperty('--h', g.hue);
    el.innerHTML =
      `<div class="game__cover">
         <span class="game__st">${ST[g.status] || g.status}</span>
         <b>${g.title}</b>
       </div>
       <div class="game__body">
         <p class="game__note">${g.note}</p>
         <div class="game__row">
           <span class="mono">${g.hours} ч · ${g.tag}</span>
           <span class="score">${g.score}<em>/10</em></span>
         </div>
         <span class="meter"><i style="--w:${clamp(g.hours / max * 100, 6, 100)}%"></i></span>
       </div>`;
    el.style.animation = `pop .5s cubic-bezier(.22,1,.36,1) ${Math.min(i, 8) * 45}ms backwards`;
    grid.append(el);
  });

  $('#games-hours').textContent = GAMES.reduce((a, g) => a + g.hours, 0).toLocaleString('ru-RU');
  $('#games-count').textContent = list.length + ' / ' + GAMES.length;
  $$('#game-filters .chip').forEach((c) => {
    if (c.dataset.k) c.classList.toggle('is-on', c.dataset.k === filter);
    if (c.dataset.s) c.classList.toggle('is-on', c.dataset.s === sort);
  });
}

function initFilters() {
  const box = $('#game-filters');
  FILTERS.forEach(([k, label]) => {
    const b = h('button', 'chip' + (k === filter ? ' is-on' : ''));
    b.type = 'button'; b.dataset.k = k;
    const n = k === 'all' ? GAMES.length : GAMES.filter((g) => g.status === k).length;
    b.innerHTML = `${label}<i>${n}</i>`;
    b.addEventListener('click', () => { filter = k; render(); });
    box.append(b);
  });
  const s1 = h('button', 'chip is-on'); s1.type = 'button';
  s1.dataset.s = 'hours'; s1.innerHTML = 'по часам';
  s1.addEventListener('click', () => { sort = 'hours'; render(); });
  const s2 = h('button', 'chip'); s2.type = 'button';
  s2.dataset.s = 'score'; s2.innerHTML = 'по оценке';
  s2.addEventListener('click', () => { sort = 'score'; render(); });
  box.append(s1, s2);
}

function initWish() {
  const list = $('#wish-list');
  WISHLIST.forEach((w) => {
    const need = Math.round((1 - w.want / w.price) * 100);
    const li = h('li', 'wish__i');
    li.innerHTML =
      `<div><p class="wish__t">${w.title}</p><p class="wish__s">${w.where} · хочу за ${w.want} ₽</p></div>
       <div class="wish__p">
         <b class="mono">${w.price.toLocaleString('ru-RU')} ₽</b>
         <span class="meter meter--sm"><i style="--w:${clamp(100 - need, 4, 100)}%"></i></span>
         <em>надо -${need}%</em>
       </div>`;
    list.append(li);
  });
}

function initMates() {
  const list = $('#mate-list');
  MATES.forEach(([name, note, on]) => {
    const li = h('li', 'mate' + (on ? ' is-on' : ''));
    li.innerHTML = `<span class="dot"></span><b>${name}</b><span>${note}</span>`;
    list.append(li);
  });
}

export function initPlay() {
  initFilters(); render(); initWish(); initMates();

  const now = GAMES.filter((g) => g.status === 'play').map((g) => g.title);
  feed.items.unshift(now.length ? `сейчас кручу: ${now.join(', ')}` : 'сейчас не играю, занимаюсь собой');
  const fav = GAMES.slice().sort((a, b) => b.hours - a.hours)[0];
  if (fav) feed.items.push(`${fav.title} — ${fav.hours} ч, это уже диагноз`);
  $('#f-play').textContent = GAMES.reduce((a, g) => a + g.hours, 0).toLocaleString('ru-RU') + ' ч';

  addCommand('что поиграть сегодня', 'показать живые игры', () => {
    filter = 'play'; render(); $('#play').scrollIntoView({ block: 'start' }); toast('показал только то, во что играю');
  });
  addCommand('все игры', 'сбросить фильтр', () => { filter = 'all'; render(); });
}
