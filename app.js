// =============================================
// ADPAY — MAIN APP (Firebase Real-Time)
// =============================================

let currentUser   = null;
let adTimer       = null;
let currentAd     = null;
let watchedAdsSet = new Set();
let liveRates     = {};

// Active Firestore listeners
let unsubUser = null, unsubAds = null, unsubTxns = null;

// In-memory cache for instant navigation
const cache = { ads: [], transactions: [], userProfile: null };

// =============================================
// APP BOOT
// =============================================
async function bootApp() {
  showLoader(true);

  // Check for existing session token
  if (getToken()) {
    try {
      currentUser = await getUser();
      await onUserLoggedIn();
      return;
    } catch {
      clearToken(); // token expired
    }
  }

  // Check if redirected from admin
  const params = new URLSearchParams(window.location.search);
  if (params.get('login') === '1') {
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => showPage('login'), 120);
  }

  cache.ads = DEMO_ADS; // show ads on landing page
  fetchLiveRates();
  setupKeyboardShortcut();
  hideLoader();
  showPage('landing');
}

function showLoader(show) {
  const el = document.getElementById('app-loader');
  if (el) { show ? el.classList.remove('hidden') : el.classList.add('hidden'); }
}
const hideLoader = () => showLoader(false);

// =============================================
// FAST PAGE NAVIGATION
// =============================================
let currentPage = 'landing';

function showPage(page, push = true) {
  if (page === currentPage && page !== 'landing') return;
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
  const target = document.getElementById('page-' + page);
  if (!target) return;
  target.style.display = page === 'dashboard' ? 'flex' : 'block';
  requestAnimationFrame(() => {
    target.classList.add('active', 'page-enter');
    setTimeout(() => target.classList.remove('page-enter'), 200);
  });
  currentPage = page;
  if (page === 'landing') window.scrollTo({ top: 0, behavior: 'instant' });
}

function scrollToSection(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }

// =============================================
// AUTH
// =============================================
async function registerUser() {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const pass  = document.getElementById('reg-pass').value;
  if (!name||!email||!phone||!pass) return showToast('Please fill in all fields','error');
  if (pass.length < 8) return showToast('Password must be at least 8 characters','error');
  const btn = document.querySelector('#page-register .btn-primary.full');
  setButtonLoading(btn, true, 'Creating account...');
  try {
    if (isFirebaseReady) {
      currentUser = await fbRegister(name, email, phone, pass);
    } else {
      currentUser = { uid:'demo_'+Date.now(), name, email, phone, balance:0, adsWatched:0, totalEarned:0, referrals:0, tier:'Starter', status:'active', role:'user', watchedAds:[], refCode:'ADPAY-'+name.split(' ')[0].toUpperCase().slice(0,4) };
    }
    showToast('Welcome to AdPay, '+name+'! 🎉','success');
    await onUserLoggedIn();
  } catch(err) {
    showToast(err.code==='auth/email-already-in-use'?'Email already registered':err.message,'error');
  } finally { setButtonLoading(btn, false, 'Create My Account →'); }
}

async function loginUser() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  if (!email||!pass) return showToast('Enter email and password','error');
  const btn = document.querySelector('#page-login .btn-primary.full');
  setButtonLoading(btn, true, 'Logging in...');
  try {
    if (isFirebaseReady) {
      const user = await fbLogin(email, pass);
      if (user.role==='admin'||user.status==='suspended') { showToast(user.status==='suspended'?'Account suspended. Contact support.':'Invalid credentials','error'); await fbLogout(); return; }
      currentUser = user;
    } else {
      currentUser = DEMO_USERS.find(u=>u.email===email&&u.password===pass&&u.role!=='admin');
      if (!currentUser) return showToast('Invalid email or password','error');
    }
    showToast('Welcome back, '+currentUser.name+'! 👋','success');
    await onUserLoggedIn();
  } catch { showToast('Invalid email or password','error'); }
  finally { setButtonLoading(btn, false, 'Log In →'); }
}

async function demoLogin(type) {
  if (type==='user') { currentUser=DEMO_USERS[0]; showToast('Logged in as Ashley (Demo)','info'); await onUserLoggedIn(); }
}

async function logout() {
  stopUserPolling();
  clearToken();
  currentUser = null; watchedAdsSet.clear();
  cache.ads = DEMO_ADS; cache.transactions = [];
  showPage('landing'); showToast('Logged out','info');
}

// =============================================
// POST-LOGIN
// =============================================
async function onUserLoggedIn() {
  showLoader(true);
  showPage('dashboard');
  initDashboardUI();

  try {
    // Load ads and transactions in parallel
    const [ads, walletData] = await Promise.all([
      fetchAds().catch(() => DEMO_ADS),
      fetchWallet().catch(() => ({ transactions: [] })),
    ]);
    cache.ads          = ads;
    cache.transactions = walletData.transactions || [];
    // Update balance from wallet endpoint (most accurate)
    if (walletData.balance !== undefined) currentUser.balance = walletData.balance;

    // Which ads did user watch today
    watchedAdsSet = new Set(
      ads.filter(a => a.watched_today).map(a => a.id)
    );
  } catch (e) {
    cache.ads = DEMO_ADS; cache.transactions = [];
    console.warn('Using demo data:', e.message);
  }

  renderAdsGrid(); renderTodayAds(); renderActivity();
  renderUserTransactions(); renderHistory();
  updateDashStats(); updateNotifBadge();

  // Poll for updates every 15 seconds (lightweight alternative to SSE on user side)
  startUserPolling();
  hideLoader();
}

