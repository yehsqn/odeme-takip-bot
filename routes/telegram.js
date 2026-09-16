const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { getBot } = require('../bot');

// POST /api/telegram/send
router.post('/send', async (req, res) => {
  try {
    const { userId, message } = req.body;
    const result = await db.execute({ sql: 'SELECT telegram_chat_id FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user?.telegram_chat_id) {
      return res.status(400).json({ success: false, error: 'Telegram bağlı değil' });
    }
    const b = getBot();
    if (!b) return res.status(500).json({ success: false, error: 'Bot yapılandırılmamış' });
    await b.sendMessage(user.telegram_chat_id, message, { parse_mode: 'HTML' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/telegram/notify
router.post('/notify', async (req, res) => {
  try {
    const { userId, payment } = req.body;
    const result = await db.execute({ sql: 'SELECT telegram_chat_id FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user?.telegram_chat_id) {
      return res.json({ success: false, error: 'Telegram bağlı değil' });
    }
    const b = getBot();
    if (!b) return res.json({ success: false, error: 'Bot yapılandırılmamış' });

    const msg = `📝 <b>Yeni Ödeme Eklendi</b>\n\n` +
      `▪️ <b>${payment.title || 'Ödeme'}</b>\n` +
      `💰 Tutar: ${(payment.amount || 0).toLocaleString('tr-TR')} TL\n` +
      `📅 Tarih: ${payment.date || '-'}`;
    await b.sendMessage(user.telegram_chat_id, msg, { parse_mode: 'HTML' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/telegram/test
router.post('/test', async (req, res) => {
  try {
    const { userId } = req.body;
    const result = await db.execute({ sql: 'SELECT telegram_chat_id FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user?.telegram_chat_id) {
      return res.status(400).json({ success: false, error: 'Telegram bağlı değil' });
    }
    const b = getBot();
    if (!b) return res.status(500).json({ success: false, error: 'Bot yapılandırılmamış' });
    await b.sendMessage(user.telegram_chat_id, '✅ Telegram bağlantısı başarılı!');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
