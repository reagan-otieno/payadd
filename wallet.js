const router = require('express').Router();
const pool   = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/wallet — balance + recent transactions
router.get('/', authMiddleware, async (req, res) => {
  try {
    const [userRes, txnRes] = await Promise.all([
      pool.query('SELECT balance, total_earned FROM users WHERE id = $1', [req.user.id]),
      pool.query(
        `SELECT * FROM transactions WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 50`,
        [req.user.id]
      )
    ]);
    res.json({
      balance:      parseFloat(userRes.rows[0]?.balance || 0),
      total_earned: parseFloat(userRes.rows[0]?.total_earned || 0),
      transactions: txnRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// POST /api/wallet/deposit
router.post('/deposit', authMiddleware, async (req, res) => {
  const { amount, currency, method, usd_amount } = req.body;
  const usd = parseFloat(usd_amount || amount);
  if (!usd || usd < 1) return res.status(400).json({ error: 'Minimum deposit is $1' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [usd, req.user.id]
    );
    const txn = await client.query(
      `INSERT INTO transactions (user_id, type, amount, method, description, status, metadata)
       VALUES ($1, 'deposit', $2, $3, $4, 'completed', $5) RETURNING *`,
      [
        req.user.id,
        usd,
        method || 'Bank Transfer',
        `Deposit via ${method}${currency !== 'USD' ? ` (${amount} ${currency})` : ''}`,
        JSON.stringify({ original_amount: amount, currency: currency || 'USD' })
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, icon, title, body)
       VALUES ($1, '💵', 'Deposit Received', $2)`,
      [req.user.id, `$${usd.toFixed(2)} deposited via ${method}`]
    );
    await client.query('COMMIT');
    const user = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ transaction: txn.rows[0], balance: parseFloat(user.rows[0].balance) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    client.release();
  }
});

// POST /api/wallet/withdraw
router.post('/withdraw', authMiddleware, async (req, res) => {
  const { amount, currency, method } = req.body;
  const usd = parseFloat(amount);
  if (!usd || usd < 5) return res.status(400).json({ error: 'Minimum withdrawal is $5' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query(
      'SELECT balance FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    if (parseFloat(userRes.rows[0].balance) < usd) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    await client.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [usd, req.user.id]
    );
    const txn = await client.query(
      `INSERT INTO transactions (user_id, type, amount, method, description, status, metadata)
       VALUES ($1, 'withdrawal', $2, $3, $4, 'pending', $5) RETURNING *`,
      [
        req.user.id,
        usd,
        method || 'Bank Account',
        `Withdrawal to ${method}`,
        JSON.stringify({ currency: currency || 'USD' })
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, icon, title, body)
       VALUES ($1, '💸', 'Withdrawal Submitted', $2)`,
      [req.user.id, `$${usd.toFixed(2)} withdrawal to ${method} is being processed`]
    );
    await client.query('COMMIT');
    const user = await pool.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
    res.json({ transaction: txn.rows[0], balance: parseFloat(user.rows[0].balance) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Withdrawal failed' });
  } finally {
    client.release();
  }
});

// GET /api/wallet/transactions — full history with pagination
router.get('/transactions', authMiddleware, async (req, res) => {
  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '20');
  const type  = req.query.type;
  const offset = (page - 1) * limit;

  try {
    const where = type ? 'WHERE user_id = $1 AND type = $2' : 'WHERE user_id = $1';
    const params = type ? [req.user.id, type, limit, offset] : [req.user.id, limit, offset];
    const idxShift = type ? 0 : -1;

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT * FROM transactions ${where}
         ORDER BY created_at DESC LIMIT $${3 + (type?0:-1)+1} OFFSET $${4 + (type?0:-1)+1}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*) FROM transactions ${where}`,
        type ? [req.user.id, type] : [req.user.id]
      )
    ]);

    res.json({
      transactions: rows.rows,
      total: parseInt(count.rows[0].count),
      page,
      pages: Math.ceil(parseInt(count.rows[0].count) / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

module.exports = router;
