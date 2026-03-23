const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');
const { authMiddleware } = require('../middleware/auth');

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function makeRefCode(name, id) {
  return 'ADPAY-' + name.split(' ')[0].toUpperCase().slice(0, 4) + id.slice(0, 4).toUpperCase();
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, phone, password, referralCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check duplicate email
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);

    // Check referral code
    let referredById = null;
    if (referralCode) {
      const ref = await client.query('SELECT id FROM users WHERE ref_code = $1', [referralCode]);
      if (ref.rows.length) referredById = ref.rows[0].id;
    }

    const result = await client.query(
      `INSERT INTO users (name, email, phone, password_hash, referred_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, email.toLowerCase(), phone || null, hash, referredById]
    );
    const user = result.rows[0];

    // Set ref code now that we have the UUID
    const refCode = makeRefCode(name, user.id);
    await client.query('UPDATE users SET ref_code = $1 WHERE id = $2', [refCode, user.id]);
    user.ref_code = refCode;

    // Reward referrer
    if (referredById) {
      await client.query('UPDATE users SET referrals = referrals + 1 WHERE id = $1', [referredById]);
      await client.query(
        `INSERT INTO notifications (user_id, icon, title, body)
         VALUES ($1, '👥', 'Referral Bonus!', $2)`,
        [referredById, `${name} joined using your referral code. +$0.50 bonus!`]
      );
    }

    // Welcome notification
    await client.query(
      `INSERT INTO notifications (user_id, icon, title, body)
       VALUES ($1, '🎉', 'Welcome to AdPay!', 'Start watching ads to earn. Your first payout is one ad away!')`,
      [user.id]
    );

    await client.query('COMMIT');

    const token = makeToken({ id: user.id, email: user.email, role: user.role });
    res.status(201).json({
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.role === 'admin') return res.status(401).json({ error: 'Invalid email or password' }); // block admin from user login
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // Update last_seen
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [user.id]);

    const token = makeToken({ id: user.id, email: user.email, role: user.role });
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.*,
        COALESCE(
          (SELECT json_agg(av.ad_id::text)
           FROM ad_views av
           WHERE av.user_id = u.id AND av.view_date = CURRENT_DATE),
          '[]'::json
        ) AS watched_today
       FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

function sanitizeUser(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

module.exports = router;
