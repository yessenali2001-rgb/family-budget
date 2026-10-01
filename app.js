const STORAGE_KEY = 'family-budget-v1';
const SHEET_KEY = 'family-budget-sheet';
const CURRENCY = '₸'; // поменяйте на '₽', '$', '€' и т.д.

const DEFAULT_STATE = {
  members: ['Общее'],
  expenseCategories: [
    'Продукты', 'Кафе и рестораны', 'Жильё и ЖКХ', 'Связь и интернет', 'Кредиты и рассрочки',
    'Транспорт', 'Такси', 'Автомобиль', 'Дети', 'Образование и кружки', 'Здоровье и аптека',
    'Красота и уход', 'Одежда и обувь', 'Бытовые товары', 'Техника', 'Подписки', 'Развлечения',
    'Подарки', 'Тои и праздники', 'Помощь родителям', 'Путешествия', 'Питомцы', 'Прочее',
  ],
  categoriesVersion: 2, // при обновлении списка категорий новые добавляются к уже заведённым
  incomeCategories: ['Зарплата', 'Подработка', 'Подарки', 'Прочее'],
  limits: {},
  monthlyBudget: 0,
  transactions: [],
  reports: {}, // итоги месяцев: { '2026-09': { ai, aiAt, notes } }
};

const SETTINGS_KEYS = ['members', 'expenseCategories', 'incomeCategories', 'limits', 'monthlyBudget', 'categoriesVersion'];
const OTHER = 'Прочее';

let state = load();
let sheet = loadSheet(); // 'all' — вся семья, иначе имя члена семьи; у каждого своя вкладка
let currentMonth = monthKey(new Date());

const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmt = (n) => money.format(n) + ' ' + CURRENCY;

function normalize(data) {
  const out = structuredClone(DEFAULT_STATE);
  for (const key of ['members', 'expenseCategories', 'incomeCategories']) {
    if (Array.isArray(data?.[key]) && data[key].length) out[key] = data[key].filter((x) => typeof x === 'string');
  }
  if (data?.limits && typeof data.limits === 'object') {
    for (const [c, v] of Object.entries(data.limits)) if (v > 0) out.limits[c] = Number(v);
  }
  if (data?.monthlyBudget > 0) out.monthlyBudget = Number(data.monthlyBudget);
  // старые данные (без номера версии) получили категории первой версии
  out.categoriesVersion = Number(data?.categoriesVersion) || (Array.isArray(data?.expenseCategories) ? 1 : DEFAULT_STATE.categoriesVersion);
  if (Array.isArray(data?.transactions)) out.transactions = data.transactions.filter(isValidTx);
  if (data?.reports && typeof data.reports === 'object') {
    for (const [m, r] of Object.entries(data.reports)) {
      if (/^\d{4}-\d{2}$/.test(m) && r && typeof r === 'object') out.reports[m] = normalizeReport(r);
    }
  }
  return out;
}

function normalizeReport(r) {
  const str = (v) => (typeof v === 'string' ? v : '');
  return { ai: str(r?.ai), aiAt: str(r?.aiAt), notes: str(r?.notes) };
}

function isValidTx(t) {
  return t && typeof t.id === 'string' && ['income', 'expense', 'transfer'].includes(t.type)
    && (t.type !== 'transfer' || t.to === undefined || typeof t.to === 'string')
    && typeof t.amount === 'number' && t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date)
    && typeof t.category === 'string' && typeof t.member === 'string'
    && (t.detail === undefined || typeof t.detail === 'string');
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) {
    console.warn('Не удалось прочитать данные', e);
  }
  return structuredClone(DEFAULT_STATE);
}

function loadSheet() {
  try {
    return localStorage.getItem(SHEET_KEY) || JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').sheet || 'all';
  } catch {
    return 'all';
  }
}

function saveSheet() {
  try { localStorage.setItem(SHEET_KEY, sheet); } catch { /* вкладка просто не запомнится */ }
}

function saveLocal() {
  if (db) return; // в общем режиме данные живут в общей базе
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    notify('Не удалось сохранить данные в этом браузере.');
  }
}

// ---------- Общая база ----------
// На claude.ai страница подключается к общей базе: все, кому открыт доступ, видят одни и те же записи.
// Операции хранятся по месяцам (months/2026-09 → items{id: операция}), настройки — в budget/settings.
// Вне claude.ai (файл на компьютере, GitHub Pages) всё хранится в localStorage этого браузера.

let db = null;
let canWrite = true;
let settingsExist = false;
let knownMonths = new Set();
let knownReports = new Set();
let settingsLoaded = false;
let monthsLoaded = false;
let localCopy = null; // данные этого браузера — можно перенести в общий бюджет
let pendingSettings = null;
const pendingReports = {};
const reportTimers = {};
let settingsTimer;
const writeQueues = {};

function settingsOf(s) {
  return Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]]));
}

function setStatus(text, kind = '') {
  $('syncStatus').textContent = text;
  $('syncStatus').className = 'sync ' + kind;
  $('syncStatus').hidden = !text;
}

function onWriteError(e) {
  const messages = {
    invalid_argument: 'Не удалось сохранить. Похоже, у вас доступ только на просмотр: попросите владельца дать права «Contributor».',
    'permission-denied': 'Не удалось сохранить: у этого аккаунта нет доступа к семейному бюджету.',
    quota_exceeded: 'Общая база заполнена. Удалите старые операции, чтобы добавлять новые.',
    resource_exhausted: 'Слишком много изменений подряд. Подождите немного и повторите.',
  };
  notify(messages[e?.code] || 'Не удалось сохранить изменения. Проверьте интернет и повторите.');
}

// Записи в один документ идут строго по очереди.
function enqueue(path, write) {
  const run = () => write(db.doc(path)).catch(onWriteError);
  writeQueues[path] = (writeQueues[path] || Promise.resolve()).then(run);
  return writeQueues[path];
}

// Категории первой версии: если какой-то из них нет, её удалили сами — не возвращаем.
const FIRST_CATEGORIES = ['Продукты', 'Жильё и ЖКХ', 'Транспорт', 'Дети', 'Здоровье', 'Одежда', 'Развлечения'];

