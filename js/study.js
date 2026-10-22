/* учёба: расписание, домашка, оценки, даты, таймер */
import { SCHEDULE, BELLS, GRADES, EVENTS, TASKS_SEED } from './data.js';
import {
  $, $$, h, get, set, uid, mins, nowMins, weekIdx, days, addDays, dayKey,
  toast, feed, onTick, addCommand, daysBetween, MONTHS, plural, beep
} from './util.js';

const WEEK = [['пн', 'понедельник'], ['вт', 'вторник'], ['ср', 'среда'], ['чт', 'четверг'], ['пт', 'пятница']];
const RING = 439.82;

/* ---------- расписание ---------- */
function lessonsOf(day) { return day > 4 ? [] : SCHEDULE[day]; }

function renderSchedule(day, now) {
  const list = $('#sch-list');
  const items = lessonsOf(day);
  list.innerHTML = '';
  $('#sch-empty').hidden = items.length > 0;

  items.forEach(([subj, tch, room], i) => {
    const [a, b] = BELLS[i];
    const li = h('li', 'lesson');
    li.style.animationDelay = `${i * 45}ms`;
    if (day === now.day) {
      if (now.m > mins(b)) li.className += ' is-past';
      else if (now.m >= mins(a)) li.className += ' is-now';
    }
    li.innerHTML =
      `<span class="lesson__no">${i + 1}</span>
       <div><p class="lesson__s">${subj}</p><p class="lesson__meta">${tch} · ${room}</p></div>
       <div class="lesson__right"><p class="lesson__t">${a} — ${b}</p></div>`;
    list.append(li);
  });

  const last = items.length ? BELLS[items.length - 1][1] : '—';
  $('#sch-total').textContent = items.length
    ? `${days(items.length, ['урок', 'урока', 'уроков'])} · до ${last}`
    : 'уроков нет';
}

function initSchedule() {
  const tabs = $('#sch-tabs');
  const today = weekIdx();
  let cur = Math.min(today, 4);

  WEEK.forEach(([short], i) => {
    const b = h('button', 'tab' + (i === cur ? ' is-on' : '') + (i === today ? ' is-today' : ''));
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === cur));
    b.innerHTML = `${short}<i>${lessonsOf(i).length}</i>`;
    b.addEventListener('click', () => {
      cur = i;
      [...tabs.children].forEach((el, k) => {
        el.classList.toggle('is-on', k === cur);
        el.setAttribute('aria-selected', String(k === cur));
      });
      paint();
    });
    tabs.append(b);
  });

  const paint = () => renderSchedule(cur, { day: weekIdx(), m: nowMins() });
  paint();
  if (cur === today) onTick(() => { if (cur === today) paint(); });
  addCommand('расписание', 'перейти к урокам', () => $('#study').scrollIntoView({ block: 'start' }));
}

/* ---------- что идёт сейчас (для карточки «сейчас») ---------- */
function nowInfo() {
  const day = weekIdx(), m = nowMins();
  const items = lessonsOf(day);
  if (!items.length) return { cur: day > 4 ? 'выходные, уроков нет' : 'сегодня уроков нет', next: '—' };
  if (m < mins(BELLS[0][0])) {
    const [subj] = items[0];
    return { cur: `уроки начнутся в ${BELLS[0][0]}`, next: `${subj} · ${BELLS[0][0]}` };
  }
  for (let i = 0; i < items.length; i++) {
    const [a, b] = BELLS[i];
    if (m >= mins(a) && m < mins(b)) {
      const nx = items[i + 1];
      return {
        cur: `${items[i][0]} · до ${b}`,
        next: nx ? `${nx[0]} · ${BELLS[i + 1][0]}` : `последний, дальше ${BELLS[i][1]} — свобода`
      };
    }
    if (m < mins(a)) {
      return { cur: 'перемена', next: `${items[i][0]} · ${a}` };
    }
  }
  return { cur: 'уроки закончились', next: 'домашка, потом свобода' };
}

function initNowCard() {
  const a = $('#row-lesson'), b = $('#row-next');
  const paint = () => {
    const i = nowInfo();
    if (a.textContent !== i.cur) a.textContent = i.cur;
    if (b.textContent !== i.next) b.textContent = i.next;
  };
  paint(); onTick(paint);
  feed.items.push('расписание — из домашки, не из головы', 'оценки обновляю после четверти');
}

/* ---------- домашка ---------- */
let tasks = [];
const saveTasks = () => set('tasks', tasks);

function dueInfo(iso) {
  if (!iso) return null;
  const n = daysBetween(new Date(), new Date(iso + 'T00:00:00'));
  if (n < 0) return { txt: `просрочено на ${days(-n, ['день', 'дня', 'дней'])}`, cls: 'badge--late' };
  if (n === 0) return { txt: 'сдать сегодня', cls: 'badge--soon' };
  if (n === 1) return { txt: 'завтра', cls: 'badge--soon' };
  return { txt: `через ${days(n, ['день', 'дня', 'дней'])}`, cls: '' };
}

