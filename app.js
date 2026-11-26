const $ = (id) => document.getElementById(id);
const DEMO_KEY = 'svyaz-gryaz-demo-v1';
const DEMO_SESSION_KEY = 'svyaz-gryaz-demo-session';
const SUPABASE_MODULE = './vendor/supabase-js.mjs';
const OFFLINE_DB_NAME = 'svyaz-gryaz-offline-v1';
const state = {
  backend: 'demo',
  mode: 'demo',
  client: null,
  networkDegraded: false,
  pendingCount: 0,
  flushingOutbox: false,
  retryTimer: null,
  draftTimer: null,
  user: null,
  profile: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  sideTab: 'chats',
  search: '',
  activeFriend: null,
  activeConversationId: null,
  messages: [],
  channel: null,
  pendingFile: null,
  recorder: null,
  mediaStream: null,
  discardRecording: false,
  pushSubscription: null,
  installPrompt: null
};

let offlineDBPromise = null;
function openOfflineDB() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB недоступна'));
  if (offlineDBPromise) return offlineDBPromise;
  offlineDBPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'id' });
        store.createIndex('user_id', 'user_id', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Не удалось открыть локальное хранилище'));
  }).catch(error => {
    offlineDBPromise = null;
    throw error;
  });
  return offlineDBPromise;
}
function idbRequest(storeName, buildRequest) {
  return openOfflineDB().then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const request = buildRequest(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Локальное хранилище недоступно'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('Ошибка локального хранилища'));
    transaction.onabort = () => reject(transaction.error || new Error('Операция с локальным хранилищем отменена'));
  }));
}
async function cacheGet(key) {
  try {
    const item = await idbRequest('cache', store => store.get(key));
    return item?.value ?? null;
  } catch (error) {
    console.warn('Offline cache read failed', error);
    return null;
  }
}
async function cacheSet(key, value) {
  try {
    await idbRequest('cache', store => store.put({ key, value, updated_at: Date.now() }));
    return true;
  } catch (error) {
    console.warn('Offline cache write failed', error);
    return false;
  }
}
async function cacheDelete(key) {
  try { await idbRequest('cache', store => store.delete(key)); return true; }
  catch (error) { console.warn('Offline cache delete failed', error); return false; }
}
async function outboxPut(item) {
  try {
    await idbRequest('outbox', store => store.put(item));
    return true;
  } catch (error) {
    console.error('Could not persist outgoing message', error);
    showToast('Не удалось сохранить сообщение на устройстве. Освободи место и попробуй ещё раз.', 'error');
    return false;
  }
}
async function outboxDelete(id) {
  try { await idbRequest('outbox', store => store.delete(id)); return true; }
  catch (error) { console.warn('Could not remove synced item from outbox', error); return false; }
}
async function outboxGetAll() {
  try { return await idbRequest('outbox', store => store.getAll()) || []; }
  catch (error) { console.warn('Could not read outbox', error); return []; }
}
function estimateRequestBodySize(body) {
  try {
    if (body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      let total = 0;
      for (const value of body.values()) if (value instanceof Blob) total += value.size;
      return total;
    }
  } catch { /* unknown or streamed body */ }
  return 0;
}
function networkFetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const bodySize = estimateRequestBodySize(init.body);
  const timeoutMs = bodySize ? Math.min(180000, Math.max(60000, Math.ceil(bodySize / 80))) : 15000;
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'AbortError')), timeoutMs);
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal) {
    if (init.signal.aborted) abortFromCaller();
    else init.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    window.clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abortFromCaller);
  });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
