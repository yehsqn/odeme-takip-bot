const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// Helper: format payment row
function formatPayment(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.payment_id || row.id,
    userId: row.user_id,
    title: row.title,
    amount: row.amount,
    installments: row.installments,
    date: row.date,
    category: row.category,
    bank: row.bank,
    type: row.type,
    installmentPlan: JSON.parse(row.installment_plan || '[]'),
    currency: row.currency || 'TRY',
    originalAmount: row.original_amount,
    createdAt: row.created_at,
  };
}

// Helper: format settings row
function formatSettings(row) {
  if (!row) return null;
  return {
    _id: row.id,
    userId: row.user_id,
    cutOffDay: row.cut_off_day || 10,
    notificationTime: row.notification_time || '09:00',
    notificationsEnabled: row.notifications_enabled !== 0,
    notificationDays: row.notification_days ?? 2,
    notifyOnDue: row.notify_on_due !== 0,
    notifyOverdue: row.notify_overdue !== 0,
    banks: JSON.parse(row.banks || '[]'),
    backup: {
      enabled: !!row.backup_enabled,
      time: row.backup_time || '00:00'
    }
  };
}

// GET /api/db/load/:userId — bulk load all data
router.get('/load/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [paymentsResult, settingsResult, incomesResult] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM payments WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
    ]);

    const payments = paymentsResult.rows.map(formatPayment);
    const settings = settingsResult.rows[0] ? formatSettings(settingsResult.rows[0]) : null;

    // Convert dailyIncomes array to object keyed by date
    const dailyIncomesObj = {};
    incomesResult.rows.forEach(d => {
      dailyIncomesObj[d.date] = {
        cash: d.cash || 0,
        cc: d.cc || 0,
        salary: d.salary || 0,
        insurance: d.insurance || 0,
        other: d.other_income || 0,
        expenses: JSON.parse(d.expenses || '[]')
      };
    });

    res.json({
      success: true,
      payments,
      settings,
      dailyIncomes: dailyIncomesObj,
      banks: settings?.banks || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/db/save/payments
router.post('/save/payments', async (req, res) => {
  try {
    const { userId, payments } = req.body;
    if (!userId || !Array.isArray(payments)) {
      return res.status(400).json({ success: false, error: 'userId and payments array required' });
    }

    // Delete existing payments for this user
    await db.execute({ sql: 'DELETE FROM payments WHERE user_id = ?', args: [userId] });

    if (payments.length > 0) {
      const stmts = payments.map(p => ({
        sql: `INSERT INTO payments (id, user_id, payment_id, title, amount, installments, date, category, bank, type, installment_plan, currency, original_amount, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          genId(), userId, p.id || genId(), p.title, p.amount, p.installments,
          p.date, p.category, p.bank, p.type,
          JSON.stringify(p.installmentPlan || []),
          p.currency || 'TRY', p.originalAmount || null, p.createdAt || null
        ]
      }));
      await db.batch(stmts);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/db/save/settings
router.post('/save/settings', async (req, res) => {
  try {
    const { userId, settings: s } = req.body;
    if (!userId || !s) {
      return res.status(400).json({ success: false, error: 'userId and settings required' });
    }

    await db.execute({
      sql: `INSERT INTO settings (id, user_id, cut_off_day, banks, notification_time, notifications_enabled, notification_days, notify_on_due, notify_overdue, backup_enabled, backup_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              cut_off_day = excluded.cut_off_day,
              banks = excluded.banks,
              notification_time = excluded.notification_time,
              notifications_enabled = excluded.notifications_enabled,
              notification_days = excluded.notification_days,
              notify_on_due = excluded.notify_on_due,
              notify_overdue = excluded.notify_overdue,
              backup_enabled = excluded.backup_enabled,
              backup_time = excluded.backup_time`,
      args: [
        genId(), userId,
        s.cutOffDay ?? 10,
        JSON.stringify(s.banks || []),
        s.notificationTime || '09:00',
        s.notificationsEnabled !== false ? 1 : 0,
        s.notificationDays ?? 2,
        s.notifyOnDue !== false ? 1 : 0,
        s.notifyOverdue !== false ? 1 : 0,
        s.backup?.enabled ? 1 : 0,
        s.backup?.time ?? '00:00'
      ]
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/db/save/daily-incomes
router.post('/save/daily-incomes', async (req, res) => {
  try {
    const { userId, dailyIncomes } = req.body;
    if (!userId || !dailyIncomes) {
      return res.status(400).json({ success: false, error: 'userId and dailyIncomes required' });
    }

    const stmts = Object.entries(dailyIncomes).map(([date, data]) => {
      if (!data) return null;
      return {
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
          data.cash || 0, data.cc || 0, data.salary || 0,
          data.insurance || 0, data.other || 0,
          JSON.stringify(data.expenses || [])
        ]
      };
    }).filter(Boolean);

    if (stmts.length > 0) {
      await db.batch(stmts);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/db/save/:collection — generic save for banks, incomes, expenses, etc
router.post('/save/:collection', async (req, res) => {
  try {
    const { collection } = req.params;
    const { userId } = req.body;
    const data = req.body[collection];

    if (!userId || !Array.isArray(data)) {
      return res.status(400).json({ success: false, error: `userId and ${collection} array required` });
    }

    // For banks, save inside settings
    if (collection === 'banks') {
      await db.execute({
        sql: `INSERT INTO settings (id, user_id, banks) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET banks = excluded.banks`,
        args: [genId(), userId, JSON.stringify(data)]
      });
      return res.json({ success: true });
    }

    // Generic: not implemented for other collections yet
    res.json({ success: true, message: `${collection} received (no-op for mobile)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