export function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = '';
  const sorted = [...tasks].sort((x, y) => (x.done - y.done) || String(x.due).localeCompare(String(y.due)));
  sorted.forEach((t, i) => {
    const li = h('li', 'task' + (t.done ? ' is-done' : ''));
    li.style.animationDelay = `${Math.min(i, 8) * 40}ms`;
    const d = t.done ? null : dueInfo(t.due);
    li.innerHTML =
      `<button class="task__box" type="button" aria-label="отметить выполненной">
         <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.6 6.2 12 13.5 4"/></svg>
       </button>
       <div><p class="task__txt">${t.text}</p>
         <p class="task__sub">${d ? `<span class="badge ${d.cls}">${d.txt}</span>` : '<span class="badge">сдано</span>'}<span>${t.subj}</span></p>
       </div>
       <button class="task__del" type="button" aria-label="удалить">×</button>`;
    li.querySelector('.task__box').addEventListener('click', () => {
      t.done = !t.done;
      if (t.done) { beep(880, 90, .04); toast('пункт закрыт'); }
      saveTasks(); renderTasks(); refreshCounts();
    });
    li.querySelector('.task__del').addEventListener('click', () => {
      tasks = tasks.filter((x) => x.id !== t.id);
      saveTasks(); renderTasks(); refreshCounts(); toast('убрал из списка');
    });
    list.append(li);
  });
  $('#task-empty').hidden = tasks.length > 0;
}

function refreshCounts() {
  const open = tasks.filter((t) => !t.done).length;
  $('#f-due').textContent = String(open);
  feed.items = feed.items.filter((s) => !/^долгов:/.test(s));
  feed.items.unshift(open ? `долгов: ${open}` : 'долгов нет, всё сдано');
  window.dispatchEvent(new CustomEvent('tnd:tick'));
}

function initTasks() {
  const seed = TASKS_SEED.map((t) => ({
    ...t,
    due: /^\+\d+$/.test(t.due || '') ? dayKey(addDays(+t.due.slice(1))) : t.due
  }));
  tasks = get('tasks', seed);

  const sel = $('#task-subj');
  const subs = [...new Set([...GRADES.map((g) => g[0]), 'жизненное'])];
  sel.innerHTML = subs.map((s) => `<option>${s}</option>`).join('');

  const form = $('#task-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#task-input');
    const text = input.value.trim();
    if (!text) { input.focus(); toast('сначала напиши, что сдать'); return; }
    tasks.unshift({ id: uid(), text, subj: sel.value, due: dayKey(addDays(1)), done: false });
    input.value = '';
    saveTasks(); renderTasks(); refreshCounts();
    toast('записал, не забудь');
  });
  $('#tasks-clear').addEventListener('click', () => {
    const before = tasks.length;
    tasks = tasks.filter((t) => !t.done);
    if (before === tasks.length) { toast('чистить нечего'); return; }
    saveTasks(); renderTasks(); refreshCounts();
    toast(`убрал ${before - tasks.length} сданных`);
  });

  renderTasks(); refreshCounts();
  addCommand('сдать всё', 'отметить домашку выполненной', () => {
    tasks.forEach((t) => (t.done = true)); saveTasks(); renderTasks(); refreshCounts(); toast('всё сдано. вру, но приятно');
  });
  addCommand('добавить домашку', 'фокус в поле ввода', () => {
    $('#study').scrollIntoView({ block: 'start' }); setTimeout(() => $('#task-input').focus(), 320);
  });
}

/* ---------- оценки ---------- */
function initGrades() {
  const list = $('#grade-list');
  let all = [];
  GRADES.forEach(([name, marks], i) => {
    const avg = marks.reduce((a, b) => a + b, 0) / marks.length;
    all = all.concat(marks);
    const li = h('li', 'grade');
    li.innerHTML =
      `<span class="grade__n">${name}</span>
       <span class="grade__marks">${marks.map((m) => `<i class="mk mk--${m}">${m}</i>`).join('')}</span>
       <span class="grade__avg">${avg.toFixed(2).replace('.', ',')}</span>
       <span class="grade__bar"><i style="--w:${(avg / 5 * 100).toFixed(1)}%"></i></span>`;
    list.append(li);
  });
  const gpa = all.reduce((a, b) => a + b, 0) / all.length;
  $('#gpa').textContent = gpa.toFixed(2).replace('.', ',');
  feed.items.push(`средний балл ${gpa.toFixed(2).replace('.', ',')} — могло быть и хуже`);
}