function upgradeCategories() {
  if (state.categoriesVersion >= DEFAULT_STATE.categoriesVersion) return;
  const current = state.expenseCategories.filter((c) => c !== OTHER);
  // старые «Здоровье» и «Одежда» уже покрывают новые похожие категории
  const similar = { 'Здоровье и аптека': 'Здоровье', 'Одежда и обувь': 'Одежда' };
  const added = DEFAULT_STATE.expenseCategories
    .filter((c) => c !== OTHER && !current.includes(c) && !current.includes(similar[c]) && !FIRST_CATEGORIES.includes(c));
  setSettings({
    expenseCategories: [...current, ...added, OTHER],
    categoriesVersion: DEFAULT_STATE.categoriesVersion,
  });
}

function applySettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k !== 'limits') { state[k] = v; continue; }
    for (const [c, x] of Object.entries(v)) {
      if (x > 0) state.limits[c] = x;
      else delete state.limits[c];
    }
  }
}

// Меняем только переданные поля, чтобы не затереть одновременные правки других.
// delay склеивает быстрый ввод (бюджет, лимиты) в одну запись.
function setSettings(patch, delay = 0) {
  applySettings(patch);
  if (!db) return saveLocal();
  const merged = { ...pendingSettings, ...patch };
  if (pendingSettings?.limits && patch.limits) merged.limits = { ...pendingSettings.limits, ...patch.limits };
  pendingSettings = merged;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(flushSettings, delay);
}

function flushSettings() {
  const patch = pendingSettings;
  pendingSettings = null;
  if (!patch) return;
  enqueue('budget/settings', (ref) => (settingsExist ? ref.update(patch) : ref.set(settingsOf(state))));
}

// update требует существующий документ, поэтому первая запись создаёт его через set.
async function upsert(ref, fields, exists) {
  try {
    await ref.update(fields);
  } catch (e) {
    if (e?.code !== 'invalid_argument' || exists) throw e;
    await ref.set(fields);
  }
}

function addTx(tx) {
  state.transactions.push(tx);
  if (!db) return saveLocal();
  const month = tx.date.slice(0, 7);
  enqueue('months/' + month, (ref) => upsert(ref, { items: { [tx.id]: tx } }, knownMonths.has(month)));
}

function setReport(month, fields, delay = 0) {
  state.reports[month] = { ...normalizeReport(state.reports[month]), ...fields };
  if (!db) return saveLocal();
  pendingReports[month] = { ...pendingReports[month], ...fields };
  clearTimeout(reportTimers[month]);
  reportTimers[month] = setTimeout(() => {
    const patch = pendingReports[month];
    delete pendingReports[month];
    enqueue('reports/' + month, (ref) => upsert(ref, patch, knownReports.has(month)));
  }, delay);
}

function deleteTx(tx) {
  state.transactions = state.transactions.filter((x) => x.id !== tx.id);
  if (!db) return saveLocal();
  enqueue('months/' + tx.date.slice(0, 7), (ref) => ref.update({ items: { [tx.id]: null } }));
}

async function replaceAll(data) {
  state = normalize(data);
  render();
  if (!db) return saveLocal();
  const byMonth = {};
  for (const t of state.transactions) (byMonth[t.date.slice(0, 7)] ??= {})[t.id] = t;
  const months = new Set([...knownMonths, ...Object.keys(byMonth)]);
  const reports = new Set([...knownReports, ...Object.keys(state.reports)]);
  await Promise.all([
    enqueue('budget/settings', (ref) => ref.set(settingsOf(state))),
    ...[...months].map((m) => enqueue('months/' + m, (ref) => (byMonth[m] ? ref.set({ items: byMonth[m] }) : ref.delete()))),
    ...[...reports].map((m) => enqueue('reports/' + m, (ref) => (state.reports[m] ? ref.set(state.reports[m]) : ref.delete()))),
  ]);
}

function hasLocalData(s) {
  return s && (s.transactions.length > 0 || s.members.length > 1 || s.monthlyBudget > 0);
}

function renderMigration() {
  const show = Boolean(db && canWrite && settingsLoaded && monthsLoaded && !settingsExist
    && knownMonths.size === 0 && hasLocalData(localCopy));
  $('migrateBanner').hidden = !show;
  if (show) {
    $('migrateText').textContent = `В этом браузере сохранены ваши прежние записи (операций: ${localCopy.transactions.length}). `
      + 'Перенести их в общий бюджет, чтобы их увидела вся семья?';
  }
}

function onSubscribeError(e) {
  if (e?.code === 'permission-denied') return showNoAccess();
  setStatus('Нет связи с общим бюджетом', 'bad');
}

// Общая база: Supabase (сайт на GitHub Pages) или хранилище claude.ai (артефакт).
async function connectShared() {
  if (window.SUPABASE_CONFIG?.url && window.FAMILY_EMAIL) return connectSupabase();
  if (!window.claude?.use) return;
  const shared = await window.claude.use('db');
  if (!shared) return;
  const user = await window.claude.use('user');
  const writable = !user || (await user.can('data.write')) !== false;
  attachShared(shared, writable);
}

