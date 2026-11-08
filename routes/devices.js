const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { sendPush, pushConfigured } = require('../push');

const TEST_DELAY_MS = 10000;
const lastTest = new Map(); // kullanıcı başına dakikada bir test

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

// POST /api/devices/test — Kullanıcının kendi telefonlarına 10 sn sonra test bildirimi gönderir
// (uygulamayı kapatmaya zaman kalsın diye). Yalnızca oturumdaki hesabın cihazlarına gider.
router.post('/test', async (req, res) => {
  try {
    const now = Date.now();
    if (now - (lastTest.get(req.authUserId) || 0) < 60000) {
      return res.status(429).json({ success: false, error: 'Bir dakika içinde yalnızca bir test gönderilebilir.' });
    }
    const firebase = pushConfigured();
    const devices = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?', args: [req.authUserId] })).rows[0]?.n || 0);
    if (!firebase || !devices) return res.json({ success: true, firebase, devices, scheduled: false });
    lastTest.set(req.authUserId, now);
    const userId = req.authUserId;
    setTimeout(() => {
      sendPush(userId, { type: 'TEST' })
        .then(r => console.log(`[PUSH] Test: ${r.sent} gönderildi, ${r.failed} başarısız${r.errors?.length ? ' (' + r.errors.join(', ') + ')' : ''}`))
        .catch(err => console.error('[PUSH] Test gönderilemedi:', err.message));
    }, TEST_DELAY_MS);
    res.json({ success: true, firebase, devices, scheduled: true, delaySec: TEST_DELAY_MS / 1000 });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Test bildirimi hazırlanamadı' });
  }
});

module.exports = router;