let userPollInterval = null;
function startUserPolling() {
  if (userPollInterval) clearInterval(userPollInterval);
  userPollInterval = setInterval(async () => {
    try {
      const [profile, walletData] = await Promise.all([
        getUser(),
        fetchWallet().catch(() => null),
      ]);
      currentUser = profile;
      if (walletData) {
        cache.transactions = walletData.transactions || [];
        if (walletData.balance !== undefined) currentUser.balance = walletData.balance;
      }
      updateDashStats(); renderActivity(); renderUserTransactions();
    } catch { /* silent */ }
  }, 15000);
}

function stopUserPolling() {
  if (userPollInterval) { clearInterval(userPollInterval); userPollInterval = null; }
}

function initDashboardUI() {
  const u = currentUser;
  document.getElementById('dash-greet').textContent      = u.name.split(' ')[0];
  document.getElementById('dash-username').textContent   = u.name;
  document.getElementById('dash-tier').textContent       = getTierBadge(u.tier);
  document.getElementById('dash-avatar').textContent     = initials(u.name);
  document.getElementById('dash-avatar-top') && (document.getElementById('dash-avatar-top').textContent = initials(u.name));
  document.getElementById('dash-date').textContent       = new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  document.getElementById('ref-code').textContent        = u.refCode||('ADPAY-'+u.name.split(' ')[0].toUpperCase().slice(0,4)+(u.uid||'').slice(0,4).toUpperCase());
  updateDashStats();
}

function updateDashStats() {
  const u = currentUser; if (!u) return;
  const bal = (u.balance||0).toFixed(2);
  document.getElementById('stat-balance') &&  (document.getElementById('stat-balance').textContent  = '$'+bal);
  document.getElementById('stat-ads') &&       (document.getElementById('stat-ads').textContent      = u.adsWatched||0);
  document.getElementById('stat-earned') &&    (document.getElementById('stat-earned').textContent   = '$'+(u.totalEarned||0).toFixed(2));
  document.getElementById('stat-refs') &&      (document.getElementById('stat-refs').textContent     = u.referrals||0);
  document.getElementById('wallet-balance') && (document.getElementById('wallet-balance').textContent= '$'+bal);
  document.getElementById('wallet-user') &&    (document.getElementById('wallet-user').textContent   = u.name);
  document.getElementById('ref-count') &&      (document.getElementById('ref-count').textContent     = u.referrals||0);
  document.getElementById('ref-earned') &&     (document.getElementById('ref-earned').textContent    = '$'+((u.referrals||0)*2.5).toFixed(2));
  updateTier();
}

function getTierBadge(tier) { return {'Starter':'🥉 Starter','Regular':'🥈 Regular','Pro Earner':'🥇 Pro Earner','Admin':'🔑 Admin'}[tier]||tier; }

function updateTier() {
  if (!currentUser) return;
  const e = currentUser.totalEarned||0;
  const tier = e>=100?'Pro Earner':e>=20?'Regular':'Starter';
  if (tier!==currentUser.tier) { currentUser.tier=tier; if(isFirebaseReady) updateUser(currentUser.uid,{tier}); document.getElementById('dash-tier').textContent=getTierBadge(tier); }
}

function initials(name) { return (name||'').split(' ').map(n=>n[0]).join('').slice(0,2).toUpperCase(); }

// =============================================
// DASHBOARD TABS — instant switching
// =============================================
let activeTab = 'overview';
const tabInit = {};

