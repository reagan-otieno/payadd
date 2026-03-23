const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');
const { adminMiddleware } = require('../middleware/auth');

// POST /api/admin/login — separate admin login
router.post('/login', async (req, res) => {
  const { email, password, access_key } = req.body;
  if (
    email      !== process.env.ADMIN_EMAIL      ||
    password   !== process.env.ADMIN_PASSWORD   ||
    access_key !== process.env.ADMIN_ACCESS_KEY
  ) {
    // Log failed attempt
    await pool.query(
      `INSERT INTO admin_log (icon, action) VALUES ('❌', $1)`,
      [`Failed admin login attempt — email: ${email}`]
    ).catch(() => {});
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }

  const token = jwt.sign(
    { id: 'admin', email, role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
  await pool.query(
    `INSERT INTO admin_log (icon, action) VALUES ('✅', $1)`,
    [`Admin logged in at ${new Date().toLocaleString()}`]
  ).catch(() => {});

  res.json({ token });
});

// ── All routes below require admin JWT ──────────────────────────────────────

// GET /api/admin/stats — dashboard overview
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const [users, txns, ads] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total, SUM(ads_watched) AS total_watched FROM users'),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN type='earning'    AND status='completed' THEN amount END), 0) AS total_paid,
          COALESCE(SUM(CASE WHEN type='deposit'    AND status='completed' THEN amount END), 0) AS total_deposits,
          COALESCE(SUM(CASE WHEN status='pending'  AND type='withdrawal'  THEN amount END), 0) AS pending_withdrawals,
          COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_count,
          COALESCE(SUM(CASE WHEN type='earning' AND created_at::date = CURRENT_DATE THEN amount END), 0) AS today_paid,
          COALESCE(SUM(CASE WHEN type='earning' AND created_at >= NOW() - INTERVAL '7 days' THEN amount END), 0) AS week_paid
        FROM transactions
      `),
      pool.query('SELECT COUNT(*) AS total FROM ads WHERE status = $1', ['active']),
    ]);
    res.json({
      total_users:          parseInt(users.rows[0].total),
      total_ads_watched:    parseInt(users.rows[0].total_watched || 0),
      total_paid:           parseFloat(txns.rows[0].total_paid),
      total_deposits:       parseFloat(txns.rows[0].total_deposits),
      pending_withdrawals:  parseFloat(txns.rows[0].pending_withdrawals),
      pending_count:        parseInt(txns.rows[0].pending_count),
      today_paid:           parseFloat(txns.rows[0].today_paid),
      week_paid:            parseFloat(txns.rows[0].week_paid),
      active_ads:           parseInt(ads.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/users — paginated user list with search
router.get('/users', adminMiddleware, async (req, res) => {
  const search = req.query.search || '';
  const page   = parseInt(req.query.page  || '1');
  const limit  = parseInt(req.query.limit || '50');
  const offset = (page - 1) * limit;
  try {
    const where = search
      ? `WHERE (name ILIKE $1 OR email ILIKE $1) AND role = 'user'`
      : `WHERE role = 'user'`;
    const params = search
      ? [`%${search}%`, limit, offset]
      : [limit, offset];
    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT id, name, email, phone, balance, ads_watched, total_earned,
                referrals, tier, status, ref_code, joined_at, last_seen_at
         FROM users ${where}
         ORDER BY joined_at DESC
         LIMIT $${search?2:1} OFFSET $${search?3:2}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) FROM users ${where}`,
        search ? [`%${search}%`] : []
      )
    ]);
    res.json({ users: rows.rows, total: parseInt(count.rows[0].count), page });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// PATCH /api/admin/users/:id/status — suspend or activate
