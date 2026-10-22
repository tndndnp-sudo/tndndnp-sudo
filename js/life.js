/* жизнь: привычки, режим, деньги, записки */
import { HABITS, ROUTINE, MONEY_CATS, SPENDS_SEED, NOTES_SEED, ME } from './data.js';
import {
  $, $$, h, get, set, uid, rub, mins, nowMins, dayKey, addDays, days, plural,
  toast, feed, onTick, addCommand, clamp, WEEK_SHORT
} from './util.js';

const SPAN = 14;

/* ---------- привычки ---------- */
let hab = {};
const saveHab = () => set('habits', hab);
const lastDays = () => Array.from({ length: SPAN }, (_, i) => dayKey(addDays(i - (SPAN - 1))));

function streakOf(key) {
  const map = hab[key] || {};
  const d = new Date();
  if (!map[dayKey(d)]) d.setDate(d.getDate() - 1);      // сегодня ещё можно добить
  let n = 0;
  while (map[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function renderHabits() {
  const box = $('#habit-grid');
  box.innerHTML = '';
  const daysArr = lastDays();

  const head = h('div', 'hab__head');
  head.innerHTML = `<span class="habit__n">14 дней назад → сегодня</span>
    <span class="cells">${daysArr.map((k) => {
      const d = new Date(k + 'T12:00:00');
      return `<span title="${d.getDate()}.${d.getMonth() + 1}">${WEEK_SHORT[(d.getDay() + 6) % 7][0]}</span>`;
    }).join('')}</span>`;
  box.append(head);

  const today = dayKey(new Date());
  let filled = 0;

  HABITS.forEach(([label, key]) => {
    hab[key] = hab[key] || {};
    const row = h('div', 'habit');
    const cells = daysArr.map((k) => {
      const on = !!hab[key][k];
      if (on) filled++;
      const future = k > today;
      const cls = 'cell' + (on ? ' is-f' : '') + (future ? ' is-fut' : '') + (k === today ? ' is-today' : '');
      return `<button type="button" class="${cls}" data-d="${k}" aria-pressed="${on}"
        aria-label="${label}, ${k.slice(8)}.${k.slice(5, 7)}"></button>`;
    }).join('');
    const st = streakOf(key);
    row.innerHTML = `<span class="habit__n">${label}${st > 1 ? ` <em>${st} ${plural(st, ['день', 'дня', 'дней'])} подряд</em>` : ''}</span>
      <span class="habit__cells cells">${cells}</span>`;
    row.addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || cell.classList.contains('is-fut')) return;
      const d = cell.dataset.d;
      hab[key][d] ? delete hab[key][d] : (hab[key][d] = 1);
      saveHab(); renderHabits();
    });
    box.append(row);
  });

  const doneToday = HABITS.filter(([, k]) => hab[k]?.[today]).length;
  $('#habit-best').textContent = Math.max(0, ...HABITS.map(([, k]) => streakOf(k)));
  $('#habit-rate').textContent = Math.round(filled / (HABITS.length * SPAN) * 100) + '%';
  $('#habit-today').textContent = `${doneToday}/${HABITS.length}`;
  feed.items = feed.items.filter((x) => !/^привычки:/.test(x));
  feed.items.unshift(`привычки: сегодня ${doneToday} из ${HABITS.length}`);
}

/* ---------- режим дня ---------- */
function initRoutine() {
  const list = $('#routine-list');
  const marks = ROUTINE.map((r) => mins(r[0]));
  list.innerHTML = '';
  ROUTINE.forEach(([time, title, note], i) => {
    const li = h('li', 'tl');
    li.innerHTML = `<span class="tl__t">${time}</span><div><b>${title}</b><p>${note}</p></div>`;
    li.dataset.end = marks[i + 1] ?? 24 * 60;
    li.dataset.start = marks[i];
    list.append(li);
  });
  const paint = () => {
    const m = nowMins();
    $$('.tl', list).forEach((li) => {
      const a = +li.dataset.start, b = +li.dataset.end;
      li.classList.toggle('is-now', m >= a && m < b);
      li.classList.toggle('is-past', m >= b);
    });
  };
  paint(); onTick(paint);
}

/* ---------- деньги ---------- */
let spends = [];
const saveSpends = () => set('spends', spends);

