const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

const DEFAULT_BANKS = [
  { name: 'Akbank', cutOffDay: 10, dueDay: 3, color: 'bg-red-600 text-white border-red-700' },
  { name: 'Garanti BBVA', cutOffDay: 14, dueDay: 7, color: 'bg-green-600 text-white border-green-700' },
  { name: 'İş Bankası', cutOffDay: 25, dueDay: 18, color: 'bg-blue-800 text-white border-blue-900' },
  { name: 'Yapı Kredi', cutOffDay: 3, dueDay: 27, color: 'bg-blue-500 text-white border-blue-600' },
  { name: 'Ziraat', cutOffDay: 20, dueDay: 13, color: 'bg-yellow-400 text-yellow-900 border-yellow-500' },
  { name: 'Halkbank', cutOffDay: 28, dueDay: 21, color: 'bg-orange-500 text-white border-orange-600' },
];

// Helper: row → settings response
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

// GET /api/settings/:userId
router.get('/:userId', async (req, res) => {
  try {
    let result = await db.execute({
      sql: 'SELECT * FROM settings WHERE user_id = ?',
      args: [req.params.userId]
    });
    let settings = result.rows[0];

    if (!settings) {
      const id = genId();
      await db.execute({
        sql: `INSERT INTO settings (id, user_id, banks, notification_time, notifications_enabled, notification_days, notify_on_due, notify_overdue)
              VALUES (?, ?, ?, '09:00', 1, 2, 1, 1)`,
        args: [id, req.params.userId, JSON.stringify(DEFAULT_BANKS)]
      });
      result = await db.execute({ sql: 'SELECT * FROM settings WHERE id = ?', args: [id] });
      settings = result.rows[0];
    }

    res.json({ success: true, settings: formatSettings(settings) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/settings/:userId
router.put('/:userId', async (req, res) => {
  try {
    const s = req.body;
    const userId = req.params.userId;

    // Build upsert
    const banks = s.banks ? JSON.stringify(s.banks) : JSON.stringify(DEFAULT_BANKS);

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
        banks,
        s.notificationTime || '09:00',
        s.notificationsEnabled !== false ? 1 : 0,
        s.notificationDays ?? 2,
        s.notifyOnDue !== false ? 1 : 0,
        s.notifyOverdue !== false ? 1 : 0,
        s.backup?.enabled ? 1 : 0,
        s.backup?.time ?? '00:00'
      ]
    });

    const result = await db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] });
    res.json({ success: true, settings: formatSettings(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
