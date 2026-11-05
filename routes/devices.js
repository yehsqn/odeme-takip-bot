const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');

const validToken = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 4096;

// POST /api/devices — Telefonun bildirim anahtarını oturumdaki hesaba bağlar
router.post('/', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!validToken(token)) return res.status(400).json({ success: false, error: 'Geçersiz cihaz anahtarı' });
    await db.execute({
      sql: `INSERT INTO device_tokens (token, user_id) VALUES (?, ?)
            ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, updated_at = datetime('now')`,
      args: [token, req.authUserId],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Cihaz kaydedilemedi' });
  }
});

// DELETE /api/devices — Çıkışta bu telefona bildirim gitmesini durdurur
router.delete('/', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!validToken(token)) return res.status(400).json({ success: false, error: 'Geçersiz cihaz anahtarı' });
    await db.execute({ sql: 'DELETE FROM device_tokens WHERE token = ? AND user_id = ?', args: [token, req.authUserId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Cihaz silinemedi' });
  }
});

module.exports = router;