function getInitials(name = 'С') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(part => Array.from(part)[0] || '').join('').toUpperCase() || 'С';
}
function setAvatar(element, profile, fallbackName = 'С') {
  if (!element) return;
  const name = profile?.nickname || profile?.username || fallbackName;
  if (profile?.avatar_url) {
    element.innerHTML = `<img src="${escapeHtml(profile.avatar_url)}" alt="Аватар ${escapeHtml(name)}">`;
    element.setAttribute('aria-label', `Аватар: ${name}`);
  } else {
    element.textContent = getInitials(name);
    element.setAttribute('aria-label', `Аватар: ${name}`);
  }
}
function avatarMarkup(profile, className = 'avatar') {
  const name = profile?.nickname || profile?.username || 'С';
  if (profile?.avatar_url) {
    return `<span class="${className}"><img src="${escapeHtml(profile.avatar_url)}" alt=""></span>`;
  }
  return `<span class="${className}">${escapeHtml(getInitials(name))}</span>`;
}
function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}
function generateFriendCode(existing = []) {
  const used = new Set(existing.map(item => item.friend_code || item));
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let tries = 0; tries < 10000; tries++) {
    const code = `${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}${letters[Math.floor(Math.random() * 26)]}${letters[Math.floor(Math.random() * 26)]}`;
    if (!used.has(code)) return code;
  }
  return `${String(Date.now() % 10000).padStart(4, '0')}zz`;
}
function loginAlias(username) {
  return `${String(username).toLowerCase()}@login.svyaz.invalid`;
}
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
function formatFileSize(bytes = 0) {
  if (!Number(bytes)) return 'файл';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 0 : 1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
function showToast(message, type = '') {
  const region = $('toastRegion');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`.trim();
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3800);
}
function connectionQualityIsPoor() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;
  return Boolean(['slow-2g', '2g'].includes(connection.effectiveType) || connection.rtt > 1200 || (connection.downlink > 0 && connection.downlink < 0.35));
}
function updateConnectionUI() {
  const offline = !navigator.onLine;
  const weak = !offline && (state.networkDegraded || connectionQualityIsPoor());
  const status = offline ? 'offline' : weak ? 'weak' : 'online';
  const text = offline ? 'Нет сети' : weak ? 'Слабая сеть' : state.pendingCount ? 'Синхронизация' : 'В сети';
  const sidebar = $('networkStatusSidebar');
  const chat = $('networkStatusChat');
  for (const element of [sidebar, chat]) {
    if (!element) continue;
    element.classList.toggle('is-offline', status === 'offline');
    element.classList.toggle('is-weak', status === 'weak');
    element.classList.toggle('is-online', status === 'online');
    element.title = state.pendingCount ? `${state.pendingCount} сообщение(й) ожидает отправки` : text;
  }
  const sidebarLabel = $('networkLabelSidebar');
  const chatLabel = $('networkLabelChat');
  if (sidebarLabel) sidebarLabel.textContent = text;
  if (chatLabel) chatLabel.textContent = text;
  const count = $('queuedCountSidebar');
  if (count) {
    count.textContent = String(state.pendingCount);
    count.hidden = !state.pendingCount;
  }
}
async function refreshPendingCount() {
  if (state.mode !== 'supabase' || !state.user) {
    state.pendingCount = 0;
    updateConnectionUI();
    return;
  }
  const items = await outboxGetAll();
  state.pendingCount = items.filter(item => item.user_id === state.user.id).length;
  updateConnectionUI();
}
function markNetworkDegraded() {
  state.networkDegraded = true;
  updateConnectionUI();
}
function markNetworkHealthy() {
  state.networkDegraded = false;
  updateConnectionUI();
}
function isIOSDevice() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandaloneApp() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true);
}
function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
async function savePushSubscriptionRecord(subscription) {
  if (state.mode !== 'supabase' || !state.client || !state.user) throw new Error('Сначала войди в аккаунт Supabase.');
  const { error } = await state.client.rpc('save_push_subscription', {
    p_endpoint: subscription.endpoint,
    p_subscription: subscription.toJSON(),
    p_user_agent: navigator.userAgent.slice(0, 512)
  });
  if (error) throw error;
}
async function syncPushSubscription() {
  if (state.mode !== 'supabase' || !state.client || !state.user || !navigator.onLine
      || !('Notification' in window) || Notification.permission !== 'granted'
      || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await savePushSubscriptionRecord(subscription);
    state.pushSubscription = subscription;
  } catch (error) {
    console.warn('Could not sync this device push subscription', error);
  }
}
async function updateNotificationsButton() {
  const button = $('notificationsButton');
  const label = $('notificationsLabel');
  if (!button || !label) return;
  button.classList.remove('is-enabled', 'is-blocked');
  button.disabled = true;
  state.pushSubscription = null;
  if (state.mode !== 'supabase' || !state.client) {
    label.textContent = 'Уведомления · подключи Supabase';
    button.disabled = true;
    return;
  }
  if (isIOSDevice() && !isStandaloneApp()) {
    label.textContent = 'Добавь на экран «Домой»';
    button.disabled = false;
    return;
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    label.textContent = 'Push недоступны в этом браузере';
    button.disabled = true;
    return;
  }
  if (Notification.permission === 'denied') {
    label.textContent = 'Разреши уведомления в настройках';
    button.classList.add('is-blocked');
    button.disabled = true;
    return;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    state.pushSubscription = await registration.pushManager.getSubscription();
    const enabled = Boolean(state.pushSubscription && Notification.permission === 'granted');
    label.textContent = enabled ? 'Отключить уведомления' : 'Включить уведомления';
    button.classList.toggle('is-enabled', enabled);
    button.disabled = false;
  } catch (error) {
    console.warn('Push subscription state unavailable', error);
    label.textContent = 'Не удалось проверить уведомления';
    button.disabled = false;
  }
}
async function enablePushNotifications() {
  if (state.mode !== 'supabase' || !state.client) {
    showToast('Сначала подключи реальный аккаунт Supabase.', 'error');
    return;
  }
  if (!navigator.onLine) {
    showToast('Для включения уведомлений нужно подключение к интернету.', 'error');
    return;
  }
  if (isIOSDevice() && !isStandaloneApp()) {
    openModal(`${modalHeader('Сначала добавь сайт на экран «Домой»', 'Веб-push доступны на iOS/iPadOS 16.4+ для установленного приложения.')}<ol class="install-steps"><li>Открой сайт в Safari и нажми <b>«Поделиться»</b>.</li><li>Выбери <b>«На экран Домой»</b>, затем запусти приложение с иконки.</li><li>Внутри приложения нажми <b>«Включить уведомления»</b> и разреши их.</li></ol><button class="primary-button modal-primary" type="button" data-close-modal="true"><span>Понятно</span><span class="button-arrow">✓</span></button>`);
    return;
  }
  if (!window.isSecureContext) {
    showToast('Push-уведомления работают только на HTTPS.', 'error');
    return;
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Этот браузер не поддерживает push-уведомления.', 'error');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Уведомления заблокированы в настройках браузера. Разреши их для этого сайта.', 'error');
    return;
  }
  const key = window.SVYAZ_CONFIG?.vapidPublicKey;
  if (!key) {
    showToast('Добавь VAPID public key в config.js и настрой Edge Function. Инструкция есть в README.', 'error');
    return;
  }
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast('Разрешение на уведомления не выдано.', 'error');
      await updateNotificationsButton();
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(key)
      });
    }
    await savePushSubscriptionRecord(subscription);
    state.pushSubscription = subscription;
    await updateNotificationsButton();
    showToast('Уведомления включены на этом устройстве.', 'success');
  } catch (error) {
    console.error('Could not subscribe to push notifications', error);
    showToast(error?.message || 'Не удалось включить уведомления. Проверь VAPID key и SQL-схему.', 'error');
    await updateNotificationsButton();
  }
}
async function disablePushNotifications(silent = false) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = state.pushSubscription || await registration.pushManager.getSubscription();
    if (!subscription) {
      await updateNotificationsButton();
      return;
    }
    if (state.client && state.user) {
      const deletion = state.client.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
      if (silent) {
        void deletion.then(({ error }) => {
          if (error) console.warn('Could not delete server subscription; browser unsubscribe will invalidate it', error);
        }).catch(error => console.warn('Could not delete server subscription during sign-out', error));
      } else {
        const { error } = await deletion;
        if (error) console.warn('Could not delete server subscription; browser unsubscribe will invalidate it', error);
      }
    }
    await subscription.unsubscribe();
    state.pushSubscription = null;
    await updateNotificationsButton();
    if (!silent) showToast('Уведомления отключены на этом устройстве.');
  } catch (error) {
    console.error('Could not unsubscribe from push notifications', error);
    if (!silent) showToast(error?.message || 'Не удалось отключить уведомления.', 'error');
  }
}
async function togglePushNotifications() {
  if (state.pushSubscription) await disablePushNotifications();
  else await enablePushNotifications();
}

function showAuthError(message) {
  const element = $('authError');
  element.textContent = message;
  element.hidden = false;
}
function clearAuthError() {
  $('authError').textContent = '';
  $('authError').hidden = true;
}
function setAuthBusy(busy) {
  const button = $('authSubmit');
  button.disabled = busy;
  button.innerHTML = busy ? '<span>Подключаем…</span><span class="button-arrow">◌</span>' : `<span>${state.authMode === 'signup' ? 'Создать аккаунт' : 'Войти'}</span><span class="button-arrow">↗</span>`;
}

function seedDemoDatabase() {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  return {
    profiles: [
      { id: 'demo-me', username: 'demo', nickname: 'Артём', friend_code: '8291hg', avatar_url: null, password_hash: null },
      { id: 'demo-lena', username: 'lena', nickname: 'Лена', friend_code: '1437km', avatar_url: null, password_hash: null },
      { id: 'demo-mark', username: 'mark', nickname: 'Марк', friend_code: '5820qx', avatar_url: null, password_hash: null },
      { id: 'demo-anna', username: 'anna', nickname: 'Анна', friend_code: '3102ar', avatar_url: null, password_hash: null }
    ],
    friend_requests: [
      { id: 'demo-friend-lena', sender_id: 'demo-lena', receiver_id: 'demo-me', status: 'accepted', created_at: ago(4000) },
      { id: 'demo-request-anna', sender_id: 'demo-anna', receiver_id: 'demo-me', status: 'pending', created_at: ago(9) }
    ],
    conversations: [
      { id: 'demo-conv-lena', member_ids: ['demo-me', 'demo-lena'] }
    ],
    messages: [
      { id: 'demo-msg-1', conversation_id: 'demo-conv-lena', sender_id: 'demo-lena', body: 'Привет! Ну как тебе наша первая версия? 🌙', message_type: 'text', created_at: ago(28) },
      { id: 'demo-msg-2', conversation_id: 'demo-conv-lena', sender_id: 'demo-me', body: 'Нравится. Уже похоже на свой маленький уголок в сети.', message_type: 'text', created_at: ago(25) },
      { id: 'demo-msg-3', conversation_id: 'demo-conv-lena', sender_id: 'demo-lena', body: 'Именно! Напиши, когда будешь здесь ✨', message_type: 'text', created_at: ago(22) }
    ]
  };
}
function getDemoDB() {
  try {
    const stored = localStorage.getItem(DEMO_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && Array.isArray(parsed.profiles) && Array.isArray(parsed.messages)) return parsed;
    }
  } catch (error) {
    console.warn('Could not read demo storage', error);
  }
  const fresh = seedDemoDatabase();
  saveDemoDB(fresh);
  return fresh;
}
function saveDemoDB(database) {
  try {
    localStorage.setItem(DEMO_KEY, JSON.stringify(database));
  } catch (error) {
    console.warn('Could not save demo data', error);
    showToast('В браузере закончилось место для демо-данных.', 'error');
  }
}
async function passwordDigest(value) {
  try {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(part => part.toString(16).padStart(2, '0')).join('');
  } catch {
    // Только локальная демонстрация, не использовать такой режим для реальной авторизации.
    let hash = 2166136261;
    for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return `demo-${(hash >>> 0).toString(16)}`;
  }
}
function setDemoSession(userId) {
  try { sessionStorage.setItem(DEMO_SESSION_KEY, userId); } catch { /* private browsing may block storage */ }
}
function clearDemoSession() {
  try { sessionStorage.removeItem(DEMO_SESSION_KEY); } catch { /* no-op */ }
}

function setBackendLabel() {
  const label = $('authModeLabel');
  if (state.backend === 'supabase') {
    label.innerHTML = state.client ? '<i></i> Supabase подключён' : '<i></i> Supabase · офлайн-кэш';
  } else {
    label.innerHTML = '<i></i> Локальный демо-режим';
  }
}
function setAuthMode(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('loginTab').classList.toggle('is-active', !signup);
  $('signupTab').classList.toggle('is-active', signup);
  $('loginTab').setAttribute('aria-selected', String(!signup));
  $('signupTab').setAttribute('aria-selected', String(signup));
  $('nicknameField').hidden = !signup;
  $('usernameHint').hidden = !signup;
  $('authTitle').textContent = signup ? 'Создай свой аккаунт' : 'С возвращением';
  $('authSubtitle').textContent = signup ? 'Придумай логин, пароль и ник для профиля.' : 'Войди, чтобы продолжить общение.';
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('authPassword').placeholder = signup ? 'Не менее 8 символов' : 'Твой пароль';
  $('authUsername').placeholder = signup ? 'например, anya_7' : 'твой логин';
  clearAuthError();
  setAuthBusy(false);
}
function showMessenger() {
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  document.body.classList.add('messenger-open');
}
function showAuth() {
  $('appShell').hidden = true;
  $('authScreen').hidden = false;
  document.body.classList.remove('messenger-open');
  closeModal();
}
async function enterMessenger(profile, authUser, mode) {
  state.profile = profile;
  state.user = authUser || { id: profile.id };
  state.mode = mode;
  state.sideTab = 'chats';
  state.search = '';
  state.activeFriend = null;
  state.activeConversationId = null;
  state.messages = [];
  state.pendingFile = null;
  $('friendSearch').value = '';
  $('appShell').classList.remove('chat-open');
  $('emptyState').hidden = false;
  $('chatView').hidden = true;
  $('messageInput').value = '';
  showMessenger();
  updateOwnProfileUI();
  void updateNotificationsButton();
  if (mode === 'supabase') void syncPushSubscription();
  if (mode === 'supabase') {
    await cacheDelete('local-signout');
    await cacheSet(`profile:${profile.id}`, profile);
    await cacheSet('last-session', { user_id: profile.id });
  }
  updateConnectionUI();
  await loadSocialData();
  renderSidebar();
  await refreshPendingCount();
  $('emptyMyCode').textContent = profile.friend_code || '······';
  if (mode === 'supabase' && state.client && navigator.onLine) void flushOutbox();
  await processNotificationRoute();
}
async function processNotificationRoute() {
  const url = new URL(location.href);
  const friendId = url.searchParams.get('chat');
  if (!friendId) return;
  url.searchParams.delete('chat');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  const friend = state.friends.find(profile => profile.id === friendId);
  if (friend) await openChat(friend);
  else showToast('Не нашёл этот чат в сохранённом списке. Подключись к интернету и открой его ещё раз.', 'error');
}
function updateOwnProfileUI() {
  const profile = state.profile;
  if (!profile) return;
  $('accountName').textContent = profile.nickname || profile.username || 'Мой профиль';
  $('accountCode').textContent = profile.friend_code ? `код ${profile.friend_code}` : 'код создаётся';
  setAvatar($('accountAvatar'), profile);
  setAvatar($('currentAvatar'), profile);
  $('emptyMyCode').textContent = profile.friend_code || '······';
}

async function initializeBackend(silent = false) {
  const config = window.SVYAZ_CONFIG || {};
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    state.backend = 'demo';
    setBackendLabel();
    return false;
  }
  state.backend = 'supabase';
  setBackendLabel();
  if (state.client) return true;
  let timer;
  try {
    const modulePromise = import(SUPABASE_MODULE);
    const module = await Promise.race([
      modulePromise,
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('Supabase client timed out')), 15000); })
    ]);
    const { createClient } = module;
    state.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { fetch: networkFetchWithTimeout }
    });
    setBackendLabel();
    return true;
  } catch (error) {
    console.warn('Supabase client is not available yet', error);
    state.client = null;
    setBackendLabel();
    if (!silent) showToast('Слабое соединение: открою сохранённые чаты. Когда сеть вернётся, подключусь снова.', 'error');
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
async function getSupabaseProfile(authUser) {
  if (!state.client) throw new Error('Сервер ещё не подключён.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await state.client.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
    if (error) {
      markNetworkDegraded();
      throw error;
    }
    if (data) {
      await cacheSet(`profile:${authUser.id}`, data);
      markNetworkHealthy();
      return data;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error('Не нашёл профиль в базе. Проверьте, что SQL-схема и триггер регистрации установлены.');
}
async function restoreSession() {
  const localSignout = state.backend === 'supabase' ? await cacheGet('local-signout') : null;
  if (localSignout) {
    await cacheDelete('last-session');
    if (state.client) {
      try {
        await state.client.auth.signOut();
        await cacheDelete('local-signout');
      } catch (error) {
        console.warn('Local sign-out will finish when connection returns', error);
      }
    }
  } else if (state.backend === 'supabase' && state.client) {
    try {
      const { data, error } = await state.client.auth.getSession();
      if (error) throw error;
      if (data.session?.user) {
        let profile;
        try { profile = await getSupabaseProfile(data.session.user); }
        catch (error) {
          profile = await cacheGet(`profile:${data.session.user.id}`);
          if (!profile) throw error;
          markNetworkDegraded();
        }
        await enterMessenger(profile, data.session.user, 'supabase');
        return;
      }
    } catch (error) {
      console.warn('Could not restore Supabase session from server', error);
    }
  }
  if (state.backend === 'supabase' && !localSignout) {
    const savedSession = await cacheGet('last-session');
    if (savedSession?.user_id) {
      const profile = await cacheGet(`profile:${savedSession.user_id}`);
      if (profile) {
        markNetworkDegraded();
        await enterMessenger(profile, { id: savedSession.user_id }, 'supabase');
        if (!navigator.onLine) showToast('Открыты сохранённые чаты. Сообщения отправятся после восстановления сети.');
        return;
      }
    }
  }
  try {
    const demoId = sessionStorage.getItem(DEMO_SESSION_KEY);
    if (demoId) {
      const profile = getDemoDB().profiles.find(item => item.id === demoId);
      if (profile) {
        await enterMessenger(profile, { id: profile.id }, 'demo');
        return;
      }
    }
  } catch { /* no session storage */ }
  showAuth();
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  clearAuthError();
  const username = $('authUsername').value.trim().toLowerCase();
  const password = $('authPassword').value;
  const nickname = $('authNickname').value.trim();
  if (!/^[a-z0-9_.-]{3,24}$/.test(username)) {
    showAuthError('Логин: 3–24 символа, латинские буквы, цифры, точка, дефис или подчёркивание.');
    return;
  }
  if (password.length < 8) {
    showAuthError('Пароль должен содержать не менее 8 символов.');
    return;
  }
  if (state.authMode === 'signup' && (nickname.length < 2 || nickname.length > 32)) {
    showAuthError('Отображаемый ник должен быть длиной от 2 до 32 символов.');
    return;
  }
  setAuthBusy(true);
  try {
    if (state.backend === 'supabase') {
      if (!state.client) throw new Error('Сейчас нет связи с сервером. Нажми «Попробовать демо» или попробуй войти, когда сеть станет стабильнее.');
      await supabaseAuth(username, password, nickname);
    } else if (state.authMode === 'signup') {
      await demoSignUp(username, password, nickname);
    } else {
      await demoSignIn(username, password);
    }
  } catch (error) {
    console.error('Authentication failed', error);
    const message = error?.message || 'Не получилось выполнить вход. Попробуй ещё раз.';
    showAuthError(message);
  } finally {
    setAuthBusy(false);
  }
}
async function supabaseAuth(username, password, nickname) {
  if (state.authMode === 'signup') {
    const { data, error } = await state.client.auth.signUp({
      email: loginAlias(username),
      password,
      options: { data: { username, nickname } }
    });
    if (error) throw error;
    if (!data.session || !data.user) {
      showAuthError('Аккаунт создан. Отключи Confirm email в Supabase для входа только по логину либо настрой подтверждение почты.');
      return;
    }
    const profile = await getSupabaseProfile(data.user);
    await enterMessenger(profile, data.user, 'supabase');
    showToast(`Готово! Твой код друга — ${profile.friend_code}`, 'success');
    return;
  }
  const { data, error } = await state.client.auth.signInWithPassword({ email: loginAlias(username), password });
  if (error) throw error;
  if (!data.user) throw new Error('Пользователь не найден.');
  const profile = await getSupabaseProfile(data.user);
  await enterMessenger(profile, data.user, 'supabase');
}
async function demoSignUp(username, password, nickname) {
  const database = getDemoDB();
  if (database.profiles.some(profile => profile.username.toLowerCase() === username)) {
    throw new Error('Этот логин уже занят в демо на этом устройстве.');
  }
  const profile = {
    id: randomId(),
    username,
    nickname,
    friend_code: generateFriendCode(database.profiles),
    avatar_url: null,
    password_hash: await passwordDigest(password)
  };
  database.profiles.push(profile);
  saveDemoDB(database);
  setDemoSession(profile.id);
  await enterMessenger(profile, { id: profile.id }, 'demo');
  showToast(`Аккаунт создан локально. Твой код — ${profile.friend_code}`, 'success');
}
async function demoSignIn(username, password) {
  const database = getDemoDB();
  const profile = database.profiles.find(item => item.username.toLowerCase() === username);
  if (!profile || !profile.password_hash || profile.password_hash !== await passwordDigest(password)) {
    throw new Error('Не нашёл такой локальный аккаунт. Создай его или нажми «Попробовать демо».');
  }
  setDemoSession(profile.id);
  await enterMessenger(profile, { id: profile.id }, 'demo');
}
async function enterDemo() {
  clearAuthError();
  const profile = getDemoDB().profiles.find(item => item.id === 'demo-me');
  if (!profile) {
    showToast('Не удалось загрузить демо-аккаунт.', 'error');
    return;
  }
  setDemoSession(profile.id);
  await enterMessenger(profile, { id: profile.id }, 'demo');
  showToast('Демо открыто. Данные видны только в этом браузере.', 'success');
}

async function restoreCachedSocialData() {
  if (!state.user) return false;
  const cached = await cacheGet(`social:${state.user.id}`);
  if (!cached) return false;
  state.friends = Array.isArray(cached.friends) ? cached.friends : [];
  state.incomingRequests = Array.isArray(cached.incomingRequests) ? cached.incomingRequests : [];
  state.outgoingRequests = Array.isArray(cached.outgoingRequests) ? cached.outgoingRequests : [];
  return true;
}
async function cacheSocialData() {
  if (!state.user) return;
  await cacheSet(`social:${state.user.id}`, {
    friends: state.friends,
    incomingRequests: state.incomingRequests,
    outgoingRequests: state.outgoingRequests
  });
}
async function loadSocialData() {
  if (!state.profile) return;
  if (state.mode === 'supabase') {
    if (!state.client || !navigator.onLine || connectionQualityIsPoor() || state.networkDegraded) {
      const restored = await restoreCachedSocialData();
      if (!restored) {
        state.friends = [];
        state.incomingRequests = [];
        state.outgoingRequests = [];
      }
      return;
    }
    try {
      const userId = state.user.id;
      const { data: requests, error } = await state.client.from('friend_requests')
        .select('id,sender_id,receiver_id,status,created_at')
        .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = requests || [];
      const otherIds = [...new Set(rows.filter(row => row.status === 'accepted').map(row => row.sender_id === userId ? row.receiver_id : row.sender_id)
        .concat(rows.filter(row => row.status === 'pending').map(row => row.sender_id === userId ? row.receiver_id : row.sender_id)))];
      let profileMap = new Map();
      if (otherIds.length) {
        const { data: profiles, error: profileError } = await state.client.from('profiles')
          .select('id,username,nickname,friend_code,avatar_url,created_at').in('id', otherIds);
        if (profileError) throw profileError;
        profileMap = new Map((profiles || []).map(profile => [profile.id, profile]));
      }
      const friendIds = new Set();
      for (const row of rows) if (row.status === 'accepted') friendIds.add(row.sender_id === userId ? row.receiver_id : row.sender_id);
      state.friends = [...friendIds].map(id => profileMap.get(id)).filter(Boolean).sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'ru'));
      state.incomingRequests = rows.filter(row => row.status === 'pending' && row.receiver_id === userId)
        .map(row => ({ ...row, profile: profileMap.get(row.sender_id) })).filter(row => row.profile);
      state.outgoingRequests = rows.filter(row => row.status === 'pending' && row.sender_id === userId)
        .map(row => ({ ...row, profile: profileMap.get(row.receiver_id) })).filter(row => row.profile);
      await cacheSocialData();
      markNetworkHealthy();
    } catch (error) {
      console.warn('Could not load friends online; showing cache', error);
      markNetworkDegraded();
      const restored = await restoreCachedSocialData();
      if (!restored) {
        state.friends = [];
        state.incomingRequests = [];
        state.outgoingRequests = [];
        showToast('Пока не удалось загрузить список друзей. Он появится, когда связь восстановится.', 'error');
      }
    }
    return;
  }
  const database = getDemoDB();
  const userId = state.user.id;
  const rows = database.friend_requests || [];
  const profileById = new Map(database.profiles.map(profile => [profile.id, profile]));
  const friendIds = new Set();
  for (const row of rows) {
    if (row.status === 'accepted' && (row.sender_id === userId || row.receiver_id === userId)) {
      friendIds.add(row.sender_id === userId ? row.receiver_id : row.sender_id);
    }
  }
  state.friends = [...friendIds].map(id => profileById.get(id)).filter(Boolean).sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '', 'ru'));
  state.incomingRequests = rows.filter(row => row.status === 'pending' && row.receiver_id === userId)
    .map(row => ({ ...row, profile: profileById.get(row.sender_id) })).filter(row => row.profile);
  state.outgoingRequests = rows.filter(row => row.status === 'pending' && row.sender_id === userId)
    .map(row => ({ ...row, profile: profileById.get(row.receiver_id) })).filter(row => row.profile);
}

function renderContactRow(profile, isActive = false) {
  const subtitle = profile.friend_code ? `код ${escapeHtml(profile.friend_code)}` : `@${escapeHtml(profile.username || '')}`;
  return `<button class="contact-row ${isActive ? 'is-active' : ''}" type="button" data-action="open-chat" data-id="${escapeHtml(profile.id)}">
    ${avatarMarkup(profile)}<span class="contact-copy"><span class="contact-name-line"><b>${escapeHtml(profile.nickname || profile.username || 'Пользователь')}</b><span class="contact-time">···</span></span><small>${subtitle}</small></span>
  </button>`;
}
function renderRequestCard(request) {
  const profile = request.profile;
  return `<div class="request-card"><div class="request-top">${avatarMarkup(profile)}<span class="request-copy"><b>${escapeHtml(profile.nickname || profile.username || 'Пользователь')}</b><small>код ${escapeHtml(profile.friend_code || '—')}</small></span></div>
    <div class="request-actions"><button class="request-accept" data-action="accept-request" data-id="${escapeHtml(request.id)}" type="button">Принять</button><button class="request-decline" data-action="decline-request" data-id="${escapeHtml(request.id)}" type="button">Отклонить</button></div></div>`;
}
function renderSidebar() {
  const list = $('sidebarList');
  const search = state.search.trim().toLowerCase();
  $('chatsTab').classList.toggle('is-active', state.sideTab === 'chats');
  $('friendsTab').classList.toggle('is-active', state.sideTab === 'friends');
  $('chatCount').textContent = String(state.friends.length);
  const requestBadge = $('requestCount');
  requestBadge.textContent = String(state.incomingRequests.length);
  requestBadge.hidden = !state.incomingRequests.length;

  if (state.sideTab === 'chats') {
    $('listLabel').textContent = state.friends.length ? 'НЕДАВНИЕ' : 'ТВОЙ СПИСОК';
    const filtered = state.friends.filter(profile => `${profile.nickname} ${profile.username} ${profile.friend_code}`.toLowerCase().includes(search));
    if (!filtered.length) {
      list.innerHTML = state.friends.length
        ? '<div class="sidebar-empty">Ничего не найдено.<br>Попробуй другой запрос.</div>'
        : '<div class="sidebar-empty"><strong>Здесь пока тихо.</strong><br>Добавь друга по его коду, чтобы начать чат.</div>';
      return;
    }
    list.innerHTML = filtered.map(profile => renderContactRow(profile, state.activeFriend?.id === profile.id)).join('');
    return;
  }

  $('listLabel').textContent = state.incomingRequests.length ? 'НОВЫЕ ЗАПРОСЫ' : 'ТВОИ ДРУЗЬЯ';
  const filteredFriends = state.friends.filter(profile => `${profile.nickname} ${profile.username} ${profile.friend_code}`.toLowerCase().includes(search));
  const requestCards = state.incomingRequests.map(renderRequestCard).join('');
  const friendRows = filteredFriends.map(profile => renderContactRow(profile, state.activeFriend?.id === profile.id)).join('');
  let outgoing = '';
  if (state.outgoingRequests.length) {
    outgoing = `<div class="side-list-label">ОТПРАВЛЕНЫ</div>${state.outgoingRequests.map(request => `<div class="contact-row">${avatarMarkup(request.profile)}<span class="contact-copy"><b>${escapeHtml(request.profile.nickname || request.profile.username)}</b><small>Запрос отправлен</small></span></div>`).join('')}`;
  }
  if (!requestCards && !friendRows && !outgoing) {
    list.innerHTML = '<div class="sidebar-empty"><strong>Пока без друзей.</strong><br>Найди человека по коду — например, 8291hg.</div>';
  } else {
    list.innerHTML = `${requestCards}${friendRows}${outgoing}`;
  }
}

function closeRealtimeChannel() {
  if (state.channel && state.client) {
    try { state.client.removeChannel(state.channel); } catch { /* no-op */ }
  }
  state.channel = null;
}
function updateChatHeader(profile) {
  setAvatar($('chatAvatar'), profile);
  $('chatName').textContent = profile.nickname || profile.username || 'Пользователь';
  $('chatCode').textContent = profile.friend_code ? `код ${profile.friend_code}` : `@${profile.username || ''}`;
}
async function openChat(profile) {
  if (!profile) return;
  if (state.mode === 'supabase' && state.user && state.activeConversationId) {
    const oldConversationId = state.activeConversationId;
    await cacheSet(`draft:${state.user.id}:${oldConversationId}`, $('messageInput').value);
    if (state.pendingFile) await cacheSet(`draft-file:${state.user.id}:${oldConversationId}`, state.pendingFile);
  }
  state.pendingFile = null;
  renderAttachmentPreview();
  state.activeFriend = profile;
  state.activeConversationId = null;
  state.messages = [];
  closeRealtimeChannel();
  $('emptyState').hidden = true;
  $('chatView').hidden = false;
  $('appShell').classList.add('chat-open');
  $('messageInput').disabled = true;
  $('sendButton').disabled = true;
  updateChatHeader(profile);
  $('messageWelcome').innerHTML = `<strong>Это начало вашей истории с ${escapeHtml(profile.nickname || profile.username || 'другом')}.</strong><br>Напиши первое сообщение или отправь голосовое.`;
  $('messagesList').innerHTML = '';
  $('messagesArea').scrollTop = 0;
  renderSidebar();
  try {
    if (state.mode === 'supabase') {
      const conversationKey = `conversation:${state.user.id}:${profile.id}`;
      let conversationId = await cacheGet(conversationKey);
      const connectionGoodEnough = navigator.onLine && !connectionQualityIsPoor() && !state.networkDegraded;
      if (state.client && navigator.onLine && (!conversationId || connectionGoodEnough)) {
        try {
          const { data, error } = await state.client.rpc('get_or_create_direct_conversation', { other_user_id: profile.id });
          if (error) throw error;
          conversationId = data;
          await cacheSet(conversationKey, conversationId);
        } catch (error) {
          markNetworkDegraded();
          if (!conversationId) throw error;
        }
      }
      if (!conversationId) throw new Error('Этот чат ещё не открывался на этом устройстве. Подключись к сети один раз, чтобы подготовить его для офлайн-режима.');
      if (state.activeFriend?.id !== profile.id) return;
      state.activeConversationId = conversationId;
      $('messageInput').value = '';
      if (state.client && navigator.onLine && !connectionQualityIsPoor() && !state.networkDegraded) {
        try {
          await loadSupabaseMessages(conversationId);
          if (state.activeFriend?.id === profile.id) subscribeToMessages(conversationId);
        } catch (error) {
          markNetworkDegraded();
          const restored = await loadCachedMessages(conversationId);
          if (!restored) throw error;
          showToast('Показываю сохранённые сообщения. Новые отправятся, когда связь улучшится.');
        }
      } else {
        await loadCachedMessages(conversationId);
      }
      await restoreChatDraft(conversationId);
      await refreshPendingCount();
    } else {
      const database = getDemoDB();
      const conversation = getOrCreateDemoConversation(database, state.user.id, profile.id);
      saveDemoDB(database);
      state.activeConversationId = conversation.id;
      state.messages = database.messages.filter(message => message.conversation_id === conversation.id).map(message => ({
        ...message,
        attachment_url: message.attachment_data || message.attachment_url || null
      })).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      renderMessages();
    }
  } catch (error) {
    console.error('Could not open chat', error);
    showToast(error?.message || 'Не получилось открыть чат.', 'error');
  } finally {
    if (state.activeFriend?.id === profile.id) {
      $('messageInput').disabled = false;
      $('sendButton').disabled = false;
      $('messageInput').focus({ preventScroll: true });
    }
  }
}
function getOrCreateDemoConversation(database, userId, friendId) {
  database.conversations ||= [];
  let conversation = database.conversations.find(item => item.member_ids?.includes(userId) && item.member_ids?.includes(friendId));
  if (!conversation) {
    conversation = { id: randomId(), member_ids: [userId, friendId] };
    database.conversations.push(conversation);
  }
  return conversation;
}
function offlineMessagesKey(conversationId) {
  return `messages:${state.user?.id}:${conversationId}`;
}
async function cacheConversationMessages(conversationId, messages = state.messages) {
  if (state.mode !== 'supabase' || !state.user || !conversationId) return;
  const compact = messages.slice(-200).map(message => {
    const cached = { ...message };
    if (typeof cached.attachment_url === 'string' && cached.attachment_url.startsWith('blob:')) cached.attachment_url = null;
    return cached;
  });
  await cacheSet(offlineMessagesKey(conversationId), compact);
}
async function loadCachedMessages(conversationId) {
  if (!state.user) return false;
  const cached = await cacheGet(offlineMessagesKey(conversationId));
  const outbox = await outboxGetAll();
  const byId = new Map((Array.isArray(cached) ? cached : []).map(message => [message.id, { ...message }]));
  for (const item of outbox) {
    if (item.user_id === state.user.id && item.conversation_id === conversationId && item.message) {
      byId.set(item.id, { ...item.message, sync_status: item.status || item.message.sync_status || 'queued', sync_error: item.error || '' });
    }
  }
  const messages = [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const message of messages) {
    message.attachment_url = null;
    if (message.attachment_blob && URL.createObjectURL) {
      try { message.attachment_url = URL.createObjectURL(message.attachment_blob); } catch { /* show the file card without preview */ }
    }
  }
  if (state.activeConversationId !== conversationId) return false;
  state.messages = messages;
  renderMessages();
  return Array.isArray(cached) || messages.length > 0;
}
async function restoreChatDraft(conversationId) {
  if (state.mode !== 'supabase' || !state.user) return;
  const key = `draft:${state.user.id}:${conversationId}`;
  const draft = await cacheGet(key);
  if (state.activeConversationId !== conversationId) return;
  if (draft && !$('messageInput').value) $('messageInput').value = draft;
  const pendingFile = await cacheGet(`draft-file:${state.user.id}:${conversationId}`);
  if (state.activeConversationId === conversationId && pendingFile) {
    state.pendingFile = pendingFile;
    renderAttachmentPreview();
  }
  $('messageInput').style.height = '35px';
  $('messageInput').style.height = `${Math.min($('messageInput').scrollHeight, 120)}px`;
}
async function loadSupabaseMessages(conversationId) {
  const { data, error } = await state.client.from('messages').select('*').eq('conversation_id', conversationId)
    .order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  const messages = (await hydrateSupabaseMessages(data || [])).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (state.activeConversationId !== conversationId) return;
  state.messages = messages;
  await cacheConversationMessages(conversationId, messages);
  markNetworkHealthy();
  renderMessages();
}
async function hydrateSupabaseMessages(messages) {
  const paths = [...new Set(messages.map(message => message.attachment_path).filter(Boolean))];
  if (!paths.length) return messages;
  if (connectionQualityIsPoor() || state.networkDegraded) return messages.map(message => ({ ...message, attachment_url: null }));
  try {
    const { data, error } = await state.client.storage.from('chat-files').createSignedUrls(paths, 60 * 60 * 12);
    if (error) throw error;
    const signed = new Map((data || []).filter(item => item.signedUrl).map(item => [item.path, item.signedUrl]));
    return messages.map(message => ({ ...message, attachment_url: signed.get(message.attachment_path) || null }));
  } catch (error) {
    console.warn('Could not create batch media links', error);
    markNetworkDegraded();
    return messages.map(message => ({ ...message, attachment_url: null }));
  }
}
async function hydrateSupabaseMessage(message) {
  if (!message.attachment_path) return message;
  try {
    const { data, error } = await state.client.storage.from('chat-files').createSignedUrl(message.attachment_path, 60 * 60 * 12);
    if (!error && data?.signedUrl) return { ...message, attachment_url: data.signedUrl };
  } catch (error) {
    console.warn('Could not create signed media URL', error);
  }
  return { ...message, attachment_url: null };
}
function subscribeToMessages(conversationId) {
  closeRealtimeChannel();
  state.channel = state.client.channel(`messages-${conversationId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}`
    }, async (payload) => {
      if (state.activeConversationId !== conversationId) return;
      if (state.messages.some(message => message.id === payload.new.id)) return;
      const message = await hydrateSupabaseMessage(payload.new);
      if (state.activeConversationId !== conversationId || state.messages.some(item => item.id === message.id)) return;
      state.messages.push(message);
      state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      await cacheConversationMessages(conversationId);
      markNetworkHealthy();
      renderMessages();
    }).subscribe();
}
function deliveryMarkup(message, mine) {
  if (!mine) return '';
  if (message.sync_status === 'queued') return '<span class="delivery-state delivery-queued" title="Сохранено на устройстве; ждёт сеть">◷ в очереди</span>';
  if (message.sync_status === 'sending') return '<span class="delivery-state delivery-sending" title="Отправляем">… отправляем</span>';
  if (message.sync_status === 'failed') return `<button class="delivery-retry" type="button" data-action="retry-message" data-id="${escapeHtml(message.id)}" title="Повторить отправку">ошибка · повторить</button>`;
  return '<span class="delivery-state" title="Отправлено">✓</span>';
}
function renderMessage(message) {
  const mine = message.sender_id === state.user?.id;
  const type = message.message_type || 'text';
  let attachment = '';
  const url = message.attachment_url;
  if (type === 'image') {
    attachment = url
      ? `<a class="message-media" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img src="${escapeHtml(url)}" alt="${escapeHtml(message.attachment_name || 'Изображение')}" loading="lazy"></a>`
      : `<div class="message-file"><span class="file-icon">▧</span><span class="file-info"><b>${escapeHtml(message.attachment_name || 'Изображение')}</b><small>Файл отправлен</small></span></div>`;
  } else if (type === 'audio') {
    attachment = url
      ? `<div class="message-audio-label">Голосовое сообщение</div><audio class="message-audio" controls preload="metadata" src="${escapeHtml(url)}"></audio>`
      : `<div class="message-file"><span class="file-icon">◉</span><span class="file-info"><b>Голосовое сообщение</b><small>${escapeHtml(formatFileSize(message.attachment_size))}</small></span></div>`;
  } else if (type === 'file') {
    const fileName = message.attachment_name || 'Вложение';
    attachment = `<${url ? 'a' : 'div'} class="message-file" ${url ? `href="${escapeHtml(url)}" target="_blank" rel="noopener" download="${escapeHtml(fileName)}"` : ''}><span class="file-icon">↧</span><span class="file-info"><b>${escapeHtml(fileName)}</b><small>${escapeHtml(formatFileSize(message.attachment_size))}</small></span></${url ? 'a' : 'div'}>`;
  }
  const body = message.body ? `<div class="message-text">${escapeHtml(message.body).replace(/\n/g, '<br>')}</div>` : '';
  return `<div class="message-row ${mine ? 'mine' : 'theirs'}">${mine ? '' : avatarMarkup(state.activeFriend)}<div class="message-bubble">${attachment}${body}<div class="message-meta"><time>${escapeHtml(formatTime(message.created_at))}</time>${deliveryMarkup(message, mine)}</div></div></div>`;
}
function renderMessages() {
  const list = $('messagesList');
  list.innerHTML = state.messages.map(renderMessage).join('');
  requestAnimationFrame(() => { $('messagesArea').scrollTop = $('messagesArea').scrollHeight; });
}

async function persistQueuedMessage(message, file = null) {
  const queued = { ...message, sync_status: 'queued', sync_error: '' };
  if (file) queued.attachment_blob = file;
  const item = {
    id: queued.id,
    user_id: state.user.id,
    conversation_id: queued.conversation_id,
    kind: file ? 'attachment' : 'text',
    status: 'queued',
    attempts: 0,
    next_retry_at: 0,
    error: '',
    message: queued
  };
  const stored = await outboxPut(item);
  if (!stored) throw new Error('Сообщение не удалось сохранить в очередь. Проверь свободное место на устройстве.');
  state.messages.push(queued);
  state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  await cacheConversationMessages(queued.conversation_id);
  renderMessages();
  await refreshPendingCount();
  if (!navigator.onLine || !state.client || state.networkDegraded) {
    showToast('Сохранено на устройстве. Отправлю, когда сеть станет стабильнее.', 'success');
    if (navigator.onLine && state.client) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = window.setTimeout(() => void flushOutbox(), 8000);
    }
  } else {
    if (file && connectionQualityIsPoor() && file.size > 2 * 1024 * 1024) {
      showToast('Большое вложение сохранено в очереди — отправлю, когда соединение станет стабильнее.', 'success');
    }
    void flushOutbox();
  }
}
async function cacheOutboxMessage(item) {
  const key = `messages:${item.user_id}:${item.conversation_id}`;
  const cached = await cacheGet(key) || [];
  const messages = Array.isArray(cached) ? cached.slice() : [];
  const index = messages.findIndex(message => message.id === item.id);
  if (index >= 0) messages[index] = { ...item.message };
  else messages.push({ ...item.message });
  messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  await cacheSet(key, messages.slice(-200));
  if (state.user?.id === item.user_id && state.activeConversationId === item.conversation_id) {
    const liveIndex = state.messages.findIndex(message => message.id === item.id);
    if (liveIndex >= 0) state.messages[liveIndex] = { ...item.message };
    else state.messages.push({ ...item.message });
    renderMessages();
  }
}
function canRetrySend(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (!navigator.onLine || !status) return true;
  return status === 401 || status === 408 || status === 429 || status >= 500;
}
async function sendOutboxItem(item) {
  if (!state.client) throw new Error('Клиент Supabase пока не подключён.');
  const message = item.message;
  let attachmentPath = message.attachment_path || null;
  if (item.kind === 'attachment') {
    const file = message.attachment_blob;
    if (!file) throw new Error('Файл не найден в локальной очереди. Выбери его и отправь снова.');
    attachmentPath = `${item.user_id}/${item.conversation_id}/${item.id}-${safeFileName(message.attachment_name || 'attachment')}`;
    const { error: uploadError } = await state.client.storage.from('chat-files').upload(attachmentPath, file, {
      cacheControl: '3600', upsert: true, contentType: message.attachment_mime || file.type || 'application/octet-stream'
    });
    if (uploadError) throw uploadError;
  }
  const payload = {
    id: item.id,
    conversation_id: item.conversation_id,
    sender_id: item.user_id,
    body: message.body || '',
    message_type: message.message_type || 'text',
    attachment_path: attachmentPath,
    attachment_name: message.attachment_name || null,
    attachment_mime: message.attachment_mime || null,
    attachment_size: message.attachment_size || null,
    created_at: message.created_at
  };
  const { data, error } = await state.client.from('messages').insert(payload).select('*').single();
  let sent = data;
  if (error) {
    // The previous request may have reached Supabase even if Wi-Fi dropped before its reply.
    // A stable client-generated id makes retry safe and prevents duplicate messages.
    if (error.code === '23505') {
      const existing = await state.client.from('messages').select('*').eq('id', item.id).maybeSingle();
      if (!existing.error && existing.data) sent = existing.data;
      else throw error;
    } else {
      throw error;
    }
  }
  return {
    ...sent,
    attachment_blob: message.attachment_blob || null,
    attachment_url: message.attachment_url || null,
    sync_status: 'sent',
    sync_error: ''
  };
}
async function flushOutbox() {
  if (state.flushingOutbox || state.mode !== 'supabase' || !state.client || !state.user || !navigator.onLine) return;
  state.flushingOutbox = true;
  try {
    const items = (await outboxGetAll()).filter(item => item.user_id === state.user.id).sort((a, b) => new Date(a.message?.created_at || 0) - new Date(b.message?.created_at || 0));
    for (const item of items) {
      if (item.status === 'failed') continue;
      if (item.next_retry_at && item.next_retry_at > Date.now()) {
        window.clearTimeout(state.retryTimer);
        state.retryTimer = window.setTimeout(() => void flushOutbox(), item.next_retry_at - Date.now());
        break;
      }
      if (item.kind === 'attachment' && connectionQualityIsPoor() && Number(item.message.attachment_size) > 2 * 1024 * 1024) {
        window.clearTimeout(state.retryTimer);
        state.retryTimer = window.setTimeout(() => void flushOutbox(), 30000);
        continue;
      }
      item.status = 'sending';
      item.message.sync_status = 'sending';
      await outboxPut(item);
      await cacheOutboxMessage(item);
      try {
        const sent = await sendOutboxItem(item);
        await outboxDelete(item.id);
        const current = await cacheGet(`messages:${item.user_id}:${item.conversation_id}`) || [];
        const cachedMessages = Array.isArray(current) ? current.slice() : [];
        const cacheIndex = cachedMessages.findIndex(message => message.id === item.id);
        if (cacheIndex >= 0) cachedMessages[cacheIndex] = sent;
        else cachedMessages.push(sent);
        cachedMessages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        await cacheSet(`messages:${item.user_id}:${item.conversation_id}`, cachedMessages.slice(-200));
        if (state.user?.id === item.user_id && state.activeConversationId === item.conversation_id) {
          const liveIndex = state.messages.findIndex(message => message.id === item.id);
          if (liveIndex >= 0) state.messages[liveIndex] = sent;
          else state.messages.push(sent);
          state.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
          renderMessages();
        }
        markNetworkHealthy();
      } catch (error) {
        console.warn('Message remains in offline outbox', error);
        const retry = canRetrySend(error);
        item.attempts = (item.attempts || 0) + 1;
        item.status = retry ? 'queued' : 'failed';
        item.error = error?.message || 'Не удалось отправить';
        item.next_retry_at = retry ? Date.now() + Math.min(120000, 2500 * (2 ** Math.min(item.attempts, 6))) : 0;
        item.message.sync_status = item.status;
        item.message.sync_error = item.error;
        await outboxPut(item);
        await cacheOutboxMessage(item);
        if (retry) {
          markNetworkDegraded();
          window.clearTimeout(state.retryTimer);
          state.retryTimer = window.setTimeout(() => void flushOutbox(), Math.max(3000, item.next_retry_at - Date.now()));
        } else {
          showToast(`Не удалось отправить сообщение: ${item.error}. Нажми «повторить».`, 'error');
        }
        break;
      }
    }
  } finally {
    state.flushingOutbox = false;
    await refreshPendingCount();
  }
}
async function retryOutboxMessage(id) {
  const items = await outboxGetAll();
  const item = items.find(entry => entry.id === id && entry.user_id === state.user?.id);
  if (!item) return;
  item.status = 'queued';
  item.attempts = 0;
  item.next_retry_at = 0;
  item.error = '';
  item.message.sync_status = 'queued';
  item.message.sync_error = '';
  await outboxPut(item);
  await cacheOutboxMessage(item);
  await refreshPendingCount();
  if (navigator.onLine && state.client && !connectionQualityIsPoor() && !state.networkDegraded) void flushOutbox();
  else showToast('Сообщение сохранено и ждёт стабильного соединения.');
}
async function sendText(body) {
  if (!state.activeConversationId) throw new Error('Сначала открой чат с другом.');
  const text = body.trim();
  if (!text) return;
  const message = {
    id: randomId(), conversation_id: state.activeConversationId, sender_id: state.user.id,
    body: text, message_type: 'text', created_at: new Date().toISOString()
  };
  if (state.mode === 'supabase') {
    await persistQueuedMessage(message);
    return;
  }
  const database = getDemoDB();
  database.messages.push(message);
  saveDemoDB(database);
  state.messages.push(message);
  renderMessages();
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
    reader.readAsDataURL(file);
  });
}
function safeFileName(name = 'file') {
  return String(name).normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'file';
}
function classifyFile(file, forcedType = null) {
  if (forcedType) return forcedType;
  if (file.type?.startsWith('image/')) return 'image';
  if (file.type?.startsWith('audio/')) return 'audio';
  return 'file';
}
async function sendAttachment(file, body = '', forcedType = null) {
  if (!state.activeConversationId) throw new Error('Сначала открой чат с другом.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ. Выбери файл поменьше.');
  const messageType = classifyFile(file, forcedType);
  if (state.mode === 'supabase') {
    let previewUrl = null;
    try { previewUrl = URL.createObjectURL(file); } catch { /* show attachment card without local preview */ }
    const message = {
      id: randomId(), conversation_id: state.activeConversationId, sender_id: state.user.id,
      body: body.trim(), message_type: messageType,
      attachment_name: file.name || 'Голосовое сообщение',
      attachment_mime: file.type || 'application/octet-stream', attachment_size: file.size,
      attachment_blob: file, attachment_url: previewUrl, created_at: new Date().toISOString()
    };
    await persistQueuedMessage(message, file);
    return;
  }
  let dataUrl = null;
  if (file.size <= 700 * 1024) {
    try { dataUrl = await fileToDataUrl(file); } catch { /* keep message without a persistent preview */ }
  }
  const message = {
    id: randomId(), conversation_id: state.activeConversationId, sender_id: state.user.id,
    body: body.trim(), message_type: messageType, attachment_name: file.name || 'Голосовое сообщение',
    attachment_mime: file.type || 'application/octet-stream', attachment_size: file.size,
    attachment_data: dataUrl, attachment_url: dataUrl || (file.size ? URL.createObjectURL(file) : null),
    created_at: new Date().toISOString()
  };
  const database = getDemoDB();
  const persistentMessage = { ...message };
  if (!dataUrl) persistentMessage.attachment_url = null;
  database.messages.push(persistentMessage);
  saveDemoDB(database);
  state.messages.push(message);
  renderMessages();
}
async function handleSendMessage(event) {
  event.preventDefault();
  if (state.recorder && state.recorder.state === 'recording') {
    await stopRecording(true);
    return;
  }
  const body = $('messageInput').value;
  const file = state.pendingFile;
  if (!body.trim() && !file) return;
  const button = $('sendButton');
  button.disabled = true;
  try {
    if (file) await sendAttachment(file, body);
    else await sendText(body);
    $('messageInput').value = '';
    $('messageInput').style.height = '35px';
    if (state.mode === 'supabase' && state.activeConversationId) {
      await cacheSet(`draft:${state.user.id}:${state.activeConversationId}`, '');
      await cacheDelete(`draft-file:${state.user.id}:${state.activeConversationId}`);
    }
    state.pendingFile = null;
    renderAttachmentPreview();
  } catch (error) {
    console.error('Could not send message', error);
    showToast(error?.message || 'Не удалось отправить сообщение.', 'error');
  } finally {
    button.disabled = !state.activeConversationId;
    $('messageInput').focus({ preventScroll: true });
  }
}
function renderAttachmentPreview() {
  const container = $('attachmentPreview');
  const file = state.pendingFile;
  if (!file) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  const symbol = file.type?.startsWith('image/') ? '▧' : file.type?.startsWith('audio/') ? '◉' : '↧';
  container.innerHTML = `<span class="preview-file">${symbol}</span><span>${escapeHtml(file.name || 'Голосовое сообщение')} · ${escapeHtml(formatFileSize(file.size))}</span><button type="button" data-action="remove-pending" aria-label="Убрать вложение">×</button>`;
}

async function startRecording() {
  if (!state.activeConversationId) {
    showToast('Сначала открой чат с другом.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast('Запись голосовых недоступна в этом браузере. Проверь HTTPS и разрешение на микрофон.', 'error');
    return;
  }
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported?.(type));
    state.recorder = preferred ? new MediaRecorder(state.mediaStream, { mimeType: preferred }) : new MediaRecorder(state.mediaStream);
    const chunks = [];
    state.discardRecording = false;
    state.recorder.addEventListener('dataavailable', event => { if (event.data?.size) chunks.push(event.data); });
    state.recorder.addEventListener('stop', async () => {
      const blob = new Blob(chunks, { type: state.recorder?.mimeType || 'audio/webm' });
      const shouldSend = !state.discardRecording;
      stopMediaTracks();
      state.recorder = null;
      updateRecordingUI(false);
      if (shouldSend && blob.size) {
        const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `Голосовое сообщение.${extension}`, { type: blob.type || 'audio/webm' });
        try { await sendAttachment(file, '', 'audio'); }
        catch (error) { console.error(error); showToast(error?.message || 'Не удалось отправить голосовое.', 'error'); }
      }
    }, { once: true });
    state.recorder.start();
    updateRecordingUI(true);
  } catch (error) {
    console.error('Microphone access failed', error);
    stopMediaTracks();
    showToast('Не получилось включить микрофон. Разреши доступ к микрофону в браузере.', 'error');
  }
}
function stopMediaTracks() {
  if (state.mediaStream) state.mediaStream.getTracks().forEach(track => track.stop());
  state.mediaStream = null;
}
function updateRecordingUI(recording) {
  $('recordingNotice').hidden = !recording;
  $('recordButton').classList.toggle('is-recording', recording);
  $('recordButton').title = recording ? 'Остановить и отправить голосовое' : 'Записать голосовое';
  $('recordButton').setAttribute('aria-label', recording ? 'Остановить запись и отправить' : 'Записать голосовое');
  $('messageInput').disabled = recording;
  $('attachButton').disabled = recording;
  if (recording) $('recordingText').textContent = 'Запись голосового…';
}
async function stopRecording(send) {
  const recorder = state.recorder;
  if (!recorder || recorder.state !== 'recording') return;
  state.discardRecording = !send;
  try { recorder.stop(); } catch { stopMediaTracks(); updateRecordingUI(false); }
}

function openModal(cardHtml, wide = false) {
  const host = $('modalHost');
  host.innerHTML = `<div class="modal-backdrop" data-close-modal="true"></div><section class="modal-card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${cardHtml}</section>`;
}
function closeModal() {
  const host = $('modalHost');
  if (host) host.innerHTML = '';
}
function modalHeader(title, subtitle = '') {
  return `<div class="modal-head"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div><button class="modal-close" type="button" data-close-modal="true" aria-label="Закрыть">×</button></div>`;
}
function openAddFriendModal() {
  openModal(`${modalHeader('Добавить друга', 'Введи его уникальный код из четырёх цифр и двух букв.')}
    <form id="addFriendForm"><label class="modal-field" for="friendCodeInput">Код друга</label><input class="modal-input" id="friendCodeInput" name="friendCode" placeholder="например, 8291hg" maxlength="6" autocapitalize="none" autocomplete="off" required><p class="modal-help">Код можно найти в профиле человека. Регистр букв не важен.</p><button class="primary-button modal-primary" type="submit"><span>Найти и отправить запрос</span><span class="button-arrow">↗</span></button></form>`);
  setTimeout(() => $('friendCodeInput')?.focus(), 20);
}
function openProfileModal(profile = state.profile, self = profile?.id === state.profile?.id) {
  if (!profile) return;
  const own = self && profile.id === state.profile?.id;
  const head = `${avatarMarkup(profile, 'avatar')}<span class="profile-summary"><b>${escapeHtml(profile.nickname || profile.username || 'Пользователь')}</b><small>${own ? `логин @${escapeHtml(profile.username || '')}` : 'Участник Связь грязь'}</small></span>`;
  const editable = own ? `<form id="profileForm"><label class="modal-field" for="profileNickname">Отображаемый ник</label><input class="modal-input" id="profileNickname" name="nickname" maxlength="32" value="${escapeHtml(profile.nickname || '')}" required><button class="primary-button modal-primary" type="submit"><span>Сохранить профиль</span><span class="button-arrow">↗</span></button></form><div class="modal-avatar-edit">${avatarMarkup(profile)}<span><button class="text-button" type="button" id="changeAvatarButton">Изменить фото профиля</button><small class="modal-help">JPG, PNG или WebP</small></span></div>` : `<div class="info-row"><span>Логин</span><b>@${escapeHtml(profile.username || '—')}</b></div><button class="primary-button modal-primary" type="button" data-modal-action="open-chat" data-id="${escapeHtml(profile.id)}"><span>Написать сообщение</span><span class="button-arrow">↗</span></button>`;
  openModal(`${modalHeader(own ? 'Твой профиль' : 'Профиль друга')}<div class="profile-modal-head">${head}</div>
    <div class="code-panel"><span><small>ТВОЙ УНИКАЛЬНЫЙ КОД</small><strong>${escapeHtml(profile.friend_code || '······')}</strong></span><button class="copy-code" type="button" data-modal-action="copy-code" data-code="${escapeHtml(profile.friend_code || '')}">Копировать</button></div>${editable}`);
}
function openInstallHelp() {
  const isApple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const steps = isApple
    ? '<ol class="install-steps"><li>Открой сайт в <b>Safari</b>.</li><li>Нажми кнопку <b>«Поделиться»</b> (квадрат со стрелкой).</li><li>Выбери <b>«На экран Домой»</b> и подтверди.</li></ol><p class="modal-help">На iPhone сайт устанавливается как веб-приложение (PWA), не как APK из App Store.</p>'
    : '<ol class="install-steps"><li>Открой сайт в Chrome или другом поддерживаемом браузере.</li><li>Нажми <b>«Установить приложение»</b> в меню браузера или подтверди системное окно.</li><li>Иконка появится на главном экране.</li></ol><p class="modal-help">На Android это веб-приложение PWA: оно открывается отдельным окном и не скачивает APK.</p>';
  openModal(`${modalHeader('Установить приложение', 'Добавь «Связь грязь» на главный экран телефона.')}${steps}<button class="primary-button modal-primary" type="button" data-close-modal="true"><span>Понятно</span><span class="button-arrow">✓</span></button>`);
}
function openFriendInfo(profile) {
  openProfileModal(profile, false);
}

async function submitFriendCode(codeValue) {
  const code = codeValue.trim().toLowerCase().replace(/\s/g, '');
  if (!/^[0-9]{4}[a-z]{2}$/.test(code)) throw new Error('Код должен быть в формате 4 цифры + 2 латинские буквы, например 8291hg.');
  if (state.mode === 'supabase') {
    const { data: target, error } = await state.client.from('profiles').select('id,username,nickname,friend_code,avatar_url').eq('friend_code', code).maybeSingle();
    if (error) throw error;
    if (!target) throw new Error('Пользователь с таким кодом не найден. Проверь код и попробуй ещё раз.');
    if (target.id === state.user.id) throw new Error('Это твой собственный код 🙂');
    const { data: existingOut, error: outError } = await state.client.from('friend_requests').select('id,status').eq('sender_id', state.user.id).eq('receiver_id', target.id).maybeSingle();
    if (outError) throw outError;
    const { data: existingIn, error: inError } = await state.client.from('friend_requests').select('id,status').eq('sender_id', target.id).eq('receiver_id', state.user.id).maybeSingle();
    if (inError) throw inError;
    if (existingOut?.status === 'accepted' || existingIn?.status === 'accepted') throw new Error('Вы уже друзья. Открой раздел «Чаты».');
    if (existingIn?.status === 'pending') throw new Error('Этот человек уже отправил тебе запрос. Найди его во вкладке «Друзья».');
    if (existingOut?.status === 'pending') throw new Error('Запрос этому человеку уже отправлен.');
    if (existingOut?.status === 'declined') throw new Error('Раньше этот запрос уже отклонили.');
    const { error: insertError } = await state.client.from('friend_requests').insert({ sender_id: state.user.id, receiver_id: target.id });
    if (insertError) throw insertError;
  } else {
    const database = getDemoDB();
    const target = database.profiles.find(profile => profile.friend_code.toLowerCase() === code);
    if (!target) throw new Error('Пользователь с таким кодом не найден в демо. Попробуй 1437km, 5820qx или 3102ar.');
    if (target.id === state.user.id) throw new Error('Это твой собственный код 🙂');
    const rows = database.friend_requests || [];
    const outgoing = rows.find(row => row.sender_id === state.user.id && row.receiver_id === target.id);
    const incoming = rows.find(row => row.sender_id === target.id && row.receiver_id === state.user.id);
    if (outgoing?.status === 'accepted' || incoming?.status === 'accepted') throw new Error('Вы уже друзья. Открой раздел «Чаты».');
    if (incoming?.status === 'pending') throw new Error('Этот человек уже отправил тебе запрос. Найди его во вкладке «Друзья».');
    if (outgoing?.status === 'pending') throw new Error('Запрос этому человеку уже отправлен.');
    if (outgoing?.status === 'declined') throw new Error('Раньше этот запрос уже отклонили.');
    database.friend_requests.push({ id: randomId(), sender_id: state.user.id, receiver_id: target.id, status: 'pending', created_at: new Date().toISOString() });
    saveDemoDB(database);
  }
  await loadSocialData();
  renderSidebar();
  closeModal();
  showToast('Запрос отправлен. Когда его примут, можно будет начать чат.', 'success');
}
async function updateFriendRequest(requestId, status) {
  const acceptedFriend = state.incomingRequests.find(request => request.id === requestId)?.profile || null;
  try {
    if (state.mode === 'supabase') {
      const { error } = await state.client.from('friend_requests').update({ status }).eq('id', requestId);
      if (error) throw error;
    } else {
      const database = getDemoDB();
      const request = database.friend_requests.find(item => item.id === requestId && item.receiver_id === state.user.id && item.status === 'pending');
      if (!request) throw new Error('Запрос уже обработан.');
      request.status = status;
      saveDemoDB(database);
    }
    await loadSocialData();
    renderSidebar();
    if (status === 'accepted' && state.mode === 'supabase' && state.client && navigator.onLine && acceptedFriend) {
      try {
        const { data, error } = await state.client.rpc('get_or_create_direct_conversation', { other_user_id: acceptedFriend.id });
        if (error) throw error;
        await cacheSet(`conversation:${state.user.id}:${acceptedFriend.id}`, data);
      } catch (error) {
        console.warn('Could not prepare friend chat for offline use yet', error);
        markNetworkDegraded();
      }
    }
    if (status === 'accepted') showToast('Запрос принят. Теперь вы можете переписываться.', 'success');
    else showToast('Запрос отклонён.');
  } catch (error) {
    console.error('Could not update friend request', error);
    showToast(error?.message || 'Не удалось обработать запрос.', 'error');
  }
}

async function saveProfileNickname(nickname) {
  const value = nickname.trim();
  if (value.length < 2 || value.length > 32) throw new Error('Ник должен быть длиной от 2 до 32 символов.');
  if (state.mode === 'supabase') {
    const { data, error } = await state.client.from('profiles').update({ nickname: value }).eq('id', state.user.id).select('*').single();
    if (error) throw error;
    state.profile = data;
  } else {
    const database = getDemoDB();
    const profile = database.profiles.find(item => item.id === state.user.id);
    if (!profile) throw new Error('Профиль не найден.');
    profile.nickname = value;
    state.profile = { ...profile };
    saveDemoDB(database);
  }
  updateOwnProfileUI();
  closeModal();
  showToast('Профиль обновлён.', 'success');
}
async function saveAvatar(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Выбери файл изображения.', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Аватар должен быть меньше 5 МБ.', 'error');
    return;
  }
  try {
    let avatarUrl;
    if (state.mode === 'supabase') {
      const extension = (file.name.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'jpg';
      const path = `${state.user.id}/avatar-${Date.now()}.${extension}`;
      const { error: uploadError } = await state.client.storage.from('avatars').upload(path, file, {
        cacheControl: '3600', upsert: false, contentType: file.type
      });
      if (uploadError) throw uploadError;
      const { data } = state.client.storage.from('avatars').getPublicUrl(path);
      avatarUrl = data.publicUrl;
      const { data: profile, error } = await state.client.from('profiles').update({ avatar_url: avatarUrl }).eq('id', state.user.id).select('*').single();
      if (error) throw error;
      state.profile = profile;
    } else {
      avatarUrl = await fileToDataUrl(file);
      const database = getDemoDB();
      const profile = database.profiles.find(item => item.id === state.user.id);
      if (!profile) throw new Error('Профиль не найден.');
      profile.avatar_url = avatarUrl;
      state.profile = { ...profile };
      saveDemoDB(database);
    }
    updateOwnProfileUI();
    openProfileModal(state.profile, true);
    showToast('Фото профиля обновлено.', 'success');
  } catch (error) {
    console.error('Could not update avatar', error);
    showToast(error?.message || 'Не получилось сохранить аватар.', 'error');
  } finally {
    $('avatarInput').value = '';
  }
}

