const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// GET /api/income/:userId
router.get('/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM daily_incomes WHERE user_id = ?',
      args: [req.params.userId]
    });
    const records = result.rows.map(row => ({
      _id: row.id,
      userId: row.user_id,
      date: row.date,
      cash: row.cash || 0,
      cc: row.cc || 0,
      salary: row.salary || 0,
      insurance: row.insurance || 0,
      other: row.other_income || 0,
      expenses: JSON.parse(row.expenses || '[]'),
    }));
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/income/:userId/:date — upsert daily record
router.put('/:userId/:date', async (req, res) => {
  try {
    const { userId, date } = req.params;
    const d = req.body;

    await db.execute({
      sql: `INSERT INTO daily_incomes (id, user_id, date, cash, cc, salary, insurance, other_income, expenses)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
              cash = excluded.cash,
              cc = excluded.cc,
              salary = excluded.salary,
              insurance = excluded.insurance,
              other_income = excluded.other_income,
              expenses = excluded.expenses`,
      args: [
        genId(), userId, date,
        d.cash || 0, d.cc || 0, d.salary || 0,
        d.insurance || 0, d.other || 0,
        JSON.stringify(d.expenses || [])
      ]
    });

    const result = await db.execute({
      sql: 'SELECT * FROM daily_incomes WHERE user_id = ? AND date = ?',
      args: [userId, date]
    });
    const row = result.rows[0];
    res.json({
      success: true,
      record: {
        _id: row.id,
        userId: row.user_id,
        date: row.date,
        cash: row.cash || 0,
        cc: row.cc || 0,
        salary: row.salary || 0,
        insurance: row.insurance || 0,
        other: row.other_income || 0,
        expenses: JSON.parse(row.expenses || '[]'),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/income/recover — recover access (reset income password)
router.post('/recover', async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await db.execute({ sql: 'SELECT id FROM users WHERE id = ?', args: [userId] });
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    await db.execute({
      sql: 'UPDATE users SET income_expense_password = NULL WHERE id = ?',
      args: [userId]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
