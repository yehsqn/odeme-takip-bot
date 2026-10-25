const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');
const { sendWsEvent, sendToUser } = require('../websocket');

const genId = () => crypto.randomBytes(12).toString('hex');

// ── Güvenlik yardımcıları ───────────────────────────────────────────────
// Kullanıcılar birbirlerinin e-postasını görmez: yalnızca görünen ad, avatar ve arkadaş kodu.
const publicName = (row) => (row?.display_name && String(row.display_name).trim()) || 'PayPulse kullanıcısı';

// Tahmin edilemez arkadaş kodu: PP- + 8 karakter (karışmaya yol açan 0/O/1/I yok)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomFriendCode = () => 'PP-' + Array.from(crypto.randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

async function ensureFriendCode(userId, current) {
  if (current && /^PP-[A-Z2-9]{8}$/.test(current)) return current;
  for (let i = 0; i < 5; i++) {
    const code = randomFriendCode();
    const taken = await db.execute({ sql: 'SELECT 1 FROM users WHERE friend_code = ?', args: [code] });
    if (!taken.rows.length) {
      await db.execute({ sql: 'UPDATE users SET friend_code = ? WHERE id = ?', args: [code, userId] });
      return code;
    }
  }
  throw new Error('Arkadaş kodu üretilemedi');
}

// Kullanıcı başına basit hız sınırı (istek / mesaj / şikayet spam'ine karşı)
const buckets = new Map();
function rateLimited(userId, kind, max, windowMs) {
  const key = `${kind}:${userId}`;
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}

const MSG_TYPES = new Set(['text', 'split_bill']);
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

/** Mesaj ek verisi: yalnızca bölüşüm isteğinin tutar + açıklaması saklanır */
function sanitizeMetadata(type, metadata) {
  if (type !== 'split_bill' || !metadata || typeof metadata !== 'object') return {};
  const amount = Number(metadata.amount);
  return {
    amount: Number.isFinite(amount) && amount > 0 && amount < 1e9 ? Math.round(amount * 100) / 100 : 0,
    description: clean(metadata.description, 120),
  };
}

