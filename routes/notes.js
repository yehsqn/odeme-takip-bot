const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');
const { ensureSelfParam } = require('../middleware/session');

router.param('userId', ensureSelfParam);

// GET /api/notes/:userId — Kullanıcının notlarını getir
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await db.execute({
      sql: `SELECT id, user_id as userId, title, content, category, color, is_pinned as isPinned, created_at as createdAt, updated_at as updatedAt
            FROM user_notes
            WHERE user_id = ?
            ORDER BY is_pinned DESC, datetime(created_at) DESC`,
      args: [userId]
    });
    res.json({ success: true, notes: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Notlar alınamadı. Lütfen tekrar deneyin.' });
  }
});

// POST /api/notes — Yeni not oluştur
router.post('/', async (req, res) => {
  try {
    const { userId, title, content, category, color, isPinned } = req.body;
    const uid = req.authUserId || userId;
    if (!uid) return res.status(400).json({ success: false, error: 'userId gerekli' });
    if (!title && !content) return res.status(400).json({ success: false, error: 'Başlık veya içerik gerekli' });

    // Kullanıcı başına not sınırı (veritabanı şişirilmesin)
    const cnt = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM user_notes WHERE user_id = ?', args: [uid] });
    if (Number(cnt.rows[0]?.c || 0) >= 1000) return res.status(400).json({ success: false, error: 'En fazla 1000 not saklayabilirsin.' });

    const noteId = crypto.randomBytes(12).toString('hex');
    const noteTitle = String(title || 'Başlıksız Not').trim().slice(0, 150);
    const noteContent = String(content || '').trim().slice(0, 5000);
    const noteCategory = String(category || 'Genel').slice(0, 50);
    const noteColor = String(color || '#6366f1').slice(0, 20);
    const pinned = isPinned ? 1 : 0;
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO user_notes (id, user_id, title, content, category, color, is_pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [noteId, uid, noteTitle, noteContent, noteCategory, noteColor, pinned, now, now]
    });

    res.json({
      success: true,
      note: {
        id: noteId,
        userId: uid,
        title: noteTitle,
        content: noteContent,
        category: noteCategory,
        color: noteColor,
        isPinned: !!pinned,
        createdAt: now,
        updatedAt: now
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Not kaydedilemedi. Lütfen tekrar deneyin.' });
  }
});

// PUT /api/notes/:id — Notu güncelle
router.put('/:id', async (req, res) => {
  try {
    const noteId = req.params.id;
    const uid = req.authUserId;
    const { title, content, category, color, isPinned } = req.body;

    const existing = await db.execute({
      sql: 'SELECT * FROM user_notes WHERE id = ? AND user_id = ?',
      args: [noteId, uid]
    });
    if (!existing.rows.length) {
      return res.status(404).json({ success: false, error: 'Not bulunamadı veya yetkiniz yok.' });
    }

    const current = existing.rows[0];
    const newTitle = title !== undefined ? String(title).slice(0, 150) : current.title;
    const newContent = content !== undefined ? String(content).slice(0, 5000) : current.content;
    const newCategory = category !== undefined ? String(category).slice(0, 50) : current.category;
    const newColor = color !== undefined ? String(color).slice(0, 20) : current.color;
    const newPinned = isPinned !== undefined ? (isPinned ? 1 : 0) : current.is_pinned;
    const now = new Date().toISOString();

    await db.execute({
      sql: `UPDATE user_notes
            SET title = ?, content = ?, category = ?, color = ?, is_pinned = ?, updated_at = ?
            WHERE id = ? AND user_id = ?`,
      args: [newTitle, newContent, newCategory, newColor, newPinned, now, noteId, uid]
    });

    res.json({
      success: true,
      note: {
        id: noteId,
        userId: uid,
        title: newTitle,
        content: newContent,
        category: newCategory,
        color: newColor,
        isPinned: !!newPinned,
        createdAt: current.created_at,
        updatedAt: now
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Not güncellenemedi. Lütfen tekrar deneyin.' });
  }
});

// DELETE /api/notes/:id — Notu sil
router.delete('/:id', async (req, res) => {
  try {
    const noteId = req.params.id;
    const uid = req.authUserId;

    await db.execute({
      sql: 'DELETE FROM user_notes WHERE id = ? AND user_id = ?',
      args: [noteId, uid]
    });

    res.json({ success: true, message: 'Not silindi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Not silinemedi. Lütfen tekrar deneyin.' });
  }
});

module.exports = router;
