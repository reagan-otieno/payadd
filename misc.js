const router = require('express').Router();
const pool   = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/notifications
router.get('/', authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

// GET /api/leaderboard
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, name, total_earned, ads_watched, tier
       FROM users WHERE role = 'user' AND status = 'active'
       ORDER BY total_earned DESC LIMIT 20`
    );
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;