function showDashTab(tab) {
  if (tab===activeTab) return;
  document.querySelectorAll('.dash-tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('#page-dashboard .nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('tab-'+tab)?.classList.add('active');
  event?.target?.closest('.nav-item')?.classList.add('active');
  activeTab = tab;
  document.getElementById('notif-panel').style.display='none';
  if (!tabInit[tab]) {
    tabInit[tab]=true;
    if (tab==='leaderboard') renderLeaderboard();
    if (tab==='support')     initSupportChat();
    if (tab==='wallet')      { updateDepositConversion(); updateWithdrawConversion(); }
  }
}

// =============================================
// ADS
// =============================================
function renderTodayAds() {
  const list = document.getElementById('today-ads-list'); if (!list) return;
  const avail = cache.ads.filter(a=>a.status==='active').slice(0,4);
  list.innerHTML = avail.length ? avail.map(ad=>`
    <div class="today-ad-item" onclick="openAdModal('${ad.id}')">
      <div class="today-ad-icon">${ad.icon}</div>
      <div class="today-ad-info"><div class="today-ad-name">${ad.name}</div><div class="today-ad-pay">+$${(ad.pay||0).toFixed(2)} · ${ad.duration}s</div></div>
      <div class="today-ad-arrow">${watchedAdsSet.has(ad.id)?'✓':'▶'}</div>
    </div>`).join('') : '<p style="color:var(--text3);font-size:.85rem">Loading ads...</p>';
}

function renderAdsGrid(filter='all') {
  const grid = document.getElementById('ads-grid'); if (!grid) return;
  const ads  = cache.ads.filter(a=>a.status==='active'&&(filter==='all'||a.category===filter));
  grid.innerHTML = ads.length ? ads.map(ad=>`
    <div class="ad-grid-card">
      <div class="ad-grid-icon">${ad.icon}</div>
      <div class="ad-grid-name">${ad.name}</div>
      <div class="ad-grid-cat">${capitalize(ad.category)}</div>
      <div class="ad-grid-pay">+$${(ad.pay||0).toFixed(2)}</div>
      <div class="ad-grid-duration">⏱ ${ad.duration} seconds</div>
      ${watchedAdsSet.has(ad.id)?'<div class="ad-watched-badge">✅ Watched Today</div>':`<button class="ad-watch-btn" onclick="openAdModal('${ad.id}')">▶ Watch Now</button>`}
    </div>`).join('') : '<p style="color:var(--text3)">No ads available.</p>';
}

function filterAds(cat, btn) {
  document.querySelectorAll('.ads-filter .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); renderAdsGrid(cat);
}

// =============================================
// AD WATCH MODAL
// =============================================
function openAdModal(adId) {
  const ad = cache.ads.find(a=>a.id===adId); if (!ad) return;
  if (watchedAdsSet.has(ad.id)) { showToast('Already watched today','info'); return; }
  currentAd = ad;
  document.getElementById('modal-icon').textContent     = ad.icon;
  document.getElementById('modal-app-name').textContent = ad.name;
  document.getElementById('modal-category').textContent = ad.category;
  document.getElementById('modal-reward').textContent   = '+$'+ad.pay.toFixed(2);
  document.getElementById('video-label').textContent    = ad.name+' — Sponsored';
  document.getElementById('ring-count').textContent     = ad.duration;
  document.getElementById('modal-progress').style.width = '0%';
  document.getElementById('modal-status').textContent   = 'Watch to earn your reward';
  document.getElementById('ad-modal').style.display     = 'flex';
  loadVideoAd(ad); startAdTimer(ad.duration);
}

function startAdTimer(total) {
  let elapsed=0;
  const circle=document.getElementById('ring-circle'), count=document.getElementById('ring-count'), progress=document.getElementById('modal-progress');
  const C=283;
  if (adTimer) clearInterval(adTimer);
  adTimer = setInterval(()=>{
    elapsed++;
    count.textContent = total-elapsed;
    circle.style.strokeDashoffset = C*(1-elapsed/total);
    progress.style.width=(elapsed/total*100)+'%';
    if (elapsed>=total) { clearInterval(adTimer); completeAd(); }
  },1000);
}

async function completeAd() {
  if (!currentAd||!currentUser) return;
  const ad = currentAd;
  watchedAdsSet.add(ad.id);
  document.getElementById('modal-status').textContent = '🎉 You earned $'+ad.pay.toFixed(2)+'!';
  try {
    const result = await recordAdView(currentUser.uid, ad.id, ad.name, ad.pay);
    // Update local state from server response
    if (result?.user) {
      currentUser = result.user;
      updateDashStats();
    }
    if (result?.transaction) {
      cache.transactions.unshift(result.transaction);
      renderActivity(); renderUserTransactions(); renderHistory();
    }
    renderTodayAds(); renderAdsGrid();
    addNotification('💰','Ad Reward Earned!','+$'+ad.pay.toFixed(2)+' from '+ad.name);
  } catch(e) {
    watchedAdsSet.delete(ad.id);
    document.getElementById('modal-status').textContent = 'Error: '+e.message;
    return;
  }
  setTimeout(()=>{ closeAdModal(); showToast('+$'+ad.pay.toFixed(2)+' earned! 🎉','success'); },1200);
}

function closeAdModal() {
  if (adTimer) { clearInterval(adTimer); adTimer=null; }
  document.getElementById('ad-modal').style.display='none';
  const iframe=document.getElementById('ad-iframe'); if(iframe) iframe.src='';
}

function loadVideoAd(ad) {
  const embed=document.getElementById('ad-video-embed'), ph=document.getElementById('ad-video-placeholder'), iframe=document.getElementById('ad-iframe');
  if (ad.videoUrl) {
    const yt=ad.videoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
    const vm=ad.videoUrl.match(/vimeo\.com\/(\d+)/);
    let url='';
    if (yt) url=`https://www.youtube.com/embed/${yt[1]}?autoplay=1&controls=0&modestbranding=1&mute=1`;
    else if (vm) url=`https://player.vimeo.com/video/${vm[1]}?autoplay=1&muted=1`;
    else if (ad.videoUrl.match(/\.(mp4|webm)$/i)) url=ad.videoUrl;
    if (url) { iframe.src=url; embed.style.display='block'; ph.style.display='none'; return; }
  }
  embed.style.display='none'; ph.style.display='flex'; if(iframe) iframe.src='';
}

// =============================================
// ACTIVITY & HISTORY
// =============================================
function renderActivity() {
  const list=document.getElementById('activity-list'); if(!list) return;
  list.innerHTML = cache.transactions.slice(0,6).map(t=>`
    <div class="activity-item">
      <div class="act-icon">${t.type==='earning'?'📺':t.type==='deposit'?'💵':'💸'}</div>
      <div class="act-info"><div class="act-title">${t.desc}</div><div class="act-time">${formatDate(t.date)}</div></div>
      <div class="act-amount" style="color:${t.type==='withdrawal'?'var(--red)':'var(--green)'}">${t.type==='withdrawal'?'-':'+'}$${(t.amount||0).toFixed(2)}</div>
    </div>`).join('')||'<p style="color:var(--text3);font-size:.85rem">No activity yet.</p>';
}

function renderHistory() {
  const tbody=document.getElementById('history-body'); if(!tbody) return;
  const views=cache.transactions.filter(t=>t.type==='earning');
  tbody.innerHTML = views.length?views.map(v=>`<tr><td>${formatDate(v.date)}</td><td>${v.desc?.replace(' Ad','')||'—'}</td><td>${v.desc||'—'}</td><td>—</td><td style="color:var(--green)">+$${(v.amount||0).toFixed(2)}</td></tr>`).join(''):'<tr><td colspan="5" style="color:var(--text3);text-align:center;padding:20px">No ad views yet</td></tr>';
}

function renderUserTransactions() {
  const tbody=document.getElementById('txn-body'); if(!tbody) return;
  tbody.innerHTML = cache.transactions.length?cache.transactions.map(t=>`
    <tr>
      <td>${formatDate(t.date)}</td>
      <td>${capitalize(t.type)}</td>
      <td style="color:${t.type==='withdrawal'?'var(--red)':'var(--green)'}">${t.type==='withdrawal'?'-':'+'}$${(t.amount||0).toFixed(2)}</td>
      <td>${t.method}</td>
      <td><span class="badge ${t.status==='completed'?'badge-green':'badge-orange'}">${t.status}</span></td>
    </tr>`).join(''):'<tr><td colspan="5" style="color:var(--text3);text-align:center">No transactions yet</td></tr>';
}

// =============================================
// WALLET
// =============================================
async function processDeposit() {
  const currency = document.getElementById('deposit-currency')?.value || 'USD';
  const amount   = parseFloat(document.getElementById('deposit-amt')?.value);
  const method   = document.getElementById('deposit-method')?.value;
  if (!amount || amount < 1) return showToast('Enter a valid amount (min $1)', 'error');
  const usdAmt = convertAmount(amount, currency, 'USD');
  if (usdAmt < 0.01) return showToast('Amount too small', 'error');

  const btn = document.querySelector('#tab-wallet .btn-primary.full');
  setButtonLoading(btn, true, 'Processing...');
  try {
    const result = await doDeposit(amount, currency, method, usdAmt);
    currentUser.balance = result.balance;
    cache.transactions.unshift(result.transaction);
    updateDashStats(); renderUserTransactions();
    document.getElementById('deposit-amt').value = '';
    updateDepositConversion();
    const display = currency === 'USD' ? `$${usdAmt.toFixed(2)}` : `${formatCurrency(amount,currency)} (≈$${usdAmt.toFixed(2)})`;
    showToast(`${display} deposited ✅`, 'success');
    addNotification('💵', 'Deposit Received', `${display} added to your wallet.`);
  } catch(e) {
    showToast('Deposit failed: ' + e.message, 'error');
  } finally {
    setButtonLoading(btn, false, 'Deposit →');
  }
}

async function processWithdraw() {
  const currency = document.getElementById('withdraw-currency')?.value || 'USD';
  const amount   = parseFloat(document.getElementById('withdraw-amt')?.value);
  const method   = document.getElementById('withdraw-method')?.value;
  if (!amount || amount < 5) return showToast('Minimum withdrawal is $5', 'error');
  if (amount > (currentUser.balance || 0)) return showToast('Insufficient balance', 'error');

  const btn = document.querySelectorAll('#tab-wallet .btn-primary.full')[1];
  setButtonLoading(btn, true, 'Processing...');
  try {
    const result = await doWithdraw(amount, currency, method);
    currentUser.balance = result.balance;
    cache.transactions.unshift(result.transaction);
    updateDashStats(); renderUserTransactions();
    document.getElementById('withdraw-amt').value = '';
    updateWithdrawConversion();
    showToast(`$${amount.toFixed(2)} withdrawal submitted ⏳`, 'success');
    addNotification('💸', 'Withdrawal Submitted', `$${amount.toFixed(2)} → ${method} pending.`);
  } catch(e) {
    showToast('Withdrawal failed: ' + e.message, 'error');
  } finally {
    setButtonLoading(btn, false, 'Withdraw →');
  }
}

// =============================================
// DEMO DATA
// =============================================
const DEMO_USERS = [
  {uid:'demo1',name:'Ashley Kim',email:'ashley@example.com',phone:'+1-512-345-6789',password:'password',balance:47.20,adsWatched:94,totalEarned:89.50,referrals:5,tier:'Pro Earner',status:'active',role:'user',watchedAds:[],refCode:'ADPAY-ASHL'},
  {uid:'demo2',name:'Daniel Morris',email:'daniel@example.com',phone:'+1-312-456-7890',password:'password',balance:22.80,adsWatched:46,totalEarned:32.00,referrals:2,tier:'Regular',status:'active',role:'user',watchedAds:[],refCode:'ADPAY-DANI'},
  {uid:'demo3',name:'Fiona Walsh',email:'fiona@example.com',phone:'+1-206-567-8901',password:'password',balance:5.50,adsWatched:11,totalEarned:8.00,referrals:0,tier:'Starter',status:'active',role:'user',watchedAds:[],refCode:'ADPAY-FION'},
  {uid:'demo4',name:'Marcus Torres',email:'marcus@example.com',phone:'+1-213-678-9012',password:'password',balance:98.40,adsWatched:210,totalEarned:245.00,referrals:12,tier:'Pro Earner',status:'active',role:'user',watchedAds:[],refCode:'ADPAY-MARC'},
];
const DEMO_ADS = [
  {id:'ad1',name:'GameZone Pro',category:'gaming',pay:0.50,icon:'🎮',duration:30,views:1204,status:'active',description:'Action-packed mobile gaming',videoUrl:'',thumbnail:''},
  {id:'ad2',name:'CryptoWallet X',category:'finance',pay:0.60,icon:'💰',duration:25,views:887,status:'active',description:'Secure crypto wallet',videoUrl:'',thumbnail:''},
  {id:'ad3',name:'FitLife Coach',category:'lifestyle',pay:0.45,icon:'🏋️',duration:20,views:643,status:'active',description:'Personal fitness & nutrition',videoUrl:'',thumbnail:''},
  {id:'ad4',name:'ShopEasy',category:'shopping',pay:0.40,icon:'🛍️',duration:15,views:1567,status:'active',description:'Online shopping made easy',videoUrl:'',thumbnail:''},
  {id:'ad5',name:'MusicPro Studio',category:'lifestyle',pay:0.35,icon:'🎵',duration:20,views:422,status:'active',description:'Create & discover music',videoUrl:'',thumbnail:''},
  {id:'ad6',name:'LearnFast Academy',category:'education',pay:0.55,icon:'📚',duration:35,views:299,status:'active',description:'Online courses & skills',videoUrl:'',thumbnail:''},
  {id:'ad7',name:'RideShare Go',category:'lifestyle',pay:0.50,icon:'🚕',duration:25,views:754,status:'active',description:'Affordable city rides',videoUrl:'',thumbnail:''},
  {id:'ad8',name:'FoodDash Delivery',category:'shopping',pay:0.45,icon:'🍔',duration:20,views:932,status:'active',description:'Fast food delivery',videoUrl:'',thumbnail:''},
];
let DEMO_TRANSACTIONS = [
  {id:'TXN001',uid:'demo1',type:'earning',amount:0.50,method:'Ad Watch',status:'completed',desc:'GameZone Pro Ad',date:'2025-03-15T14:32:00.000Z'},
  {id:'TXN002',uid:'demo1',type:'withdrawal',amount:20.00,method:'PayPal',status:'completed',desc:'Withdrawal to PayPal',date:'2025-03-14T10:00:00.000Z'},
  {id:'TXN003',uid:'demo2',type:'deposit',amount:10.00,method:'Debit/Credit Card',status:'completed',desc:'Top-up deposit',date:'2025-03-13T09:15:00.000Z'},
  {id:'TXN004',uid:'demo4',type:'withdrawal',amount:50.00,method:'Bank Account',status:'pending',desc:'Withdrawal to bank',date:'2025-03-12T16:45:00.000Z'},
];

// =============================================
// REFERRALS
// =============================================
function copyRefCode() {
  navigator.clipboard.writeText(document.getElementById('ref-code')?.textContent||'').then(()=>showToast('Referral code copied! 📋','success'));
}

// =============================================
// LEADERBOARD
// =============================================
async function renderLeaderboard() {
  const podiumEl = document.getElementById('lb-podium');
  const listEl   = document.getElementById('lb-full-list');
  if (!podiumEl || !listEl) return;

  // Skeleton while loading
  podiumEl.innerHTML = '<div class="skeleton" style="height:120px;border-radius:12px;width:100%"></div>';
  listEl.innerHTML   = [1,2,3,4,5].map(()=>'<div class="skeleton sk-line wide" style="height:48px;margin-bottom:8px"></div>').join('');

  let users = [];
  try {
    users = await fetchLeaderboard();
  } catch {
    users = [...DEMO_USERS].sort((a,b) => b.totalEarned - a.totalEarned);
  }

  const medals  = ['🥇','🥈','🥉'];
  const classes = ['first','second','third'];

  if (users.length >= 3) {
    podiumEl.innerHTML = [users[1], users[0], users[2]].map((u, vi) => {
      const rank = vi === 0 ? 2 : vi === 1 ? 1 : 3;
      const isMe = currentUser && (u.id === currentUser.id || u.uid === currentUser.uid);
      return `<div class="podium-slot ${classes[rank-1]}">
        <div class="podium-avatar">${initials(u.name)}</div>
        <div class="podium-name">${u.name.split(' ')[0]}${isMe?' (You)':''}</div>
        <div class="podium-earn">$${(u.total_earned||u.totalEarned||0).toFixed(2)}</div>
        <div class="podium-block">${medals[rank-1]}</div>
      </div>`;
    }).join('');
  }

  listEl.innerHTML = users.map((u, i) => {
    const isMe     = currentUser && (u.id === currentUser.id || u.uid === currentUser.uid);
    const rankLabel = i < 3 ? medals[i] : `#${i+1}`;
    const earned   = u.total_earned || u.totalEarned || 0;
    const watched  = u.ads_watched  || u.adsWatched  || 0;
    return `<div class="lb-row ${isMe?'me':''}">
      <div class="lb-rank">${rankLabel}</div>
      <div class="lb-av">${initials(u.name)}</div>
      <div class="lb-info">
        <div class="lb-name">${u.name}${isMe?' <span style="color:var(--accent);font-size:.72rem">(You)</span>':''}</div>
        <div class="lb-tier">${getTierBadge(u.tier)}</div>
      </div>
      <div style="text-align:right">
        <div class="lb-earn">$${parseFloat(earned).toFixed(2)}</div>
        <div class="lb-ads">${watched} ads</div>
      </div>
    </div>`;
  }).join('');
}

function switchLeaderboard(period,btn) {
  document.querySelectorAll('.leaderboard-period .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); renderLeaderboard();
}

// =============================================
// NOTIFICATIONS
// =============================================
const NOTIFICATIONS=[
  {id:1,icon:'💰',title:'Withdrawal Approved!',body:'Your $20.00 PayPal withdrawal was processed.',time:'2 min ago',unread:true},
  {id:2,icon:'🎉',title:'New Tier Unlocked!',body:'You\'ve reached Regular tier. Earn up to $15/day!',time:'1 hr ago',unread:true},
  {id:3,icon:'📱',title:'5 New Ads Available',body:'Fresh ads ready for you!',time:'3 hrs ago',unread:true},
  {id:4,icon:'👥',title:'Referral Bonus!',body:'Daniel M. joined using your code. +$0.50!',time:'Yesterday',unread:false},
];

function toggleNotifPanel() {
  const panel=document.getElementById('notif-panel');
  if (!panel) return;
  if (panel.style.display==='none'||!panel.style.display) { panel.style.display='flex'; panel.style.flexDirection='column'; renderNotifications(); }
  else panel.style.display='none';
}
function renderNotifications() {
  const list=document.getElementById('notif-list'); if(!list) return;
  list.innerHTML=NOTIFICATIONS.map(n=>`<div class="notif-item ${n.unread?'unread':''}" onclick="markRead(${n.id})"><div class="notif-icon">${n.icon}</div><div class="notif-title">${n.title}</div><div class="notif-body">${n.body}</div><div class="notif-time">${n.time}</div></div>`).join('');
}
function markRead(id) { const n=NOTIFICATIONS.find(n=>n.id===id); if(n) n.unread=false; updateNotifBadge(); renderNotifications(); }
function clearNotifications() { NOTIFICATIONS.forEach(n=>n.unread=false); updateNotifBadge(); renderNotifications(); }
function updateNotifBadge() {
  const count=NOTIFICATIONS.filter(n=>n.unread).length;
  ['notif-badge','notif-badge-top'].forEach(id=>{ const el=document.getElementById(id); if(el){el.textContent=count;el.style.display=count>0?'':'none';} });
}
function addNotification(icon,title,body) { NOTIFICATIONS.unshift({id:Date.now(),icon,title,body,time:'Just now',unread:true}); updateNotifBadge(); }

// =============================================
// SUPPORT CHAT
// =============================================
const SR={withdraw:["To withdraw go to **Wallet → Withdraw**, enter amount (min $5), choose method. Processed within 24hrs. ✅"],deposit:["Deposit via Bank Transfer, PayPal, or Card in **Wallet tab**. Min $1, instant. 💵"],referral:["Earn **10% of your referrals' earnings forever!** Share your code from Referrals tab. 👥"],tier:["Tiers:\n🥉 **Starter** $0–$19\n🥈 **Regular** $20–$99\n🥇 **Pro Earner** $100+"],earn:["Each ad pays $0.35–$0.65. Watch the full ad — earnings added instantly. 💰"],missing:["Share the ad name and watch time and I'll escalate immediately. 🔍"],bug:["Describe what happened and I'll log a tech report. Reviewed within 2hrs. 🛠️"],hello:["Hey! 👋 I'm AdPay Support. How can I help?"],default:["Thanks for reaching out! Give me more detail and I'll help right away. 🤔"]};
let isTyping=false;
function initSupportChat() { const msgs=document.getElementById('chat-messages'); if(!msgs||msgs.children.length>0) return; appendAgentMsg('Hi '+(currentUser?.name?.split(' ')[0]||'there')+'! 👋 I\'m your AdPay support assistant.'); }
function appendAgentMsg(text) { const msgs=document.getElementById('chat-messages'); if(!msgs) return; const d=document.createElement('div'); d.className='chat-msg agent'; d.innerHTML='<div class="msg-bubble">'+text.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>')+'</div><div class="msg-time">'+getTimeStr()+'</div>'; msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; }
function appendUserMsg(text) { const msgs=document.getElementById('chat-messages'); if(!msgs) return; const d=document.createElement('div'); d.className='chat-msg user'; d.innerHTML='<div class="msg-bubble">'+text+'</div><div class="msg-time">'+getTimeStr()+'</div>'; msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; }
function showTyping() { const msgs=document.getElementById('chat-messages'); if(!msgs) return; const d=document.createElement('div'); d.className='chat-msg agent'; d.id='typing-indicator'; d.innerHTML='<div class="chat-typing"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>'; msgs.appendChild(d); msgs.scrollTop=msgs.scrollHeight; }
function hideTyping() { document.getElementById('typing-indicator')?.remove(); }
function getTimeStr() { return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
function getResponse(m) { m=m.toLowerCase(); if(/hello|hi|hey/.test(m)) return SR.hello[0]; if(/withdraw/.test(m)) return SR.withdraw[0]; if(/deposit|top.?up/.test(m)) return SR.deposit[0]; if(/referral|refer/.test(m)) return SR.referral[0]; if(/tier|level|upgrade/.test(m)) return SR.tier[0]; if(/earn|money/.test(m)) return SR.earn[0]; if(/missing|didn.*receive/.test(m)) return SR.missing[0]; if(/bug|error|issue|broken/.test(m)) return SR.bug[0]; return SR.default[0]; }
function sendSupportMsg() { const input=document.getElementById('chat-input'); const text=input?.value.trim(); if(!text||isTyping) return; input.value=''; appendUserMsg(text); isTyping=true; showTyping(); setTimeout(()=>{hideTyping();appendAgentMsg(getResponse(text));isTyping=false;},900+Math.random()*600); }
function injectSupportMsg(msg) { const input=document.getElementById('chat-input'); if(input){input.value=msg;sendSupportMsg();} }

// =============================================
// CURRENCY
// =============================================
const FALLBACK_RATES={USD:1,EUR:0.918,GBP:0.787,KES:129.50,NGN:1580,ZAR:18.45,INR:83.20,CNY:7.24,JPY:149.80,CAD:1.358,AUD:1.533,BRL:4.97,MXN:17.15,EGP:30.90,AED:3.673,BTC:0.0000238};
let ratesLastUpdated=null, ratesLoading=false;
async function fetchLiveRates() {
  if (ratesLoading) return; ratesLoading=true;
  try { const res=await fetch('https://api.frankfurter.app/latest?from=USD',{signal:AbortSignal.timeout(4000)}); if(res.ok){const data=await res.json();liveRates={USD:1,...data.rates,KES:FALLBACK_RATES.KES,NGN:FALLBACK_RATES.NGN,EGP:FALLBACK_RATES.EGP,BTC:FALLBACK_RATES.BTC};ratesLastUpdated=new Date();} else liveRates={...FALLBACK_RATES}; } catch {liveRates={...FALLBACK_RATES};} ratesLoading=false;
}
function getRates() { return Object.keys(liveRates).length?liveRates:FALLBACK_RATES; }
function convertAmount(amount,from,to) { if(!amount||isNaN(amount)) return 0; const r=getRates(); return(parseFloat(amount)/r[from])*r[to]; }
function formatCurrency(amount,currency) { if(currency==='BTC') return amount.toFixed(8)+' BTC'; const s={USD:'$',EUR:'€',GBP:'£',KES:'KSh',NGN:'₦',ZAR:'R',INR:'₹',CNY:'¥',JPY:'¥',CAD:'CA$',AUD:'A$'}; return(s[currency]||currency+' ')+amount.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function updateDepositConversion() { const c=document.getElementById('deposit-currency')?.value||'USD',a=parseFloat(document.getElementById('deposit-amt')?.value)||0,box=document.getElementById('deposit-conversion-box'),lbl=document.getElementById('deposit-currency-label'); if(lbl) lbl.textContent='('+c+')'; if(!box) return; if(c==='USD'){box.style.display='none';return;} box.style.display='flex'; document.getElementById('deposit-usd-equiv').textContent='$'+convertAmount(a,c,'USD').toFixed(2)+' USD'; document.getElementById('deposit-rate-info').textContent='1 USD = '+(getRates()[c]||0).toFixed(2)+' '+c; }
function updateWithdrawConversion() { const c=document.getElementById('withdraw-currency')?.value||'USD',a=parseFloat(document.getElementById('withdraw-amt')?.value)||0,box=document.getElementById('withdraw-conversion-box'); if(!box) return; if(c==='USD'){box.style.display='none';return;} box.style.display='flex'; document.getElementById('withdraw-local-equiv').textContent=formatCurrency(convertAmount(a,'USD',c),c); document.getElementById('withdraw-rate-info').textContent='1 USD = '+(getRates()[c]||0).toFixed(2)+' '+c; }
function openCurrencyWidget() { document.getElementById('currency-modal').style.display='flex'; fetchLiveRates().then(()=>{buildRateTicker();buildRatesGrid();convertCurrency();}); buildRateTicker();buildRatesGrid();convertCurrency(); const btn=document.getElementById('use-rate-btn'); if(btn) btn.style.display=currentUser?'block':'none'; }
function closeCurrencyWidget() { document.getElementById('currency-modal').style.display='none'; }
function convertCurrency() { const amount=parseFloat(document.getElementById('conv-amount')?.value)||0,from=document.getElementById('conv-from')?.value||'USD',to=document.getElementById('conv-to')?.value||'EUR',r=getRates(),result=convertAmount(amount,from,to),rate=r[to]/r[from]; document.getElementById('conv-result-main').textContent=formatCurrency(result,to); document.getElementById('conv-result-rate').textContent='1 '+from+' = '+formatCurrency(rate,to); document.getElementById('conv-result-sub').textContent=formatCurrency(amount,from)+' = '+formatCurrency(result,to); if(ratesLastUpdated) document.getElementById('conv-last-updated').textContent='Last updated: '+ratesLastUpdated.toLocaleTimeString(); const el=document.getElementById('nav-rate-display'); if(el) el.textContent=from+'/'+to; }
function swapCurrencies() { const from=document.getElementById('conv-from'),to=document.getElementById('conv-to'),tmp=from.value;from.value=to.value;to.value=tmp;convertCurrency(); }
function buildRateTicker() { const el=document.getElementById('rate-ticker'); if(!el) return; const r=getRates(); const pairs=[['EUR','USD'],['GBP','USD'],['CAD','USD'],['AUD','USD'],['JPY','USD'],['CHF','USD']]; const items=pairs.map((p,i)=>{const rate=r[p[0]]?(1/r[p[0]]).toFixed(5):'—',chg=[0.3,-0.2,0.8,-1.2,0.5,1.1][i];return '<span class="ticker-pair"><span class="t-code">'+p[0]+'/USD</span><span class="t-rate">'+rate+'</span><span class="t-change '+(chg>=0?'up':'down')+'">'+(chg>=0?'▲':'▼')+Math.abs(chg)+'%</span></span>';}); el.innerHTML='<div class="ticker-inner">'+items.join('')+items.join('')+'</div>'; }
function buildRatesGrid() { const el=document.getElementById('conv-rates-grid'); if(!el) return; const r=getRates(); const currencies=[{code:'EUR',name:'Euro'},{code:'GBP',name:'Pound'},{code:'JPY',name:'Yen'},{code:'CAD',name:'Canadian Dollar'},{code:'AUD',name:'Australian Dollar'},{code:'INR',name:'Indian Rupee'},{code:'CNY',name:'Chinese Yuan'},{code:'BRL',name:'Brazilian Real'},{code:'AED',name:'UAE Dirham'}]; el.innerHTML=currencies.map(c=>'<div class="rate-card" onclick="document.getElementById(\'conv-to\').value=\''+c.code+'\';convertCurrency()"><div class="rate-card-code">1 USD =</div><div class="rate-card-val">'+((r[c.code]||0).toLocaleString(undefined,{maximumFractionDigits:2}))+' '+c.code+'</div><div class="rate-card-name">'+c.name+'</div></div>').join(''); }

// =============================================
// MOBILE NAV
// =============================================
window.addEventListener('scroll',()=>{ document.getElementById('main-navbar')?.classList.toggle('scrolled',window.scrollY>40); });
function toggleMobileMenu() { const m=document.getElementById('mobile-menu'),b=document.getElementById('hamburger'); m.classList.toggle('open');b.classList.toggle('open');document.body.style.overflow=m.classList.contains('open')?'hidden':''; }
function closeMobileMenu() { document.getElementById('mobile-menu')?.classList.remove('open');document.getElementById('hamburger')?.classList.remove('open');document.body.style.overflow=''; }
function toggleDashMobileMenu() { document.getElementById('dash-sidebar')?.classList.toggle('mobile-open');document.getElementById('dash-mobile-overlay')?.classList.toggle('open'); }
window.addEventListener('resize',()=>{if(window.innerWidth>900)closeMobileMenu();});

// =============================================
// LIVE FEED
// =============================================
const feedNames=['Ashley K.','Daniel M.','Fiona W.','Marcus T.','Rachel S.','Tyler B.','Jordan L.','Megan H.','Connor J.','Brianna P.'];
const feedApps=['GameZone','CryptoWallet','FitLife','ShopEasy','MusicPro','RideShare','FoodDash'];
function updateLiveFeed() { const el=document.getElementById('live-feed'); if(!el) return; const item=document.createElement('div'); item.className='feed-item'; const name=feedNames[Math.floor(Math.random()*feedNames.length)],app=feedApps[Math.floor(Math.random()*feedApps.length)],amt=(Math.random()*1.5+0.3).toFixed(2); item.innerHTML='<span class="feed-name">👤 '+name+' watched '+app+'</span><span class="feed-amount">+$'+amt+'</span>'; el.insertBefore(item,el.firstChild); if(el.children.length>6) el.removeChild(el.lastChild); }
setInterval(updateLiveFeed,2200); updateLiveFeed();

// =============================================
// PWA
// =============================================
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;setTimeout(showPWABanner,8000);});
function showPWABanner(){if(document.getElementById('pwa-banner'))return;const b=document.createElement('div');b.id='pwa-banner';b.className='pwa-banner';b.innerHTML='<div class="pwa-icon">📱</div><div class="pwa-text"><strong>Install AdPay App</strong><span>Add to home screen</span></div><div class="pwa-actions"><button class="pwa-install-btn" onclick="installPWA()">Install</button><button class="pwa-dismiss" onclick="dismissPWA()">✕</button></div>';document.body.appendChild(b);}
function installPWA(){if(deferredPrompt){deferredPrompt.prompt();deferredPrompt.userChoice.then(()=>{deferredPrompt=null;dismissPWA();});}else{showToast('Tap Share → Add to Home Screen 📱','info');dismissPWA();}}
function dismissPWA(){document.getElementById('pwa-banner')?.remove();}

// =============================================
// UTILS
// =============================================
function capitalize(s){return s?s.charAt(0).toUpperCase()+s.slice(1):'';}
function formatDate(d){if(!d)return'—';try{return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return d;}}
function setButtonLoading(btn,loading,text){if(!btn)return;btn.disabled=loading;btn.textContent=text;btn.style.opacity=loading?'0.7':'1';}
let toastTimer;
function showToast(msg,type='info'){const t=document.getElementById('toast');if(!t)return;t.textContent=type==='success'?'✅ '+msg:type==='error'?'❌ '+msg:'ℹ️ '+msg;t.className='toast show '+type;if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3500);}

// =============================================
// EVENTS
// =============================================
document.getElementById('ad-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeAdModal();});
document.getElementById('currency-modal')?.addEventListener('click',e=>{if(e.target===e.currentTarget)closeCurrencyWidget();});
document.addEventListener('click',e=>{const panel=document.getElementById('notif-panel');if(panel&&panel.style.display!=='none'&&!panel.contains(e.target)&&!e.target.closest('.notif-bell')&&!e.target.closest('.notif-bell-top'))panel.style.display='none';});

function setupKeyboardShortcut(){const SECRET='adpayadmin';let typed='';document.addEventListener('keydown',e=>{if(document.activeElement.tagName==='INPUT'||document.activeElement.tagName==='TEXTAREA')return;typed+=e.key.toLowerCase();if(typed.length>SECRET.length)typed=typed.slice(-SECRET.length);if(typed===SECRET){typed='';window.location.href='admin.html?key=ADPAY_ADMIN_2025';}});}

// Service Worker
if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));}
setInterval(fetchLiveRates,5*60*1000);

// BOOT
window.addEventListener('DOMContentLoaded',bootApp);
