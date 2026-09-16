const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');

// Helper: satır → bildirim nesnesi
function formatNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    paymentId: row.payment_id || null,
    isRead: row.is_read === 1,
    createdAt: row.created_at,
  };
}

// GET /api/notifications/:userId — tüm bildirimler (son 100)
router.get('/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM notifications
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 100`,
      args: [req.params.userId],
    });
    const notifications = result.rows.map(formatNotification);
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    res.json({ success: true, notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/:userId/unread-count — okunmamış sayısı
router.get('/:userId/unread-count', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
      args: [req.params.userId],
    });
    res.json({ success: true, count: Number(result.rows[0]?.cnt || 0) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/notifications/:id/read — tek bildirimi okundu işaretle
router.put('/:id/read', async (req, res) => {
  try {
    await db.execute({
      sql: `UPDATE notifications SET is_read = 1 WHERE id = ?`,
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/notifications/:userId/read-all — tümünü okundu işaretle
router.put('/:userId/read-all', async (req, res) => {
  try {
    await db.execute({
      sql: `UPDATE notifications SET is_read = 1 WHERE user_id = ?`,
      args: [req.params.userId],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/notifications/:userId — kullanıcının tüm bildirimlerini sil
router.delete('/:userId', async (req, res) => {
  try {
    await db.execute({
      sql: `DELETE FROM notifications WHERE user_id = ?`,
      args: [req.params.userId],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/test-push — anında test bildirimi gönderir
router.post('/test-push', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const { sendToUser } = require('../websocket');
    await sendToUser(userId, {
      type: 'test_notification',
      title: '🔔 Test Bildirimi Başarılı!',
      body: 'Ödeme Takip anlık bildirim ve ses sistemi kusursuz çalışıyor.',
    });

    res.json({ success: true, message: 'Test bildirimi gönderildi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/trigger-reminders — manuel hatırlatıcı tetikleme
router.post('/trigger-reminders', async (req, res) => {
  try {
    const { userId } = req.body || {};
    const { checkUpcomingPayments } = require('../cron');
    const result = await checkUpcomingPayments(true, userId || null);
    res.json({ success: true, ...result, message: 'Hatırlatıcı kontrolü tamamlandı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