function handleModalClick(event) {
  const target = event.target.closest('[data-close-modal]');
  if (target || event.target.classList.contains('modal-backdrop')) {
    closeModal();
    return;
  }
  const avatarButton = event.target.closest('#changeAvatarButton');
  if (avatarButton) {
    $('avatarInput').click();
    return;
  }
  const action = event.target.closest('[data-modal-action]');
  if (!action) return;
  if (action.dataset.modalAction === 'copy-code') {
    const code = action.dataset.code;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(() => showToast('Код скопирован.', 'success')).catch(() => showToast(`Твой код: ${code}`));
    else showToast(`Твой код: ${code}`);
  }
  if (action.dataset.modalAction === 'open-chat') {
    const friend = state.friends.find(profile => profile.id === action.dataset.id);
    closeModal();
    if (friend) openChat(friend);
  }
}
async function handleModalSubmit(event) {
  if (event.target.id === 'addFriendForm') {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await submitFriendCode($('friendCodeInput').value); }
    catch (error) { showToast(error?.message || 'Не удалось найти пользователя.', 'error'); button.disabled = false; }
  }
  if (event.target.id === 'profileForm') {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await saveProfileNickname($('profileNickname').value); }
    catch (error) { showToast(error?.message || 'Не удалось сохранить профиль.', 'error'); button.disabled = false; }
  }
}