function renderMoney() {
  const total = spends.reduce((a, s) => a + s.sum, 0);
  const left = ME.pocket - total;

  const bars = $('#budget-bars');
  bars.innerHTML = '';
  const byCat = {};
  spends.forEach((s) => { byCat[s.cat] = (byCat[s.cat] || 0) + s.sum; });
  MONEY_CATS.forEach((cat) => {
    const sum = byCat[cat] || 0;
    const share = clamp(sum / ME.pocket * 100, 0, 100);
    const over = share >= 40;
    const d = h('div', 'budget__i' + (over ? ' is-over' : ''));
    d.innerHTML = `<div class="budget__top"><span>${cat}</span><b>${rub(sum)} · ${Math.round(share)}%</b></div>
      <span class="meter"><i style="--w:${share}%"></i></span>`;
    bars.append(d);
  });

  $('#money-left').textContent = left >= 0 ? `осталось ${rub(left)}` : `минус ${rub(-left)}, сел на мелочь`;
  $('#money-left').style.color = left < 0 ? 'var(--bad)' : '';

  const list = $('#spend-list');
  list.innerHTML = '';
  [...spends].reverse().slice(0, 7).forEach((s) => {
    const li = h('li', 'spend');
    li.innerHTML = `<span class="spend__c">${s.cat}</span><span class="spend__n">${s.name}</span>
      <b class="mono">${s.sum} ₽</b><button class="spend__x" type="button" aria-label="удалить расход">×</button>`;
    li.querySelector('.spend__x').addEventListener('click', () => {
      spends = spends.filter((x) => x.id !== s.id);
      saveSpends(); renderMoney(); toast('расход убрал');
    });
    list.append(li);
  });
}

function initMoney() {
  spends = get('spends', SPENDS_SEED);
  $('#exp-cat').innerHTML = MONEY_CATS.map((c) => `<option>${c}</option>`).join('');
  $('#expense-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#exp-name').value.trim();
    const sum = parseInt($('#exp-sum').value, 10);
    if (!name) { $('#exp-name').focus(); toast('ну и на что потратил?'); return; }
    if (!sum || sum < 1) { $('#exp-sum').focus(); toast('нужна сумма в рублях'); return; }
    spends.push({ id: uid(), name, sum, cat: $('#exp-cat').value });
    $('#exp-name').value = ''; $('#exp-sum').value = '';
    saveSpends(); renderMoney(); toast(`записал ${rub(sum)}`);
  });
  renderMoney();
  addCommand('записать расход', 'секция денег', () => {
    $('#life').scrollIntoView({ block: 'start' }); setTimeout(() => $('#exp-name').focus(), 320);
  });
}

/* ---------- записки ---------- */
let notes = [];
const saveNotes = () => set('notes', notes);

function renderNotes() {
  const board = $('#note-board');
  board.innerHTML = '';
  notes.forEach((n, i) => {
    const el = h('div', 'note');
    el.style.setProperty('--rt', `${((i % 3) - 1) * 1.1}deg`);
    el.innerHTML = `<p contenteditable spellcheck="false" aria-label="записка">${n.text || 'пусто'}</p>
      <button class="note__x" type="button" aria-label="удалить записку">убрать</button>`;
    const p = el.querySelector('p');
    p.addEventListener('blur', () => {
      const txt = p.textContent.trim();
      if (txt === 'пусто') return;
      n.text = txt; saveNotes();
    });
    el.querySelector('.note__x').addEventListener('click', () => {
      notes = notes.filter((x) => x.id !== n.id);
      saveNotes(); renderNotes(); toast('записка улетела');
    });
    board.append(el);
  });
  if (!notes.length) board.append(h('p', 'foot-note', 'записок нет. добавь, а то забудешь'));
}

function initNotes() {
  notes = get('notes', NOTES_SEED.map((n) => ({ ...n, id: uid() })));
  $('#note-add').addEventListener('click', () => {
    notes.unshift({ id: uid(), text: '', color: notes.length % 3 });
    saveNotes(); renderNotes();
    const first = $('#note-board p');
    if (first) { first.textContent = ''; first.focus(); }
    $('#note-board .note')?.classList.add('note--new');
    toast('листок вверху, пиши');
  });
  renderNotes();
}

export function initLife() {
  renderHabits(); initRoutine(); initMoney(); initNotes();
  addCommand('отметить привычки', 'секция жизни', () => {
    $('#life').scrollIntoView({ block: 'start' });
    HABITS.forEach(([, k]) => { hab[k][dayKey(new Date())] = 1; });
    saveHab(); renderHabits(); toast('сегодня закрыто полностью. серия продолжается');
  });
  addCommand('привычки: сбросить сегодня', 'убрать все отметки за день', () => {
    const t = dayKey(new Date());
    HABITS.forEach(([, k]) => delete hab[k][t]);
    saveHab(); renderHabits(); toast('сегодняшний день чист');
  });
}
