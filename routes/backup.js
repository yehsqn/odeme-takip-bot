const express = require('express');
const router = express.Router();
const { ensureSelfParam } = require('../middleware/session');

// Yoldaki :userId oturum sahibi olmalı (başkasının verisine erişimi engeller)
router.param('userId', ensureSelfParam);
const { db } = require('../db/turso');
const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// GET /api/backup/settings/:userId
router.get('/settings/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT backup_enabled, backup_time FROM settings WHERE user_id = ?',
      args: [req.params.userId]
    });
    const row = result.rows[0];
    res.json({
      success: true,
      backup: row ? { enabled: !!row.backup_enabled, time: row.backup_time || '00:00' } : { enabled: false, time: '00:00' }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/backup/settings
router.post('/settings', async (req, res) => {
  try {
    const { userId, settings: backupSettings } = req.body;
    await db.execute({
      sql: `INSERT INTO settings (id, user_id, backup_enabled, backup_time) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET backup_enabled = excluded.backup_enabled, backup_time = excluded.backup_time`,
      args: [genId(), userId, backupSettings.enabled ? 1 : 0, backupSettings.time || '00:00']
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