async function installApp() {
  if (state.installPrompt) {
    state.installPrompt.prompt();
    try {
      const choice = await state.installPrompt.userChoice;
      if (choice?.outcome === 'accepted') showToast('Приложение добавлено на устройство.', 'success');
    } catch { /* no-op */ }
    state.installPrompt = null;
    return;
  }
  openInstallHelp();
}
async function handleNetworkRestored() {
  if (!navigator.onLine) return;
  state.networkDegraded = false;
  updateConnectionUI();
  if (state.backend === 'supabase' && !state.client) await initializeBackend(true);
  if (state.mode !== 'supabase' || !state.client || !state.user) return;
  try {
    const { data } = await state.client.auth.getSession();
    if (data.session?.user && data.session.user.id !== state.user.id) {
      const profile = await getSupabaseProfile(data.session.user);
      await enterMessenger(profile, data.session.user, 'supabase');
      return;
    }
    if (data.session?.user?.id === state.user.id) {
      void updateNotificationsButton();
      void syncPushSubscription();
    }
    await loadSocialData();
    renderSidebar();
    if (state.activeConversationId && !connectionQualityIsPoor() && !state.networkDegraded) {
      try {
        await loadSupabaseMessages(state.activeConversationId);
        subscribeToMessages(state.activeConversationId);
      } catch (error) {
        console.warn('Chat refresh will retry later', error);
        markNetworkDegraded();
      }
    } else if (state.activeConversationId) {
      await loadCachedMessages(state.activeConversationId);
    }
    await flushOutbox();
  } catch (error) {
    console.warn('Reconnect attempt did not finish', error);
    markNetworkDegraded();
  }
}
function setupPWA() {
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker registration failed', error));
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.installPrompt = event;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    showToast('Связь грязь установлена.', 'success');
  });
  window.addEventListener('offline', () => {
    state.networkDegraded = true;
    updateConnectionUI();
    if (!$('appShell').hidden) showToast('Нет соединения. Новые сообщения останутся в очереди.', 'error');
  });
  window.addEventListener('online', () => { void handleNetworkRestored(); });
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  connection?.addEventListener?.('change', () => {
    updateConnectionUI();
    if (navigator.onLine && !connectionQualityIsPoor()) void handleNetworkRestored();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) void handleNetworkRestored();
  });
  window.setInterval(() => {
    if (!document.hidden && navigator.onLine && state.mode === 'supabase') void flushOutbox();
  }, 25000);
  updateConnectionUI();
}

