const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/turso');

// Yalnızca satın alma hunisi: tutar veya finansal kayıt tutulmaz
const EVENTS = new Set([
  'paywall_view', 'upgrade_view', 'trial_start',
  'purchase_start', 'purchase_success', 'purchase_cancel', 'purchase_fail',
  'referral_share',
]);

// POST /api/events
router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name || '');
    if (!EVENTS.has(name)) return res.status(400).json({ success: false, error: 'Geçersiz olay' });
    await db.execute({
      sql: 'INSERT INTO app_events (id, user_id, name, detail) VALUES (?, ?, ?, ?)',
      args: [crypto.randomBytes(12).toString('hex'), req.authUserId, name, String(req.body?.detail || '').slice(0, 60)],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Olay kaydedilemedi' });
  }
});

module.exports = router;