// Helper: Kullanıcıların birbirini engelleyip engellemediğini kontrol eder
async function isBlockedEitherWay(userId1, userId2) {
  try {
    const r = await db.execute({
      sql: `SELECT id FROM blocked_users
            WHERE (blocker_id = ? AND blocked_id = ?)
               OR (blocker_id = ? AND blocked_id = ?)`,
      args: [userId1, userId2, userId2, userId1]
    });
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

async function areFriends(userId1, userId2) {
  const r = await db.execute({
    sql: `SELECT 1 FROM friendships
          WHERE status = 'accepted'
            AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
    args: [userId1, userId2, userId2, userId1]
  });
  return r.rows.length > 0;
}

// GET /api/social/me — Profil ve arkadaşlık özeti
router.get('/me', async (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(401).json({ success: false, error: 'Oturum gerekli' });

    const r = await db.execute({
      sql: `SELECT id, display_name, avatar, friend_code FROM users WHERE id = ?`,
      args: [userId]
    });
    const user = r.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const friendCode = await ensureFriendCode(userId, user.friend_code);

    const [friendsCnt, pendingCnt, blockedCnt] = await Promise.all([
      db.execute({
        sql: `SELECT COUNT(*) as cnt FROM friendships WHERE (requester_id = ? OR recipient_id = ?) AND status = 'accepted'`,
        args: [userId, userId]
      }),
      db.execute({
        sql: `SELECT COUNT(*) as cnt FROM friendships WHERE recipient_id = ? AND status = 'pending'`,
        args: [userId]
      }),
      db.execute({
        sql: `SELECT COUNT(*) as cnt FROM blocked_users WHERE blocker_id = ?`,
        args: [userId]
      })
    ]);

    res.json({
      success: true,
      profile: {
        id: user.id,
        displayName: publicName(user),
        avatar: user.avatar || '',
        friendCode
      },
      stats: {
        friendsCount: Number(friendsCnt.rows[0]?.cnt || 0),
        pendingCount: Number(pendingCnt.rows[0]?.cnt || 0),
        blockedCount: Number(blockedCnt.rows[0]?.cnt || 0)
      }
    });
  } catch (err) {
    console.error('[SOCIAL] Me error:', err.message);
    res.status(500).json({ success: false, error: 'Profil bilgisi alınamadı' });
  }
});

// GET /api/social/friends — Arkadaş listesi ve gelen/giden istekler
router.get('/friends', async (req, res) => {
  try {
    const userId = req.authUserId;

    // Engellenen / engelleyen kullanıcı kimliklerini topla (iki yönde)
    const blockedRes = await db.execute({
      sql: `SELECT blocked_id AS other FROM blocked_users WHERE blocker_id = ?
            UNION
            SELECT blocker_id AS other FROM blocked_users WHERE blocked_id = ?`,
      args: [userId, userId]
    });
    const blockedSet = new Set(blockedRes.rows.map(b => b.other));

    // Kabul edilmiş arkadaşlar
    const fRes = await db.execute({
      sql: `SELECT f.id as friendship_id, f.status, f.created_at,
                   u.id as user_id, u.display_name, u.avatar, u.friend_code,
                   (SELECT content FROM messages
                    WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id)
                    ORDER BY datetime(created_at) DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM messages
                    WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id)
                    ORDER BY datetime(created_at) DESC LIMIT 1) as last_message_at,
                   (SELECT COUNT(*) FROM messages
                    WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread_count
            FROM friendships f
            JOIN users u ON (u.id = CASE WHEN f.requester_id = ? THEN f.recipient_id ELSE f.requester_id END)
            WHERE (f.requester_id = ? OR f.recipient_id = ?) AND f.status = 'accepted'`,
      args: [userId, userId, userId, userId, userId, userId, userId, userId]
    });

    const friends = fRes.rows
      .filter(f => !blockedSet.has(f.user_id))
      .map(f => ({
        friendshipId: f.friendship_id,
        id: f.user_id,
        displayName: publicName(f),
        avatar: f.avatar || '',
        friendCode: f.friend_code || '',
        lastMessage: f.last_message || null,
        lastMessageAt: f.last_message_at || null,
        unreadCount: Number(f.unread_count || 0)
      }));

    // Gelen istekler
    const incRes = await db.execute({
      sql: `SELECT f.id as request_id, f.created_at,
                   u.id as sender_id, u.display_name, u.avatar, u.friend_code
            FROM friendships f
            JOIN users u ON u.id = f.requester_id
            WHERE f.recipient_id = ? AND f.status = 'pending'`,
      args: [userId]
    });

    const incoming = incRes.rows
      .filter(r => !blockedSet.has(r.sender_id))
      .map(r => ({
        requestId: r.request_id,
        id: r.sender_id,
        displayName: publicName(r),
        avatar: r.avatar || '',
        friendCode: r.friend_code || '',
        createdAt: r.created_at
      }));

    // Giden istekler
    const outRes = await db.execute({
      sql: `SELECT f.id as request_id, f.created_at,
                   u.id as recipient_id, u.display_name, u.avatar, u.friend_code
            FROM friendships f
            JOIN users u ON u.id = f.recipient_id
            WHERE f.requester_id = ? AND f.status = 'pending'`,
      args: [userId]
    });

    const outgoing = outRes.rows
      .filter(r => !blockedSet.has(r.recipient_id))
      .map(r => ({
        requestId: r.request_id,
        id: r.recipient_id,
        displayName: publicName(r),
        avatar: r.avatar || '',
        friendCode: r.friend_code || '',
        createdAt: r.created_at
      }));

    res.json({
      success: true,
      friends,
      incomingRequests: incoming,
      outgoingRequests: outgoing
    });
  } catch (err) {
    console.error('[SOCIAL] Friends error:', err.message);
    res.status(500).json({ success: false, error: 'Arkadaşlar listelenemedi' });
  }
});

// POST /api/social/request — Arkadaşlık isteği gönder (arkadaş kodu veya e-posta ile)
// Kayıtlı e-posta olup olmadığı yanıttan anlaşılmaz (hesap tespiti yapılamasın).
router.post('/request', async (req, res) => {
  try {
    const userId = req.authUserId;
    const query = clean(req.body?.query, 120);

    if (!query) {
      return res.status(400).json({ success: false, error: 'Arkadaş kodu veya e-posta adresi giriniz' });
    }
    if (rateLimited(userId, 'friend-request', 20, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Çok fazla istek gönderdiniz. Bir saat sonra tekrar deneyin.' });
    }

    const genericOk = { success: true, message: 'Bu koda / e-postaya ait bir hesap varsa arkadaşlık isteğin iletildi.' };
    const isEmail = query.includes('@');
    const targetRes = await db.execute({
      sql: isEmail
        ? `SELECT id, display_name FROM users WHERE LOWER(email) = ? LIMIT 1`
        : `SELECT id, display_name FROM users WHERE friend_code = ? LIMIT 1`,
      args: [isEmail ? query.toLowerCase() : query.toUpperCase()]
    });

    const target = targetRes.rows[0];
    if (!target) return res.json(genericOk);

    if (target.id === userId) {
      return res.status(400).json({ success: false, error: 'Kendinizi arkadaş olarak ekleyemezsiniz' });
    }

    // Engellenmiş ya da zaten ilişki varsa da aynı genel yanıt (karşı tarafın engellediği anlaşılmasın)
    if (await isBlockedEitherWay(userId, target.id)) return res.json(genericOk);

    const existing = await db.execute({
      sql: `SELECT id, status FROM friendships
            WHERE (requester_id = ? AND recipient_id = ?)
               OR (requester_id = ? AND recipient_id = ?)`,
      args: [userId, target.id, target.id, userId]
    });
    if (existing.rows.length > 0) return res.json(genericOk);

    const reqId = genId();
    await db.execute({
      sql: `INSERT INTO friendships (id, requester_id, recipient_id, status, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
      args: [reqId, userId, target.id]
    });

    // Karşı tarafa WebSocket ve bildirim (e-posta değil, görünen ad)
    const myUser = (await db.execute({ sql: `SELECT display_name FROM users WHERE id = ?`, args: [userId] })).rows[0];
    const myName = publicName(myUser);

    sendWsEvent(target.id, {
      type: 'FRIEND_REQUEST_RECEIVED',
      request: { requestId: reqId, senderId: userId, senderName: myName, createdAt: new Date().toISOString() }
    });

    sendToUser(target.id, {
      type: 'FRIEND_REQUEST',
      title: '👥 Yeni Arkadaşlık İsteği',
      body: `${myName} sana arkadaşlık isteği gönderdi.`
    }).catch(() => {});

    res.json(genericOk);
  } catch (err) {
    console.error('[SOCIAL] Request error:', err.message);
    res.status(500).json({ success: false, error: 'İstek gönderilemedi' });
  }
});

