const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// Lazy bot
let bot = null;
function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
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

// POST /api/backup/create
router.post('/create', async (req, res) => {
  try {
    const { userId } = req.body;
    const userResult = await db.execute({
      sql: 'SELECT email, telegram_chat_id FROM users WHERE id = ?',
      args: [userId]
    });
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    if (!user.telegram_chat_id) return res.status(400).json({ success: false, error: 'Telegram bağlı değil' });

    const b = getBot();
    if (!b) return res.status(500).json({ success: false, error: 'Bot yapılandırılmamış' });

    const [paymentsResult, settingsResult, incomesResult] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM payments WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
    ]);

    const backupData = {
      date: new Date().toISOString(),
      user: { email: user.email, userId },
      source: 'Mobile Backup',
      settings: settingsResult.rows[0] || {},
      payments: paymentsResult.rows,
      dailyIncomes: incomesResult.rows
    };

    const jsonStr = JSON.stringify(backupData, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf8');
    const fileName = `Yedek_${user.email}_${new Date().toISOString().slice(0, 10)}.json`;

    await b.sendDocument(user.telegram_chat_id, buffer, {
      caption: `📦 <b>Manuel Yedek</b>\n\n📅 ${new Date().toLocaleString('tr-TR')}\n✅ Verileriniz güvenle yedeklendi.`,
      parse_mode: 'HTML'
    }, { filename: fileName, contentType: 'application/json' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