router.patch('/users/:id/status', adminMiddleware, async (req, res) => {
  const { status } = req.body;
  if (!['active','suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const result = await pool.query(
      'UPDATE users SET status = $1 WHERE id = $2 AND role = $3 RETURNING name, status',
      [status, req.params.id, 'user']
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(`INSERT INTO admin_log (icon, action) VALUES ('👤', $1)`,
      [`User ${result.rows[0].name} ${status}`]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// GET /api/admin/transactions — all transactions with filter
router.get('/transactions', adminMiddleware, async (req, res) => {
  const { type, status, page = 1, limit = 100 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const conditions = [];
    const params     = [];
    if (type)   { params.push(type);   conditions.push(`t.type   = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);
    const rows = await pool.query(
      `SELECT t.*, u.name AS user_name, u.email AS user_email
       FROM transactions t
       LEFT JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// PATCH /api/admin/transactions/:id/approve
router.patch('/transactions/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE transactions SET status = 'completed', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND type = 'withdrawal'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found or already processed' });
    const txn = result.rows[0];
    await pool.query(`INSERT INTO notifications (user_id, icon, title, body) VALUES ($1, '💰', 'Withdrawal Approved!', $2)`,
      [txn.user_id, `Your $${parseFloat(txn.amount).toFixed(2)} withdrawal via ${txn.method} has been processed.`]);
    await pool.query(`INSERT INTO admin_log (icon, action) VALUES ('✅', $1)`,
      [`Transaction ${txn.id.slice(0,8)} approved — $${parseFloat(txn.amount).toFixed(2)}`]);
    res.json(txn);
  } catch (err) {
    res.status(500).json({ error: 'Approve failed' });
  }
});

// PATCH /api/admin/transactions/:id/reject
router.patch('/transactions/:id/reject', adminMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE transactions SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND type = 'withdrawal'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const txn = result.rows[0];
    // Refund the balance
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [txn.amount, txn.user_id]);
    await client.query(`INSERT INTO notifications (user_id, icon, title, body) VALUES ($1, '🔄', 'Withdrawal Rejected', $2)`,
      [txn.user_id, `Your $${parseFloat(txn.amount).toFixed(2)} withdrawal was rejected. Balance refunded.`]);
    await client.query(`INSERT INTO admin_log (icon, action) VALUES ('❌', $1)`,
      [`Transaction ${txn.id.slice(0,8)} rejected & refunded $${parseFloat(txn.amount).toFixed(2)}`]);
    await client.query('COMMIT');
    res.json(txn);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Reject failed' });
  } finally {
    client.release();
  }
});

// GET /api/admin/ads — all ads (including paused)
router.get('/ads', adminMiddleware, async (req, res) => {
  try {
    const rows = await pool.query('SELECT * FROM ads ORDER BY created_at DESC');
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ads' });
  }
});

// POST /api/admin/ads — create ad
router.post('/ads', adminMiddleware, async (req, res) => {
  const { name, category, pay, icon, duration, status, description, video_url, thumbnail_url, schedule } = req.body;
  if (!name || !pay) return res.status(400).json({ error: 'Name and pay rate required' });
  try {
    const result = await pool.query(
      `INSERT INTO ads (name, category, pay, icon, duration, status, description, video_url, thumbnail_url, schedule)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, category||'lifestyle', parseFloat(pay), icon||'📱', parseInt(duration)||30,
       status||'active', description||'', video_url||'', thumbnail_url||'',
       schedule ? JSON.stringify(schedule) : null]
    );
    await pool.query(`INSERT INTO admin_log (icon, action) VALUES ('➕', $1)`,
      [`Ad "${name}" created — $${pay}/view`]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create ad' });
  }
});

// PATCH /api/admin/ads/:id — update ad
router.patch('/ads/:id', adminMiddleware, async (req, res) => {
  const { name, category, pay, icon, duration, status, description, video_url, thumbnail_url, schedule } = req.body;
  try {
    const result = await pool.query(
      `UPDATE ads SET
         name=$1, category=$2, pay=$3, icon=$4, duration=$5,
         status=$6, description=$7, video_url=$8, thumbnail_url=$9, schedule=$10
       WHERE id=$11 RETURNING *`,
      [name, category, parseFloat(pay), icon, parseInt(duration),
       status, description, video_url, thumbnail_url,
       schedule ? JSON.stringify(schedule) : null,
       req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ad not found' });
    await pool.query(`INSERT INTO admin_log (icon, action) VALUES ('✏️', $1)`,
      [`Ad "${name}" updated`]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ad' });
  }
});

// DELETE /api/admin/ads/:id
router.delete('/ads/:id', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM ads WHERE id = $1 RETURNING name', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Ad not found' });
    await pool.query(`INSERT INTO admin_log (icon, action) VALUES ('🗑', $1)`,
      [`Ad "${result.rows[0].name}" deleted`]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete ad' });
  }
});

// GET /api/admin/analytics — leaderboard + top ads
router.get('/analytics', adminMiddleware, async (req, res) => {
  try {
    const [topUsers, topAds, recentSignups] = await Promise.all([
      pool.query(`SELECT id, name, total_earned, ads_watched, tier FROM users
                  WHERE role='user' ORDER BY total_earned DESC LIMIT 10`),
      pool.query(`SELECT id, name, icon, views, pay, category FROM ads
                  ORDER BY views DESC LIMIT 10`),
      pool.query(`SELECT id, name, email, tier, joined_at FROM users
                  WHERE role='user' ORDER BY joined_at DESC LIMIT 10`)
    ]);
    res.json({
      top_users:      topUsers.rows,
      top_ads:        topAds.rows,
      recent_signups: recentSignups.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// GET /api/admin/log — activity log
router.get('/log', adminMiddleware, async (req, res) => {
  try {
    const rows = await pool.query('SELECT * FROM admin_log ORDER BY created_at DESC LIMIT 100');
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

module.exports = router;