// POST /api/social/respond — İsteği onayla veya reddet
router.post('/respond', async (req, res) => {
  try {
    const userId = req.authUserId;
    const { requestId, action } = req.body; // action: 'accept' | 'reject'

    if (!requestId || !['accept', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Geçersiz parametre' });
    }

    const r = await db.execute({
      sql: `SELECT * FROM friendships WHERE id = ? AND recipient_id = ? AND status = 'pending'`,
      args: [String(requestId), userId]
    });

    const rel = r.rows[0];
    if (!rel) return res.status(404).json({ success: false, error: 'İstek bulunamadı' });

    if (action === 'accept') {
      await db.execute({
        sql: `UPDATE friendships SET status = 'accepted', updated_at = datetime('now') WHERE id = ?`,
        args: [rel.id]
      });

      sendWsEvent(rel.requester_id, { type: 'FRIEND_REQUEST_ACCEPTED', userId });
      res.json({ success: true, message: 'Arkadaşlık isteği kabul edildi.' });
    } else {
      await db.execute({ sql: `DELETE FROM friendships WHERE id = ?`, args: [rel.id] });
      res.json({ success: true, message: 'İstek reddedildi.' });
    }
  } catch (err) {
    console.error('[SOCIAL] Respond error:', err.message);
    res.status(500).json({ success: false, error: 'İşlem gerçekleştirilemedi' });
  }
});

// DELETE /api/social/friend/:friendId — Arkadaşı listeden çıkar (ya da isteği geri çek)
router.delete('/friend/:friendId', async (req, res) => {
  try {
    const userId = req.authUserId;
    const friendId = String(req.params.friendId);

    await db.execute({
      sql: `DELETE FROM friendships
            WHERE (requester_id = ? AND recipient_id = ?)
               OR (requester_id = ? AND recipient_id = ?)`,
      args: [userId, friendId, friendId, userId]
    });

    res.json({ success: true, message: 'Arkadaşlıktan çıkarıldı.' });
  } catch (err) {
    console.error('[SOCIAL] Remove friend error:', err.message);
    res.status(500).json({ success: false, error: 'İşlem yapılamadı' });
  }
});

// GET /api/social/messages/:friendId — Mesaj geçmişi (yalnızca arkadaşlar arası)
router.get('/messages/:friendId', async (req, res) => {
  try {
    const userId = req.authUserId;
    const friendId = String(req.params.friendId);

    if (await isBlockedEitherWay(userId, friendId)) {
      return res.status(403).json({ success: false, blocked: true, error: 'Bu kullanıcı engellenmiş durumda.' });
    }
    if (!(await areFriends(userId, friendId))) {
      return res.status(403).json({ success: false, error: 'Yalnızca arkadaşlarınla mesajlaşabilirsin.' });
    }

    // Son 150 mesaj (eskiden yeniye)
    const r = await db.execute({
      sql: `SELECT * FROM (
              SELECT id, sender_id, receiver_id, content, msg_type, metadata, is_read, created_at
              FROM messages
              WHERE (sender_id = ? AND receiver_id = ?)
                 OR (sender_id = ? AND receiver_id = ?)
              ORDER BY datetime(created_at) DESC
              LIMIT 150
            ) ORDER BY datetime(created_at) ASC`,
      args: [userId, friendId, friendId, userId]
    });

    await db.execute({
      sql: `UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      args: [friendId, userId]
    });

    const messages = r.rows.map(m => {
      let metadata = {};
      try { metadata = m.metadata ? JSON.parse(m.metadata) : {}; } catch { metadata = {}; }
      return {
        id: m.id,
        senderId: m.sender_id,
        receiverId: m.receiver_id,
        content: m.content,
        type: MSG_TYPES.has(m.msg_type) ? m.msg_type : 'text',
        metadata,
        isRead: Boolean(m.is_read),
        createdAt: m.created_at,
        isMine: m.sender_id === userId
      };
    });

    res.json({ success: true, messages });
  } catch (err) {
    console.error('[SOCIAL] Get messages error:', err.message);
    res.status(500).json({ success: false, error: 'Mesajlar getirilemedi' });
  }
});

// POST /api/social/messages — Mesaj gönder (yalnızca kabul edilmiş arkadaşa)
router.post('/messages', async (req, res) => {
  try {
    const userId = req.authUserId;
    const receiverId = String(req.body?.receiverId || '');
    const content = clean(req.body?.content, 1000);
    const type = MSG_TYPES.has(req.body?.type) ? req.body.type : 'text';
    const metadata = sanitizeMetadata(type, req.body?.metadata);

    if (!receiverId || !content) {
      return res.status(400).json({ success: false, error: 'Alıcı ve mesaj içeriği zorunludur' });
    }
    if (rateLimited(userId, 'message', 30, 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Çok hızlı mesaj gönderiyorsun. Biraz bekle.' });
    }
    if (await isBlockedEitherWay(userId, receiverId)) {
      return res.status(403).json({ success: false, error: 'Engellenen bir kullanıcıya mesaj gönderemezsiniz.' });
    }
    if (!(await areFriends(userId, receiverId))) {
      return res.status(403).json({ success: false, error: 'Yalnızca arkadaşlarına mesaj gönderebilirsin.' });
    }

    const msgId = genId();
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO messages (id, sender_id, receiver_id, content, msg_type, metadata, is_read, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      args: [msgId, userId, receiverId, content, type, JSON.stringify(metadata)]
    });

    const messageObj = { id: msgId, senderId: userId, receiverId, content, type, metadata, isRead: false, createdAt: now, isMine: false };

    sendWsEvent(receiverId, { type: 'CHAT_MESSAGE', message: messageObj });

    const sender = (await db.execute({ sql: `SELECT display_name FROM users WHERE id = ?`, args: [userId] })).rows[0];
    sendToUser(receiverId, {
      type: 'CHAT',
      title: `💬 ${publicName(sender)}`,
      body: content.length > 60 ? content.slice(0, 60) + '...' : content
    }).catch(() => {});

    res.json({ success: true, message: { ...messageObj, isMine: true } });
  } catch (err) {
    console.error('[SOCIAL] Send message error:', err.message);
    res.status(500).json({ success: false, error: 'Mesaj gönderilemedi' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GOOGLE PLAY UGC POLİTİKASI GEREKSİNİMLERİ (ENGELLEME & ŞİKAYET)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/social/block — Kullanıcıyı engelle
router.post('/block', async (req, res) => {
  try {
    const userId = req.authUserId;
    const targetUserId = String(req.body?.targetUserId || '');

    if (!targetUserId || targetUserId === userId) {
      return res.status(400).json({ success: false, error: 'Geçersiz hedef kullanıcı' });
    }
    const exists = await db.execute({ sql: 'SELECT 1 FROM users WHERE id = ?', args: [targetUserId] });
    if (!exists.rows.length) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    await db.batch([
      {
        sql: `INSERT OR IGNORE INTO blocked_users (id, blocker_id, blocked_id, created_at)
              VALUES (?, ?, ?, datetime('now'))`,
        args: [genId(), userId, targetUserId]
      },
      {
        sql: `DELETE FROM friendships
              WHERE (requester_id = ? AND recipient_id = ?)
                 OR (requester_id = ? AND recipient_id = ?)`,
        args: [userId, targetUserId, targetUserId, userId]
      }
    ], 'write');

    res.json({ success: true, message: 'Kullanıcı engellendi. Artık sizinle hiçbir şekilde iletişim kuramaz.' });
  } catch (err) {
    console.error('[SOCIAL] Block error:', err.message);
    res.status(500).json({ success: false, error: 'Kullanıcı engellenemedi' });
  }
});

// POST /api/social/unblock — Kullanıcı engelini kaldır
router.post('/unblock', async (req, res) => {
  try {
    const userId = req.authUserId;
    const targetUserId = String(req.body?.targetUserId || '');

    await db.execute({
      sql: `DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?`,
      args: [userId, targetUserId]
    });

    res.json({ success: true, message: 'Engelleme kaldırıldı.' });
  } catch (err) {
    console.error('[SOCIAL] Unblock error:', err.message);
    res.status(500).json({ success: false, error: 'Engelleme kaldırılamadı' });
  }
});

// GET /api/social/blocked — Engellenen kullanıcılar listesi
router.get('/blocked', async (req, res) => {
  try {
    const userId = req.authUserId;
    const r = await db.execute({
      sql: `SELECT b.id as block_id, b.created_at,
                   u.id, u.display_name, u.avatar, u.friend_code
            FROM blocked_users b
            JOIN users u ON u.id = b.blocked_id
            WHERE b.blocker_id = ?
            ORDER BY datetime(b.created_at) DESC`,
      args: [userId]
    });

    const blocked = r.rows.map(u => ({
      blockId: u.block_id,
      id: u.id,
      displayName: publicName(u),
      friendCode: u.friend_code || '',
      avatar: u.avatar || '',
      blockedAt: u.created_at
    }));

    res.json({ success: true, blocked });
  } catch (err) {
    console.error('[SOCIAL] Blocked list error:', err.message);
    res.status(500).json({ success: false, error: 'Engellenenler listelenemedi' });
  }
});

// POST /api/social/report — Kullanıcıyı / Mesajı Şikayet Et (Google Play UGC Uyumluluğu)
router.post('/report', async (req, res) => {
  try {
    const reporterId = req.authUserId;
    const reportedUserId = String(req.body?.reportedUserId || '');
    const reason = clean(req.body?.reason, 100);
    const details = clean(req.body?.details, 1000);
    const messageId = req.body?.messageId ? clean(req.body.messageId, 40) : null;

    if (!reportedUserId || !reason) {
      return res.status(400).json({ success: false, error: 'Şikayet edilen kullanıcı ve gerekçe zorunludur' });
    }
    if (rateLimited(reporterId, 'report', 10, 60 * 60 * 1000)) {
      return res.status(429).json({ success: false, error: 'Çok fazla şikayet gönderdiniz. Daha sonra tekrar deneyin.' });
    }

    await db.execute({
      sql: `INSERT INTO user_reports (id, reporter_id, reported_user_id, reason, details, message_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      args: [genId(), reporterId, reportedUserId, reason, details, messageId]
    });

    // Yönetici incelemesi için geri bildirim kaydı
    try {
      await db.execute({
        sql: `INSERT INTO feedbacks (id, user_id, type, subject, message, created_at)
              VALUES (?, ?, 'report', ?, ?, datetime('now'))`,
        args: [
          genId(),
          reporterId,
          `[UGC Şikayet] ${reason}`,
          `Şikayet Eden: ${reporterId}\nŞikayet Edilen: ${reportedUserId}\nGerekçe: ${reason}\nAçıklama: ${details}\nMesaj ID: ${messageId || 'Yok'}`
        ]
      });
    } catch {}

    res.json({
      success: true,
      message: 'Şikayetiniz alındı. Topluluk ve güvenlik standartlarımız gereği içerik 24 saat içinde incelenerek gereği yapılacaktır. Bildiriminiz için teşekkürler.'
    });
  } catch (err) {
    console.error('[SOCIAL] Report error:', err.message);
    res.status(500).json({ success: false, error: 'Şikayet iletilemedi' });
  }
});

module.exports = router;