/* ---------- ближайшие даты ---------- */
function initEvents() {
  const list = $('#event-list');
  const items = EVENTS.map((e) => ({ ...e, left: daysBetween(new Date(), new Date(e.date + 'T00:00:00')) }))
    .filter((e) => e.left >= -1)
    .sort((a, b) => a.left - b.left)
    .slice(0, 5);

  items.forEach((e, i) => {
    const d = new Date(e.date);
    const li = h('li', 'event' + (e.left <= 14 ? ' event--big' : ''));
    li.innerHTML =
      `<span class="event__d">${e.left <= 0 ? '0' : e.left}<em>${e.left <= 0 ? 'сегодня' : days(e.left, ['день', 'дня', 'дней']).split(' ')[1]}</em></span>
       <div><p class="event__t">${e.title}</p><p class="event__n">${d.getDate()} ${MONTHS[d.getMonth()]}${e.note ? ' · ' + e.note : ''}</p></div>`;
    list.append(li);
  });
  if (items[0]) feed.items.unshift(`ближайшее: ${items[0].title} — через ${days(items[0].left, ['день', 'дня', 'дней'])}`);
  else { list.append(h('p', 'foot-note', 'в календаре пусто. добавь дату в js/data.js')); }
}

/* ---------- таймер ---------- */
function initPomodoro() {
  const wrap = $('.pomo'), timeEl = $('#pomo-time'), modeEl = $('#pomo-mode'),
    ring = $('#pomo-ring'), cntEl = $('#pomo-count');
  const st = { dur: 25 * 60, left: 25 * 60, running: false, endAt: 0, mode: 'фокус' };
  let count = get('pomo', { n: 0, day: dayKey(new Date()) });
  if (count.day !== dayKey(new Date())) count = { n: 0, day: dayKey(new Date()) };
  const base = document.title;

  const paint = () => {
    const m = Math.floor(Math.max(st.left, 0) / 60), s = Math.max(st.left, 0) % 60;
    const txt = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timeEl.textContent = txt;
    modeEl.textContent = st.running ? st.mode : `${st.mode} · ${st.left > 0 ? 'пауза' : 'готов'}`;
    ring.style.strokeDashoffset = String(RING * (1 - st.left / st.dur));
    cntEl.textContent = String(count.n);
    document.title = st.running ? `${txt} · ${st.mode}` : base;
    wrap.classList.toggle('is-run', st.running);
  };

  let iv = 0;
  const loop = () => {
    clearInterval(iv);
    if (st.running) iv = setInterval(() => {
      st.left = Math.round((st.endAt - Date.now()) / 1000);
      if (st.left <= 0) finish();
      paint();
    }, 250);
  };
  const start = () => {
    if (st.running || st.left <= 0) return;
    st.running = true; st.endAt = Date.now() + st.left * 1000; loop(); paint();
  };
  const stop = () => { st.running = false; clearInterval(iv); paint(); };
  const finish = () => {
    stop();
    st.left = 0;
    if (st.mode === 'фокус') {
      count.n++; set('pomo', count);
      setMode(5, 'перерыв');
      toast('блок закрыт. 5 минут на чай и размять шею');
    } else {
      setMode(25, 'фокус');
      toast('отдых закончился, давай ещё один блок');
    }
    [740, 620].forEach((f, i) => setTimeout(() => beep(f, 150, .05), i * 230));
    paint();
  };
  const setMode = (min, label) => {
    st.dur = min * 60; st.left = min * 60; st.mode = label; st.running = false;
    $$('.seg__b').forEach((b) => b.classList.toggle('is-on', b.dataset.label === label));
    clearInterval(iv); paint();
  };
  $$('.seg__b').forEach((b) => b.addEventListener('click', () => setMode(+b.dataset.min, b.dataset.label)));
  const toggleBtn = $('#pomo-toggle');
  toggleBtn.addEventListener('click', () => {
    if (st.running) { stop(); toggleBtn.textContent = 'продолжить'; }
    else { start(); toggleBtn.textContent = st.running ? 'пауза' : 'старт'; }
  });
  $('#pomo-reset').addEventListener('click', () => { setMode(st.dur / 60, st.mode); $('#pomo-toggle').textContent = 'старт'; });

  paint();

  addCommand('таймер: старт/пауза', `${st.dur / 60} минут фокуса`, () => {
    $('#study').scrollIntoView({ block: 'start' });
    if (!st.running) start(); else stop();
  }, 'P');
  addCommand('таймер: сброс', 'вернуть 25 минут', () => setMode(25, 'фокус'));
}

export function initStudy() {
  initSchedule(); initNowCard(); initTasks(); initGrades(); initEvents(); initPomodoro();
  return { tasks: () => tasks.filter((t) => !t.done).length };
}
