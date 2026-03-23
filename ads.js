const router = require('express').Router();
const pool   = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/ads — all active ads + which ones user watched today
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*,
        EXISTS(
          SELECT 1 FROM ad_views av
          WHERE av.ad_id = a.id
            AND av.user_id = $1
            AND av.view_date = CURRENT_DATE
        ) AS watched_today
       FROM ads a
       WHERE a.status = 'active'
       ORDER BY a.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get ads error:', err);
    res.status(500).json({ error: 'Failed to fetch ads' });
  }
});

// POST /api/ads/:id/watch — record a completed ad view and pay the user
router.post('/:id/watch', authMiddleware, async (req, res) => {
  const adId  = req.params.id;
  const userId = req.user.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock user row to prevent double-earn race condition
    const userRes = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) throw new Error('User not found');

    // Get ad
    const adRes = await client.query(
      'SELECT * FROM ads WHERE id = $1 AND status = $2',
      [adId, 'active']
    );
    const ad = adRes.rows[0];
    if (!ad) throw new Error('Ad not found or inactive');

    // Check already watched today
    const viewCheck = await client.query(
      `SELECT id FROM ad_views
       WHERE user_id = $1 AND ad_id = $2 AND view_date = CURRENT_DATE`,
      [userId, adId]
    );
    if (viewCheck.rows.length) {
      return res.status(409).json({ error: 'Already watched today' });
    }

    const earned = parseFloat(ad.pay);

    // Record the view
    await client.query(
      'INSERT INTO ad_views (user_id, ad_id, earned) VALUES ($1, $2, $3)',
      [userId, adId, earned]
    );

    // Increment ad view count
    await client.query('UPDATE ads SET views = views + 1 WHERE id = $1', [adId]);

    // Credit user
    await client.query(
      `UPDATE users SET
         balance      = balance + $1,
         total_earned = total_earned + $1,
         ads_watched  = ads_watched + 1,
         tier         = CASE
           WHEN total_earned + $1 >= 100 THEN 'Pro Earner'
           WHEN total_earned + $1 >= 20  THEN 'Regular'
           ELSE 'Starter'
         END
       WHERE id = $2`,
      [earned, userId]
    );

    // Log transaction
    const txnRes = await client.query(
      `INSERT INTO transactions (user_id, type, amount, method, description, status)
       VALUES ($1, 'earning', $2, 'Ad Watch', $3, 'completed')
       RETURNING *`,
      [userId, earned, `${ad.name} Ad`]
    );

    // Pay referrer 10%
    if (user.referred_by) {
      const bonus = parseFloat((earned * 0.1).toFixed(4));
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [bonus, user.referred_by]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, method, description, status)
         VALUES ($1, 'earning', $2, 'Referral Bonus', $3, 'completed')`,
        [user.referred_by, bonus, `Referral: ${user.name} watched ${ad.name}`]
      );
    }

    await client.query('COMMIT');

    // Fetch updated user
    const updatedUser = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    res.json({
      earned,
      transaction: txnRes.rows[0],
      user: sanitizeUser(updatedUser.rows[0])
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.message === 'Already watched today') {
      return res.status(409).json({ error: err.message });
    }
    console.error('Watch ad error:', err);
    res.status(500).json({ error: 'Failed to record ad view' });
  } finally {
    client.release();
  }
});

function sanitizeUser(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

module.exports = router;