function bindEvents() {
  $('loginTab').addEventListener('click', () => setAuthMode('login'));
  $('signupTab').addEventListener('click', () => setAuthMode('signup'));
  $('authForm').addEventListener('submit', handleAuthSubmit);
  $('demoButton').addEventListener('click', enterDemo);
  $('passwordToggle').addEventListener('click', () => {
    const field = $('authPassword');
    field.type = field.type === 'password' ? 'text' : 'password';
  });
  $('chatsTab').addEventListener('click', () => { state.sideTab = 'chats'; renderSidebar(); });
  $('friendsTab').addEventListener('click', () => { state.sideTab = 'friends'; renderSidebar(); });
  $('friendSearch').addEventListener('input', event => { state.search = event.target.value; renderSidebar(); });
  $('sidebarList').addEventListener('click', event => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    if (action.dataset.action === 'open-chat') {
      const profile = state.friends.find(friend => friend.id === action.dataset.id);
      if (profile) openChat(profile);
    }
    if (action.dataset.action === 'accept-request') updateFriendRequest(action.dataset.id, 'accepted');
    if (action.dataset.action === 'decline-request') updateFriendRequest(action.dataset.id, 'declined');
  });
  $('addFriendButton').addEventListener('click', openAddFriendModal);
  $('emptyAddFriend').addEventListener('click', openAddFriendModal);
  $('profileButton').addEventListener('click', () => openProfileModal(state.profile, true));
  $('settingsButton').addEventListener('click', () => openProfileModal(state.profile, true));
  $('chatInfoButton').addEventListener('click', () => openFriendInfo(state.activeFriend));
  $('chatPersonButton').addEventListener('click', () => openFriendInfo(state.activeFriend));
  $('installButton').addEventListener('click', installApp);
  $('notificationsButton').addEventListener('click', () => { void togglePushNotifications(); });
  $('backButton').addEventListener('click', () => $('appShell').classList.remove('chat-open'));
  $('logoutButton').addEventListener('click', async () => {
    closeRealtimeChannel();
    if (state.mode === 'supabase' && state.user) await disablePushNotifications(true);
    if (state.mode === 'supabase' && state.user) {
      await cacheSet('local-signout', { user_id: state.user.id, at: Date.now() });
      await cacheDelete('last-session');
      if (state.client) {
        try {
          const { error } = await state.client.auth.signOut();
          if (error) showToast(error.message, 'error');
          else await cacheDelete('local-signout');
        } catch (error) {
          console.warn('Sign-out will finish locally while offline', error);
          showToast('Вышел на этом устройстве. Удалённая сессия завершится, когда появится сеть.');
        }
      }
    }
    clearDemoSession();
    state.user = null;
    state.profile = null;
    state.activeFriend = null;
    state.activeConversationId = null;
    state.pendingCount = 0;
    updateConnectionUI();
    showAuth();
  });
  $('messageForm').addEventListener('submit', handleSendMessage);
  $('messagesList').addEventListener('click', event => {
    const retry = event.target.closest('[data-action="retry-message"]');
    if (retry) void retryOutboxMessage(retry.dataset.id);
  });
  $('messageInput').addEventListener('input', event => {
    const input = event.target;
    input.style.height = '35px';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    if (state.mode === 'supabase' && state.user && state.activeConversationId) {
      window.clearTimeout(state.draftTimer);
      const key = `draft:${state.user.id}:${state.activeConversationId}`;
      const value = input.value;
      state.draftTimer = window.setTimeout(() => { void cacheSet(key, value); }, 250);
    }
  });
  $('messageInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('messageForm').requestSubmit();
    }
  });
  $('attachButton').addEventListener('click', () => {
    if (!state.activeConversationId) { showToast('Сначала открой чат с другом.'); return; }
    $('fileInput').click();
  });
  $('fileInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.size > 20 * 1024 * 1024) showToast('Файл больше 20 МБ. Выбери файл поменьше.', 'error');
      else {
        state.pendingFile = file;
        renderAttachmentPreview();
        if (state.mode === 'supabase' && state.user && state.activeConversationId) {
          void cacheSet(`draft-file:${state.user.id}:${state.activeConversationId}`, file);
        }
      }
    }
    event.target.value = '';
  });
  $('attachmentPreview').addEventListener('click', event => {
    if (event.target.closest('[data-action="remove-pending"]')) {
      state.pendingFile = null;
      if (state.mode === 'supabase' && state.user && state.activeConversationId) {
        void cacheDelete(`draft-file:${state.user.id}:${state.activeConversationId}`);
      }
      renderAttachmentPreview();
    }
  });
  $('recordButton').addEventListener('click', () => {
    if (state.recorder?.state === 'recording') stopRecording(true);
    else startRecording();
  });
  $('cancelRecording').addEventListener('click', () => stopRecording(false));
  $('avatarInput').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) saveAvatar(file);
  });
  $('modalHost').addEventListener('click', handleModalClick);
  $('modalHost').addEventListener('submit', handleModalSubmit);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('friendSearch').focus();
    }
  });
}

async function boot() {
  bindEvents();
  setupPWA();
  setBackendLabel();
  setAuthMode('login');
  await initializeBackend();
  await restoreSession();
}

boot();
