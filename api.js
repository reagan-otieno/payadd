// =============================================
// ADPAY — API CLIENT
// api.js — connects index.html & admin.html to the Node.js + PostgreSQL backend
//
// SET YOUR SERVER URL BELOW:
// =============================================

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:3000/api'
  : '/api';  // same domain in production

// Token storage
const TOKEN_KEY = 'adpay_token';
function getToken()      { return localStorage.getItem(TOKEN_KEY); }
function setToken(t)     { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()    { localStorage.removeItem(TOKEN_KEY); }

// =============================================
// HTTP HELPERS
// =============================================
async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(API_BASE + path, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...options.headers,
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = 'index.html';
    throw new Error('Session expired');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const api = {
  get:    (path)          => apiFetch(path),
  post:   (path, body)    => apiFetch(path, { method: 'POST',   body }),
  patch:  (path, body)    => apiFetch(path, { method: 'PATCH',  body }),
  delete: (path)          => apiFetch(path, { method: 'DELETE' }),
};

// =============================================
// AUTH
// =============================================
async function fbRegister(name, email, phone, password) {
  const data = await api.post('/auth/register', { name, email, phone, password });
  setToken(data.token);
  return data.user;
}

async function fbLogin(email, password) {
  const data = await api.post('/auth/login', { email, password });
  setToken(data.token);
  return data.user;
}

async function fbLogout() {
  clearToken();
}

async function getUser() {
  return api.get('/auth/me');
}

// =============================================
// ADS
// =============================================
async function fetchAds() {
  return api.get('/ads');
}

async function recordAdView(uid, adId, adName, earned) {
  return api.post(`/ads/${adId}/watch`, {});
}

// =============================================
// WALLET / TRANSACTIONS
// =============================================
async function fetchWallet() {
  return api.get('/wallet');
}

async function doDeposit(amount, currency, method, usdAmount) {
  return api.post('/wallet/deposit', {
    amount, currency, method, usd_amount: usdAmount
  });
}

async function doWithdraw(amount, currency, method) {
  return api.post('/wallet/withdraw', { amount, currency, method });
}

async function fetchTransactions(page = 1, type = null) {
  const q = `?page=${page}${type ? `&type=${type}` : ''}`;
  return api.get(`/wallet/transactions${q}`);
}

// =============================================
// NOTIFICATIONS
// =============================================
async function fetchNotifications() {
  return api.get('/notifications');
}

async function markAllNotificationsRead() {
  return api.patch('/notifications/read-all', {});
}

// =============================================
// LEADERBOARD
// =============================================
async function fetchLeaderboard() {
  return api.get('/leaderboard');
}

// =============================================
// ADMIN API
// =============================================
async function adminLogin(email, password, access_key) {
  const data = await api.post('/admin/login', { email, password, access_key });
  setToken(data.token);
  return data;
}

async function fetchAdminStats()        { return api.get('/admin/stats'); }
async function fetchAdminUsers(search, page) {
  return api.get(`/admin/users?search=${search||''}&page=${page||1}`);
}
async function fetchAdminTransactions(type, status) {
  return api.get(`/admin/transactions?${type?`type=${type}`:''}${status?`&status=${status}`:''}`);
}
async function fetchAdminAds()          { return api.get('/admin/ads'); }
async function fetchAdminAnalytics()    { return api.get('/admin/analytics'); }
async function fetchAdminLog()          { return api.get('/admin/log'); }

async function updateUserStatus(uid, status) {
  return api.patch(`/admin/users/${uid}/status`, { status });
}
async function approveTransaction(id)   { return api.patch(`/admin/transactions/${id}/approve`, {}); }
async function rejectTransaction(id)    { return api.patch(`/admin/transactions/${id}/reject`, {}); }

async function saveAd_fb(adData, adId = null) {
  const payload = {
    name:          adData.name,
    category:      adData.category,
    pay:           adData.pay,
    icon:          adData.icon,
    duration:      adData.duration,
    status:        adData.status,
    description:   adData.description,
    video_url:     adData.videoUrl,
    thumbnail_url: adData.thumbnail,
    schedule:      adData.schedule,
  };
  if (adId) return api.patch(`/admin/ads/${adId}`, payload);
  else      return api.post('/admin/ads', payload);
}

async function deleteAdFb(adId) {
  return api.delete(`/admin/ads/${adId}`);
}

// =============================================
// SERVER-SENT EVENTS — Real-time admin updates
// =============================================
let adminEventSource = null;

function connectAdminSSE(onEvent) {
  const token = getToken();
  if (!token) return;

  adminEventSource = new EventSource(
    `${API_BASE}/admin/events?token=${encodeURIComponent(token)}`
  );

  adminEventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type !== 'connected') onEvent(data);
    } catch {}
  };

  adminEventSource.onerror = () => {
    // Auto-reconnect after 3s
    setTimeout(() => {
      if (adminEventSource) {
        adminEventSource.close();
        connectAdminSSE(onEvent);
      }
    }, 3000);
  };

  console.log('📡 Admin SSE connected — real-time updates active');
}

function disconnectAdminSSE() {
  if (adminEventSource) {
    adminEventSource.close();
    adminEventSource = null;
  }
}

// =============================================
// COMPATIBILITY SHIMS (so app.js works unchanged)
// =============================================
const isFirebaseReady = false; // Tell app.js we're NOT using Firebase

// These are no-ops since we use the real API functions above
function watchUser(uid, cb)             { return () => {}; }
function watchAds(cb)                   { return () => {}; }
function watchAllUsers(cb)              { return () => {}; }
function watchAllAds(cb)                { return () => {}; }
function watchAllTransactions(cb)       { return () => {}; }
function watchUserTransactions(uid, cb) { return () => {}; }
function setUserPresence()              {}
function updateUser()                   { return Promise.resolve(); }
function addTransaction()               { return Promise.resolve(); }

// Firebase-style init — always succeeds
async function initFirebase() { return true; }
