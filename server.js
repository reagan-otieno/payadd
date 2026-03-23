require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const app = express();

// ============================================
// SECURITY MIDDLEWARE
// ============================================
app.use(helmet({
  contentSecurityPolicy: false, // Disable for serving HTML with inline scripts
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:8080',
    'http://localhost:3000',
    'http://127.0.0.1:5500',  // VS Code Live Server
    'http://localhost:5500',
  ],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please slow down' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter for auth endpoints
  message: { error: 'Too many login attempts' }
});

app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.use('/api/admin/login', authLimiter);

// ============================================
// ROUTES
// ============================================
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/ads',           require('./routes/ads'));
app.use('/api/wallet',        require('./routes/wallet'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/notifications', require('./routes/misc'));
app.use('/api',               require('./routes/misc')); // leaderboard

// ============================================
// SERVER-SENT EVENTS — Real-time push to admin
// ============================================
const adminClients = new Set();

app.get('/api/admin/events', (req, res) => {
  // Validate admin token from query param (SSE can't set headers)
  const token = req.query.token;
  if (!token) return res.status(401).end();
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).end();
  } catch { return res.status(401).end(); }

  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: disable buffering
  });
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  const client = { res };
  adminClients.add(client);
  req.on('close', () => adminClients.delete(client));

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
  }, 25000);
  req.on('close', () => clearInterval(ping));
});

// Broadcast event to all connected admin dashboards
function broadcastToAdmin(event, data) {
  const payload = `data: ${JSON.stringify({ type: event, ...data })}\n\n`;
  adminClients.forEach(client => {
    try { client.res.write(payload); }
    catch { adminClients.delete(client); }
  });
}

// Make broadcaster available to routes
app.locals.broadcast = broadcastToAdmin;

// ============================================
// SERVE STATIC FRONTEND
// ============================================
const frontendPath = path.join(__dirname, '../adpay');
app.use(express.static(frontendPath));

// Catch-all: serve index.html for any unmatched route (SPA support)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/admin')) {
    res.sendFile(path.join(frontendPath, 'index.html'));
  }
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// BROADCAST HOOK — patch routes to emit events
// ============================================
// Wrap pool.query to broadcast on key mutations
const pool = require('./db');
const originalQuery = pool.query.bind(pool);
const monitoredTables = ['users', 'transactions', 'ads'];

// Simple event broadcasting after mutations (non-blocking)
function maybebroadcast(text) {
  if (!text) return;
  const lower = text.toLowerCase();
  if (lower.includes('insert into users'))        broadcastToAdmin('new_user', {});
  if (lower.includes('insert into transactions')) broadcastToAdmin('new_transaction', {});
  if (lower.includes('update transactions'))      broadcastToAdmin('transaction_updated', {});
  if (lower.includes('update users'))             broadcastToAdmin('user_updated', {});
  if (lower.includes('insert into ads') ||
      lower.includes('update ads') ||
      lower.includes('delete from ads'))          broadcastToAdmin('ads_updated', {});
}

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AdPay server running on port ${PORT}`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api`);
  console.log(`   Admin:    http://localhost:${PORT}/admin.html?key=ADPAY_ADMIN_2025\n`);
});

module.exports = app;