function attachShared(shared, writable = true) {
  db = shared;
  localCopy = state;
  state = structuredClone(DEFAULT_STATE);
  setStatus('Подключаемся…');
  if (!writable) {
    canWrite = false;
    document.body.classList.add('read-only');
  }
  render();

  db.doc('budget/settings').onSnapshot((snap) => {
    settingsExist = snap.exists;
    Object.assign(state, settingsOf(normalize(snap.exists ? structuredClone(snap.data()) : {})));
    if (snap.exists && canWrite) upgradeCategories();
    if (pendingSettings) applySettings(pendingSettings); // ещё не отправленный ввод
    if (!snap.metadata.fromCache) settingsLoaded = true;
    render();
  }, onSubscribeError);

  db.collection('months').onSnapshot((snap) => {
    knownMonths = new Set(snap.docs.map((d) => d.id));
    state.transactions = snap.docs
      .flatMap((d) => Object.values(d.data()?.items || {}))
      .filter(isValidTx)
      .map((t) => ({ ...t }));
    if (!snap.metadata.fromCache) monthsLoaded = true;
    setStatus(canWrite ? 'Общий бюджет семьи' : 'Только просмотр', canWrite ? 'ok' : '');
    render();
  }, onSubscribeError);

  db.collection('reports').onSnapshot((snap) => {
    knownReports = new Set(snap.docs.map((d) => d.id));
    state.reports = {};
    for (const d of snap.docs) state.reports[d.id] = normalizeReport(d.data());
    for (const [m, patch] of Object.entries(pendingReports)) state.reports[m] = { ...normalizeReport(state.reports[m]), ...patch };
    render();
  }, onSubscribeError);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

function todayISO() {
  const d = new Date();
  return `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;
}

// Окно подтверждения внутри страницы: встроенные confirm()/alert() работают не везде.
// Возвращает 'ok', 'extra' или 'cancel'.
function openModal({ text, okLabel = 'OK', cancelLabel = 'Отмена', extraLabel = '', data = null, readonly = true }) {
  $('modalText').textContent = text;
  $('modalOk').textContent = okLabel;
  $('modalCancel').textContent = cancelLabel;
  $('modalExtra').textContent = extraLabel;
  $('modalExtra').hidden = !extraLabel;
  $('modalData').hidden = data === null;
  $('modalData').value = data ?? '';
  $('modalData').readOnly = readonly;
  $('modal').hidden = false;
  (data !== null && !readonly ? $('modalData') : $('modalOk')).focus();

  return new Promise((resolve) => {
    const close = (result) => {
      $('modal').hidden = true;
      $('modalOk').onclick = $('modalCancel').onclick = $('modalExtra').onclick = $('modal').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') close('cancel'); };
    $('modalOk').onclick = () => close('ok');
    $('modalCancel').onclick = () => close('cancel');
    $('modalExtra').onclick = () => close('extra');
    $('modal').onclick = (e) => { if (e.target === $('modal')) close('cancel'); };
    document.addEventListener('keydown', onKey);
  });
}

async function ask(text, okLabel = 'Удалить') {
  return (await openModal({ text, okLabel })) === 'ok';
}

let toastTimer;
function notify(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, textContent: label })));
  if (value !== undefined && options.some(([v]) => v === value)) select.value = value;
}

// ---------- Rendering ----------

const txLabel = (t) => (t.detail ? `${t.category}: ${t.detail}` : t.category);

// Из чего сложилось «Прочее»: [[пояснение, сумма], …] по убыванию суммы.
function otherBreakdown(expenses) {
  const other = expenses.filter((t) => t.category === OTHER);
  return Object.entries(sumBy(other.map((t) => ({ ...t, detail: t.detail || 'без пояснения' })), 'detail'))
    .sort((a, b) => b[1] - a[1]);
}

// Перевод между членами семьи касается и отправителя, и получателя.
const involves = (t, m) => t.member === m || (t.type === 'transfer' && t.to === m);

// Сколько денег прибавилось (или убыло) по операциям: у всей семьи (member = null)
// или у одного человека — тогда считаются и переводы ему и от него.
function netBalance(txs, member = null) {
  let sum = 0;
  for (const t of txs) {
    if (t.type === 'transfer') {
      if (member && t.to === member) sum += t.amount;
      if (member && t.member === member) sum -= t.amount;
    } else if (!member || t.member === member) {
      sum += t.type === 'income' ? t.amount : -t.amount;
    }
  }
  return sum;
}

function render({ settings = true } = {}) {
  const [y, m] = currentMonth.split('-').map(Number);
  $('monthLabel').textContent = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

  // пока общая база не загрузилась, список членов семьи ещё неполный
  if (sheet !== 'all' && !state.members.includes(sheet) && (!db || settingsLoaded)) sheet = 'all';
  const onMemberSheet = sheet !== 'all';
  const monthTx = state.transactions.filter(
    (t) => t.date.startsWith(currentMonth) && (!onMemberSheet || involves(t, sheet))
  );
  // Переводы внутри семьи не доходы и не расходы: для семьи они в сумме дают ноль,
  // а у отдельного человека меняют только остаток на руках.
  const income = monthTx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = monthTx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const transfers = monthTx.filter((t) => t.type === 'transfer');
  const received = onMemberSheet ? transfers.filter((t) => t.to === sheet).reduce((s, t) => s + t.amount, 0) : 0;
  const sent = onMemberSheet ? transfers.filter((t) => t.member === sheet).reduce((s, t) => s + t.amount, 0) : 0;
  const balance = income - expense + received - sent;
  const transferParts = [received && `получено ${fmt(received)}`, sent && `отдано ${fmt(sent)}`].filter(Boolean);
  $('transferNote').hidden = !transferParts.length;
  $('transferNote').textContent = 'с учётом переводов: ' + transferParts.join(', ');

  // Остаток переходит из месяца в месяц: всё, что осталось до начала этого месяца, плюс баланс месяца
  const carried = netBalance(state.transactions.filter((t) => t.date < currentMonth + '-01'), onMemberSheet ? sheet : null);
  const total = carried + balance;
  $('carryTotal').textContent = fmt(total);
  $('carryTotal').className = 'card-value ' + (total >= 0 ? 'income' : 'expense');
  $('carryNote').textContent = `с прошлых месяцев: ${carried > 0 ? '+' : carried < 0 ? '−' : ''}${fmt(Math.abs(carried))}`;

  $('totalIncome').textContent = fmt(income);
  $('totalExpense').textContent = fmt(expense);
  $('balance').textContent = fmt(balance);
  $('balance').className = 'card-value ' + (balance >= 0 ? 'income' : 'expense');

  $('memberPanel').hidden = onMemberSheet;
  $('budgetPanel').hidden = onMemberSheet;
  $('reportPanel').hidden = onMemberSheet;
  if (!onMemberSheet) renderReport();
  renderReminder();
  if (!onMemberSheet) renderBudget(expense);
  $('filterMember').hidden = onMemberSheet;

  renderTabs();
  renderFormSelects();
  renderCategoryChart(monthTx);
  renderMemberChart(monthTx);
  renderTxList(monthTx);
  // снимок из общей базы не должен пересоздавать поле, в котором сейчас печатают
  if (settings && !$('limitList').contains(document.activeElement)) renderSettings();
  renderMigration();
}

function renderBudget(spent) {
  const budget = state.monthlyBudget;
  const input = $('budgetInput');
  if (document.activeElement !== input) input.value = budget || '';

  if (!(budget > 0)) {
    $('budgetBody').replaceChildren(el('p', {
      className: 'muted',
      textContent: 'Укажите, сколько семья планирует потратить за месяц, — здесь появится остаток.',
    }));
    return;
  }

  const left = budget - spent;
  const ratio = spent / budget;
  const cls = ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : '';
  const stats = [
    ['Потрачено', `${fmt(spent)} (${Math.round(ratio * 100)}%)`, ''],
    [left >= 0 ? 'Осталось' : 'Перерасход', fmt(Math.abs(left)), left >= 0 ? 'income' : 'expense'],
  ];

  // «в день» имеет смысл только для текущего месяца
  const now = new Date();
  if (currentMonth === monthKey(now) && left > 0) {
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - now.getDate() + 1;
    stats.push([`В день (ещё ${daysLeft} дн.)`, fmt(Math.floor(left / daysLeft)), '']);
  }

  $('budgetBody').replaceChildren(
    el('div', { className: 'bar-track budget-track' },
      el('div', { className: 'bar-fill ' + cls, style: `width:${Math.min(100, ratio * 100)}%` })),
    el('div', { className: 'budget-stats' },
      ...stats.map(([label, value, c]) => el('div', {},
        el('span', { textContent: label }), el('b', { className: c, textContent: value }))))
  );
}

// ---------- Supabase ----------
// Настройки проекта лежат в config.js. У семьи один общий аккаунт Supabase, его пароль —
// PIN-код. PIN проверяет Supabase (и ограничивает число попыток), а к таблице пускает
// только этот аккаунт (правила в supabase.sql).
// Все документы лежат в одной таблице budget_docs: path ('months/2026-09') → data (jsonb).

const SUPABASE_SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
const TABLE = 'budget_docs';

function deepMerge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}

// Переходник: таблица Supabase с тем же набором вызовов, что и у общей базы claude.ai.
function supabaseAdapter(client) {
  const docs = new Map();
  const listeners = new Set();
  const errorHandlers = new Set();
  let loaded = false;
  const emit = () => { if (loaded) listeners.forEach((f) => f()); };
  const snap = (path) => ({
    id: path.split('/').pop(), exists: docs.has(path), data: () => docs.get(path),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  const failure = (error) => ({ code: error.code === '42501' ? 'permission-denied' : 'unavailable', message: error.message });

  async function load() {
    const { data, error } = await client.from(TABLE).select('path, data');
    if (error) return errorHandlers.forEach((h) => h(failure(error)));
    docs.clear();
    for (const row of data) docs.set(row.path, row.data);
    loaded = true;
    emit();
  }

  // Ответ сервера об ошибке: перечитываем таблицу, чтобы убрать неудавшуюся правку с экрана.
  async function check(request) {
    const { error } = await request;
    if (error) {
      load();
      throw failure(error);
    }
  }

  client.channel('budget')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (change) => {
      if (change.eventType === 'DELETE') docs.delete(change.old.path);
      else docs.set(change.new.path, change.new.data);
      emit();
    })
    .subscribe((status) => { if (status === 'SUBSCRIBED') load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();

  const subscribe = (f, error) => {
    listeners.add(f);
    if (error) errorHandlers.add(error);
    if (loaded) f();
    return () => { listeners.delete(f); errorHandlers.delete(error); };
  };

  return {
    doc(path) {
      return {
        set(data) {
          docs.set(path, data);
          emit();
          return check(client.from(TABLE).upsert({ path, data }));
        },
        // Слияние делает сервер (merge_doc), чтобы одновременные правки не затирали друг друга.
        update(data) {
          docs.set(path, deepMerge(docs.get(path) || {}, data));
          emit();
          return check(client.rpc('merge_doc', { p_path: path, p_patch: data }));
        },
        delete() {
          docs.delete(path);
          emit();
          return check(client.from(TABLE).delete().eq('path', path));
        },
        onSnapshot: (next, error) => subscribe(() => next(snap(path)), error),
      };
    },
    collection(prefix) {
      return {
        onSnapshot: (next, error) => subscribe(() => {
          const list = [...docs.keys()]
            .filter((k) => k.startsWith(prefix + '/') && !k.slice(prefix.length + 1).includes('/'))
            .sort()
            .map(snap);
          next({ docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false } });
        }, error),
      };
    },
  };
}

function showAuth(text, { signIn = false, signOut = false } = {}) {
  $('authPanel').hidden = false;
  $('authText').textContent = text;
  $('pinForm').hidden = !signIn;
  $('signOutBtn').hidden = !signOut;
  if (signIn) $('pinInput').focus();
}

function showNoAccess() {
  document.body.classList.add('needs-login');
  setStatus('Нет доступа', 'bad');
  showAuth('Нет доступа к семейному бюджету. Выйдите и введите PIN-код заново.', { signOut: true });
}

function pinError(error) {
  if (error?.status === 429 || error?.code === 'over_request_rate_limit') {
    return 'Слишком много попыток. Подождите несколько минут и попробуйте снова.';
  }
  if (error?.code === 'invalid_credentials' || error?.status === 400) return 'Неверный PIN-код.';
  return 'Не удалось войти. Проверьте интернет и попробуйте ещё раз.';
}

async function connectSupabase() {
  let createClient;
  try {
    ({ createClient } = await import(SUPABASE_SDK));
  } catch {
    setStatus('Общая база недоступна, данные сохраняются только здесь', 'bad');
    return;
  }
  const { url, key } = window.SUPABASE_CONFIG;
  const client = createClient(url, key);

  $('pinForm').onsubmit = async (e) => {
    e.preventDefault();
    const button = $('pinForm').querySelector('button');
    button.disabled = true;
    try {
      const { error } = await client.auth.signInWithPassword({ email: window.FAMILY_EMAIL, password: $('pinInput').value.trim() });
      if (error) {
        $('pinInput').select();
        notify(pinError(error));
      } else {
        $('pinInput').value = '';
      }
    } catch (err) {
      notify(pinError(err));
    } finally {
      button.disabled = false;
    }
  };
  $('signOutBtn').onclick = $('logoutBtn').onclick = () => client.auth.signOut().then(() => location.reload());

  document.body.classList.add('needs-login');
  client.auth.onAuthStateChange((event, session) => {
    // Вызовы Supabase внутри этого обработчика могут зависнуть, поэтому подключаемся после него.
    setTimeout(() => {
      if (!session) {
        setStatus('');
        showAuth('Введите семейный PIN-код. На этом устройстве его нужно ввести только один раз.', { signIn: true });
        return;
      }
      document.body.classList.remove('needs-login');
      $('authPanel').hidden = true;
      $('logoutBtn').hidden = false;
      if (!db) attachShared(supabaseAdapter(client));
    });
  });
}

// ---------- Итоги месяца ----------

const monthName = (key, opts = { month: 'long', year: 'numeric' }) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('ru-RU', opts).replace(' г.', '');
};

function monthStats(month) {
  const txs = state.transactions.filter((t) => t.date.startsWith(month));
  const expenses = txs.filter((t) => t.type === 'expense');
  const income = txs.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = expenses.reduce((s, t) => s + t.amount, 0);
  return { txs, expenses, income, expense, byCat: sumBy(expenses, 'category'), byMember: sumBy(expenses, 'member') };
}

function daysCounted(month) {
  const [y, m] = month.split('-').map(Number);
  const now = new Date();
  if (month === monthKey(now)) return now.getDate();
  return new Date(y, m, 0).getDate();
}

const pct = (x) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;
const shortDate = (iso) => new Date(iso + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

function stat(label, value, note = '', cls = '') {
  return el('div', { className: 'stat' },
    el('span', { textContent: label }), el('b', { className: cls, textContent: value }), el('small', { textContent: note }));
}

function renderReport() {
  const cur = monthStats(currentMonth);
  const prev = monthStats(shiftMonth(currentMonth, -1));
  $('reportTitle').textContent = 'Итоги: ' + monthName(currentMonth);

  const saved = cur.income - cur.expense;
  const tiles = [
    stat(saved >= 0 ? 'Отложено' : 'Потрачено больше дохода', fmt(Math.abs(saved)),
      cur.income > 0 ? `${Math.round((saved / cur.income) * 100)}% от дохода` : 'доходов нет', saved >= 0 ? 'income' : 'expense'),
    prev.expense > 0
      ? stat('Расходы к прошлому месяцу', pct(cur.expense / prev.expense - 1), `было ${fmt(prev.expense)}`,
        cur.expense > prev.expense ? 'expense' : 'income')
      : stat('Расходы к прошлому месяцу', '—', 'за прошлый месяц нет данных'),
    stat('В среднем в день', fmt(Math.round(cur.expense / daysCounted(currentMonth))), `дней: ${daysCounted(currentMonth)}`),
  ];
  if (state.monthlyBudget > 0) {
    const left = state.monthlyBudget - cur.expense;
    tiles.push(stat('Общий бюджет', left >= 0 ? 'Уложились' : 'Превышен',
      left >= 0 ? `осталось ${fmt(left)}` : `на ${fmt(-left)}`, left >= 0 ? 'income' : 'expense'));
  }
  $('reportStats').replaceChildren(...tiles);

  const facts = [];
  if (!cur.txs.length) facts.push('Операций за этот месяц пока нет.');
  const topCats = Object.entries(cur.byCat).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [c, v] of topCats) {
    const before = prev.byCat[c] || 0;
    let change = ', в прошлом месяце не было';
    if (before && v === before) change = ', как в прошлом месяце';
    else if (before) change = `, ${v > before ? '+' : '−'}${fmt(Math.abs(v - before))} к прошлому месяцу`;
    facts.push(`${c}: ${fmt(v)} (${Math.round((v / cur.expense) * 100)}% расходов)${change}`);
  }
  const otherParts = otherBreakdown(cur.expenses);
  if (otherParts.length) {
    const shown = otherParts.slice(0, 4).map(([d, v]) => `${d} ${fmt(v)}`).join(', ');
    facts.push(`«Прочее» — это: ${shown}${otherParts.length > 4 ? ` и ещё ${otherParts.length - 4}` : ''}`);
  }
  const over = Object.entries(state.limits).filter(([c, lim]) => (cur.byCat[c] || 0) > lim);
  if (over.length) facts.push('Превышен лимит: ' + over.map(([c, lim]) => `${c} (${fmt(cur.byCat[c])} из ${fmt(lim)})`).join(', '));
  const biggest = [...cur.expenses].sort((a, b) => b.amount - a.amount)[0];
  if (biggest) {
    facts.push(`Самая крупная трата: ${fmt(biggest.amount)}, ${[txLabel(biggest), biggest.member, shortDate(biggest.date), biggest.note].filter(Boolean).join(', ')}`);
  }
  const members = Object.entries(cur.byMember).sort((a, b) => b[1] - a[1]);
  if (members.length > 1) {
    facts.push('Расходы по людям: ' + members.map(([m, v]) => `${m} ${Math.round((v / cur.expense) * 100)}%`).join(', '));
  }
  $('reportFacts').replaceChildren(...facts.map((f) => el('li', { textContent: f })));

  renderTrend();
  renderAi();

  const report = normalizeReport(state.reports[currentMonth]);
  if (document.activeElement !== $('notesInput')) $('notesInput').value = report.notes;
  $('notesInput').readOnly = !canWrite;
}

function renderTrend() {
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(currentMonth, i - 5));
  const data = months.map((m) => ({ m, ...monthStats(m) }));
  const max = Math.max(1, ...data.flatMap((d) => [d.income, d.expense]));
  const describe = (d) => `${monthName(d.m)}: доходы ${fmt(d.income)}, расходы ${fmt(d.expense)}`;

  $('trendChart').replaceChildren(...data.map((d) => {
    const col = el('button', {
      className: 'trend-col' + (d.m === currentMonth ? ' current' : ''),
      title: describe(d),
      ariaLabel: describe(d),
    },
    el('div', { className: 'trend-bars' },
      el('i', { className: 'inc', style: `height:${(d.income / max) * 100}%` }),
      el('i', { className: 'exp', style: `height:${(d.expense / max) * 100}%` })),
    el('span', { textContent: monthName(d.m, { month: 'short' }).replace('.', '') }));
    const show = () => { $('trendCaption').textContent = describe(d); };
    col.addEventListener('mouseenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('mouseleave', () => { $('trendCaption').textContent = describe(data[5]); });
    col.addEventListener('click', () => { currentMonth = d.m; render(); });
    return col;
  }));
  $('trendCaption').textContent = describe(data[5]) + '. Нажмите на месяц, чтобы открыть его итоги.';
}

function renderReminder() {
  // В первые 10 дней месяца напоминаем подвести итоги прошлого, если их ещё нет
  const now = new Date();
  const prev = shiftMonth(monthKey(now), -1);
  const report = normalizeReport(state.reports[prev]);
  const show = canWrite && now.getDate() <= 10 && currentMonth !== prev && (!db || settingsLoaded)
    && state.transactions.some((t) => t.date.startsWith(prev)) && !report.notes && !report.ai;
  $('reportReminder').hidden = !show;
  if (show) {
    const name = monthName(prev, { month: 'long' });
    $('reminderText').textContent = `${name[0].toUpperCase() + name.slice(1)} закончился. Подведите итоги месяца всей семьёй.`;
  }
}

// ---------- Анализ Claude ----------

let sampleFn = null;
let aiController = null;

function renderAi() {
  if (aiController) return; // идёт анализ — текст обновляется по мере ответа
  const report = normalizeReport(state.reports[currentMonth]);
  const hasData = state.transactions.some((t) => t.date.startsWith(currentMonth));
  $('aiText').textContent = report.ai;
  $('aiBtn').hidden = !sampleFn || !canWrite;
  $('aiBtn').disabled = !hasData;
  $('aiBtn').textContent = report.ai ? 'Обновить анализ' : 'Сделать анализ';
  $('aiStop').hidden = true;
  if (report.ai) $('aiMeta').textContent = `Анализ от ${shortDate(report.aiAt || todayISO())}`;
  else if (!sampleFn) $('aiMeta').textContent = 'Анализ Claude доступен, когда страница открыта на claude.ai.';
  else $('aiMeta').textContent = hasData ? 'Claude разберёт месяц и даст советы. Анализ увидит вся семья.' : 'Добавьте операции, чтобы сделать анализ.';
}

const transfersOf = (month) => state.transactions
  .filter((t) => t.type === 'transfer' && t.date.startsWith(month))
  .map((t) => `- ${t.date}, ${t.member} → ${t.to}, ${t.amount}${t.note ? `, «${t.note}»` : ''}`);

function buildPrompt(month) {
  const cur = monthStats(month);
  const prev = monthStats(shiftMonth(month, -1));
  const months6 = Array.from({ length: 6 }, (_, i) => monthStats(shiftMonth(month, i - 6))).filter((m) => m.txs.length);
  const avg = (k) => (months6.length ? Math.round(months6.reduce((s, m) => s + m[k], 0) / months6.length) : null);
  const cats = [...new Set([...Object.keys(cur.byCat), ...Object.keys(prev.byCat)])]
    .sort((a, b) => (cur.byCat[b] || 0) - (cur.byCat[a] || 0))
    .map((c) => `- ${c}: ${cur.byCat[c] || 0} (прошлый месяц ${prev.byCat[c] || 0}${state.limits[c] ? `, лимит ${state.limits[c]}` : ''})`);
  const incomeByCat = Object.entries(sumBy(cur.txs.filter((t) => t.type === 'income'), 'category')).map(([c, v]) => `- ${c}: ${v}`);
  const members = Object.entries(cur.byMember).map(([m, v]) => `- ${m}: ${v}`);
  const top = [...cur.expenses].sort((a, b) => b.amount - a.amount).slice(0, 10)
    .map((t) => `- ${t.date}, ${txLabel(t)}, ${t.member}, ${t.amount}${t.note ? `, «${t.note}»` : ''}`);
  const other = otherBreakdown(cur.expenses).map(([d, v]) => `- ${d}: ${v}`);

  return [
    'Ты помогаешь семье подвести итоги месяца по семейному бюджету.',
    `Месяц: ${monthName(month)}. Валюта: ${CURRENCY}. Учтено дней: ${daysCounted(month)}.`,
    `Доходы: ${cur.income}. Расходы: ${cur.expense}. Баланс месяца: ${cur.income - cur.expense}.`,
    `Остаток с прошлых месяцев: ${netBalance(state.transactions.filter((t) => t.date < month + '-01'))}. `
      + `Остаток денег на конец месяца: ${netBalance(state.transactions.filter((t) => t.date < shiftMonth(month, 1) + '-01'))}.`,
    state.monthlyBudget ? `Плановый бюджет расходов на месяц: ${state.monthlyBudget}.` : 'Плановый бюджет не задан.',
    `Прошлый месяц: доходы ${prev.income}, расходы ${prev.expense}.`,
    avg('expense') !== null ? `Средние расходы за предыдущие месяцы: ${avg('expense')}, средние доходы: ${avg('income')}.` : '',
    '', 'Расходы по категориям (этот месяц, в скобках прошлый месяц и лимит):', ...cats,
    '', 'Из чего сложилась категория «Прочее»:', ...(other.length ? other : ['- нет']),
    '', 'Доходы по категориям:', ...(incomeByCat.length ? incomeByCat : ['- нет']),
    '', 'Расходы по членам семьи:', ...(members.length ? members : ['- нет']),
    '', 'Самые крупные траты:', ...(top.length ? top : ['- нет']),
    '', 'Переводы денег между членами семьи (это не доходы и не расходы семьи):',
    ...(transfersOf(month).length ? transfersOf(month) : ['- нет']),
    '',
    'Напиши итог месяца на русском языке, просто и дружелюбно, для всей семьи. Без markdown: без звёздочек, решёток и таблиц.',
    'Структура (заголовки как обычный текст на отдельной строке):',
    'Итог — 2–3 предложения с главными цифрами.',
    'Что получилось — 2–3 пункта.',
    'На что обратить внимание — 2–3 пункта.',
    'Советы на следующий месяц — 3 конкретных пункта с суммами.',
    'Если в «Прочее» есть повторяющиеся или крупные траты, посоветуй завести для них отдельную категорию.',
    'Каждый пункт начинай с «• ». Опирайся только на эти данные и ничего не выдумывай. Не больше 220 слов.',
  ].filter((line) => line !== null).join('\n');
}

const AI_ERRORS = {
  rate_limited: 'Слишком много запросов или исчерпан лимит Claude. Попробуйте позже.',
  session_expired: 'Войдите в claude.ai заново и повторите.',
  refused: 'Claude не смог сделать анализ по этим данным.',
  prompt_too_large: 'Слишком много данных для анализа за один раз.',
};
const AI_HIDE = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];

async function runAnalysis() {
  const month = currentMonth;
  aiController = new AbortController();
  $('aiBtn').hidden = true;
  $('aiStop').hidden = false;
  $('aiText').textContent = '';
  $('aiMeta').textContent = 'Claude думает… это может занять до минуты.';
  try {
    const { text } = await sampleFn(buildPrompt(month), {
      signal: aiController.signal,
      cache: false,
      onText: ({ text: soFar }) => {
        if (currentMonth === month) $('aiText').textContent = soFar;
        $('aiMeta').textContent = 'Claude пишет…';
      },
    });
    aiController = null;
    setReport(month, { ai: text.trim(), aiAt: todayISO() });
  } catch (e) {
    aiController = null;
    if (AI_HIDE.includes(e?.code)) sampleFn = null;
    else if (e?.code !== 'cancelled') notify(AI_ERRORS[e?.code] || 'Не удалось получить анализ. Попробуйте ещё раз.');
  }
  render();
}

async function connectSample() {
  if (!window.claude?.use) return;
  sampleFn = await window.claude.use('sample');
  render();
}

function renderTabs() {
  const sheets = [['all', '👨‍👩‍👧 Вся семья'], ...state.members.map((m) => [m, m])];
  $('tabs').replaceChildren(...sheets.map(([value, label]) => {
    const tab = el('button', { className: 'tab' + (sheet === value ? ' active' : ''), textContent: label });
    tab.addEventListener('click', () => {
      sheet = value;
      saveSheet();
      render();
    });
    return tab;
  }));
}

function renderFormSelects() {
  const type = document.querySelector('input[name="type"]:checked').value;
  const isTransfer = type === 'transfer';
  const cats = type === 'income' ? state.incomeCategories : state.expenseCategories;
  fillSelect($('category'), cats.map((c) => [c, c]), $('category').value);
  $('category').hidden = isTransfer;
  $('category').required = !isTransfer;

  // «Прочее» просим расшифровать: так итоги и анализ показывают, на что ушли деньги
  const isOther = !isTransfer && $('category').value === OTHER;
  $('otherInput').hidden = !isOther;
  $('otherInput').required = isOther;
  const used = [...new Set(state.transactions
    .filter((t) => t.type === type && t.detail)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((t) => t.detail))].slice(0, 30);
  $('otherList').replaceChildren(...used.map((d) => el('option', { value: d })));

  // На личном листе расход и доход — всегда этого человека. Для перевода «от кого» и «кому»
  // выбирают сами; выбор не сбрасываем, чтобы на листе Мамы можно было записать «Папа → Мама».
  const who = isTransfer ? 'От кого: ' : '';
  const from = sheet !== 'all' && !isTransfer ? sheet : $('member').value;
  fillSelect($('member'), state.members.map((m) => [m, who + m]), from);
  $('member').hidden = sheet !== 'all' && !isTransfer;

  const others = state.members.filter((m) => m !== $('member').value);
  let to = $('toMember').value;
  if (!others.includes(to)) {
    // по умолчанию: деньги пришли владельцу листа, иначе — первому, кто не «Общее»
    to = sheet !== 'all' && others.includes(sheet) ? sheet : others.find((m) => m !== 'Общее') || others[0];
  }
  fillSelect($('toMember'), others.map((m) => [m, 'Кому: ' + m]), to);
  $('toMember').hidden = !isTransfer;
  $('toMember').required = isTransfer;
  fillSelect(
    $('filterMember'),
    [['all', 'Все члены семьи'], ...state.members.map((m) => [m, m])],
    $('filterMember').value
  );
}

function barRow(label, valueText, ratio, cls = '') {
  return el('div', { className: 'bar-row' },
    el('div', { className: 'bar-top' }, el('span', { textContent: label }), el('span', { textContent: valueText })),
    el('div', { className: 'bar-track' },
      el('div', { className: 'bar-fill ' + cls, style: `width:${Math.min(100, ratio * 100)}%` }))
  );
}

function sumBy(txs, key) {
  const map = {};
  for (const t of txs) map[t[key]] = (map[t[key]] || 0) + t.amount;
  return map;
}

function renderCategoryChart(monthTx) {
  const byCat = sumBy(monthTx.filter((t) => t.type === 'expense'), 'category');
  // лимиты общие на семью, поэтому показываем их только на листе «Вся семья»
  const limits = sheet === 'all' ? state.limits : {};
  const cats = [...new Set([...Object.keys(byCat), ...Object.keys(limits).filter((c) => limits[c] > 0)])];
  const max = Math.max(1, ...cats.map((c) => Math.max(byCat[c] || 0, limits[c] || 0)));

  const rows = cats
    .sort((a, b) => (byCat[b] || 0) - (byCat[a] || 0))
    .map((c) => {
      const spent = byCat[c] || 0;
      const limit = limits[c];
      if (limit > 0) {
        const r = spent / limit;
        const cls = r > 1 ? 'over' : r >= 0.8 ? 'near' : '';
        return barRow(c, `${fmt(spent)} / ${fmt(limit)}`, r, cls);
      }
      return barRow(c, fmt(spent), spent / max);
    });

  $('categoryChart').replaceChildren(...(rows.length ? rows : [el('p', { className: 'muted', textContent: 'Нет расходов.' })]));
}

function renderMemberChart(monthTx) {
  const byMember = sumBy(monthTx.filter((t) => t.type === 'expense'), 'member');
  const entries = Object.entries(byMember).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const rows = entries.map(([m, v]) => barRow(m, `${fmt(v)} (${Math.round((v / total) * 100)}%)`, v / total));
  $('memberChart').replaceChildren(...(rows.length ? rows : [el('p', { className: 'muted', textContent: 'Нет расходов.' })]));
}

function renderTxList(monthTx) {
  const type = $('filterType').value;
  const member = $('filterMember').value;
  const list = monthTx
    .filter((t) => (type === 'all' || t.type === type) && (member === 'all' || involves(t, member)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  $('txList').replaceChildren(...list.map((t) => {
    const date = new Date(t.date + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const isTransfer = t.type === 'transfer';
    const meta = [date, isTransfer ? '' : t.member, t.note].filter(Boolean).join(' · ');
    // Перевод на листе человека — плюс или минус для него, на общем листе — нейтральный.
    let sign = t.type === 'income' ? '+' : '−';
    let cls = t.type;
    if (isTransfer) {
      const side = sheet !== 'all' ? sheet : $('filterMember').value;
      if (side === t.to) [sign, cls] = ['+', 'income'];
      else if (side === t.member) [sign, cls] = ['−', 'expense'];
      else [sign, cls] = ['', 'transfer'];
    }
    const del = el('button', { className: 'del-btn', textContent: '✕', title: 'Удалить' });
    del.addEventListener('click', async () => {
      if (!(await ask('Удалить эту операцию?'))) return;
      deleteTx(t);
      render();
    });
    return el('li', {},
      el('div', { className: 'tx-main' },
        el('div', { className: 'tx-title', textContent: isTransfer ? `Перевод: ${t.member} → ${t.to || '? (удалите и запишите заново)'}` : txLabel(t) }),
        el('div', { className: 'tx-meta', textContent: meta })),
      el('span', { className: 'tx-amount ' + cls, textContent: sign + fmt(t.amount) }),
      del
    );
  }));
  $('emptyMsg').hidden = list.length > 0;
}

function renderSettings() {
  $('memberList').replaceChildren(...state.members.map((m) => {
    const btn = el('button', { textContent: '✕', title: 'Удалить' });
    btn.addEventListener('click', async () => {
      if (state.members.length <= 1) return notify('Должен остаться хотя бы один член семьи.');
      if (!(await ask(`Удалить «${m}» и его лист? Операции останутся на листе «Вся семья».`))) return;
      setSettings({ members: state.members.filter((x) => x !== m) });
      render();
    });
    return el('li', {}, el('span', { textContent: m }), btn);
  }));

  $('limitList').replaceChildren(...state.expenseCategories.map((c) => {
    const input = el('input', { type: 'number', min: '0', step: '100', placeholder: 'Без лимита', value: state.limits[c] || '' });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      setSettings({ limits: { [c]: v > 0 ? v : 0 } }, 800);
      // не перерисовываем настройки, иначе поле ввода удаляется, пока в фокусе
      render({ settings: false });
    });
    const del = el('button', { textContent: '✕', title: 'Удалить категорию' });
    del.addEventListener('click', async () => {
      if (state.expenseCategories.length <= 1) return notify('Должна остаться хотя бы одна категория.');
      if (!(await ask(`Удалить категорию «${c}»? Операции останутся.`))) return;
      setSettings({ expenseCategories: state.expenseCategories.filter((x) => x !== c), limits: { [c]: 0 } });
      render();
    });
    return el('div', { className: 'limit-row' }, el('span', { textContent: c }), input, del);
  }));
}

// ---------- Events ----------

$('prevMonth').addEventListener('click', () => { currentMonth = shiftMonth(currentMonth, -1); render(); });
$('nextMonth').addEventListener('click', () => { currentMonth = shiftMonth(currentMonth, 1); render(); });

document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', renderFormSelects));
$('member').addEventListener('change', renderFormSelects);
$('category').addEventListener('change', renderFormSelects);
$('filterType').addEventListener('change', render);

$('budgetInput').addEventListener('input', () => {
  const v = parseFloat($('budgetInput').value);
  setSettings({ monthlyBudget: v > 0 ? v : 0 }, 800);
  render({ settings: false });
});
$('filterMember').addEventListener('change', render);

$('txForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = parseFloat($('amount').value);
  if (!(amount > 0)) return;
  const type = document.querySelector('input[name="type"]:checked').value;
  const tx = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    amount: Math.round(amount * 100) / 100,
    category: type === 'transfer' ? 'Перевод' : $('category').value,
    ...(type !== 'transfer' && $('category').value === OTHER ? { detail: $('otherInput').value.trim() } : {}),
    member: $('member').value,
    date: $('date').value,
    note: $('note').value.trim(),
  };
  if (type === 'transfer') {
    tx.to = $('toMember').value;
    if (!tx.to || tx.to === tx.member) return notify('Выберите, кому переводите деньги.');
  }
  addTx(tx);
  currentMonth = tx.date.slice(0, 7);
  $('amount').value = '';
  $('note').value = '';
  $('otherInput').value = '';
  render();
  $('amount').focus();
});

$('memberForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('memberName').value.trim();
  if (name && !state.members.includes(name)) {
    setSettings({ members: [...state.members, name] });
    render();
  }
  $('memberName').value = '';
});

$('categoryForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('categoryName').value.trim();
  if (name && !state.expenseCategories.includes(name)) {
    setSettings({ expenseCategories: [...state.expenseCategories, name] });
    render();
  }
  $('categoryName').value = '';
});

function downloadJSON(json) {
  const a = el('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `budget-${todayISO()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function importData(json) {
  const data = JSON.parse(json);
  if (!data || !Array.isArray(data.transactions)) throw new Error('bad format');
  replaceAll(data);
  notify(`Загружено операций: ${state.transactions.length}.`);
}

const BAD_IMPORT = 'Не получилось прочитать данные. Нужен текст или файл, сохранённый через «Экспорт».';

// Экспорт показывает данные текстом: скачивание файлов разрешено не на каждом хостинге.
$('exportBtn').addEventListener('click', async () => {
  const json = JSON.stringify(state, null, 2);
  const result = await openModal({
    text: 'Скопируйте эти данные и сохраните их, например, в заметках. Потом их можно загрузить через «Импорт».',
    okLabel: 'Копировать', cancelLabel: 'Закрыть', extraLabel: 'Скачать файл', data: json,
  });
  if (result === 'extra') downloadJSON(json);
  if (result === 'ok') {
    if (await copyText(json)) notify('Данные скопированы.');
    else notify('Скопировать не вышло. Выделите текст в окне экспорта и скопируйте вручную.');
  }
});

$('importBtn').addEventListener('click', async () => {
  const result = await openModal({
    text: 'Вставьте данные, скопированные через «Экспорт», или выберите файл. Текущие данные будут заменены.',
    okLabel: 'Загрузить', extraLabel: 'Выбрать файл', data: '', readonly: false,
  });
  if (result === 'extra') return $('importInput').click();
  if (result !== 'ok') return;
  try {
    importData($('modalData').value);
  } catch {
    notify(BAD_IMPORT);
  }
});

$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    importData(await file.text());
  } catch {
    notify(BAD_IMPORT);
  } finally {
    e.target.value = '';
  }
});

$('resetBtn').addEventListener('click', async () => {
  if (!(await ask('Удалить все операции и настройки? Это нельзя отменить.', 'Удалить всё'))) return;
  replaceAll(DEFAULT_STATE);
});

$('notesInput').addEventListener('input', () => {
  setReport(currentMonth, { notes: $('notesInput').value }, 800);
});

$('reminderBtn').addEventListener('click', () => {
  currentMonth = shiftMonth(monthKey(new Date()), -1);
  render();
  $('reportPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('aiBtn').addEventListener('click', runAnalysis);
$('aiStop').addEventListener('click', () => aiController?.abort());

$('migrateBtn').addEventListener('click', async () => {
  const data = localCopy;
  localCopy = null;
  await replaceAll(data);
  notify('Записи перенесены в общий бюджет.');
});

$('date').value = todayISO();
upgradeCategories();
render();
connectShared();
connectSample();
