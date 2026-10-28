/**
 * Yönetici işlemleri (yalnızca admin).
 * POST /api/admin/broadcast-update — yeni sürüm duyurusu: herkese uygulama içi bildirim,
 *   isteğe bağlı olarak doğrulanmış e-postalara (arka planda, sırayla).
 * GET  /api/admin/broadcasts       — geçmiş duyurular
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/turso');
const { requireAdmin, invalidateUser, unsubscribeSig } = require('../middleware/session');
const { sendToUser } = require('../websocket');
const { sendMail } = require('../mailer');

router.use(requireAdmin);

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
const API_BASE_URL = (process.env.API_BASE_URL || 'https://api.yehsqn.com').replace(/\/+$/, '');
const unsubscribeUrl = (uid) => `${API_BASE_URL}/api/auth/unsubscribe?u=${encodeURIComponent(uid)}&s=${unsubscribeSig(uid)}`;
const DOWNLOAD_URL =process.env.DOWNLOAD_PAGE_URL || 'https://github.com/yehsqn/paypulse-releases/releases/latest';
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendUpdateEmails(rows, version, notes, broadcastId) {
  let sent = 0;
  const subject = `PayPulse ${version} yayında`;
  const htmlFor = (unsub) => `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0f172a;color:#f8fafc;border-radius:16px;border:1px solid #334155">
    <h2 style="color:#38bdf8;margin-top:0">PayPulse ${esc(version)} yayında</h2>
    <p style="color:#cbd5e1;white-space:pre-line">${esc(notes)}</p>
    <p><a href="${esc(DOWNLOAD_URL)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none">Yeni sürümü indir</a></p>
    <p style="color:#94a3b8;font-size:12px">Masaüstü uygulaması açıldığında kendiliğinden güncellenir; telefonda Google Play'den güncelleyebilirsin.
    Bu e-postayı, duyuru e-postası almayı kabul ettiğin için alıyorsun. <a href="${esc(unsub)}" style="color:#94a3b8">Abonelikten çık</a></p>
  </div>`;
  const textFor = (unsub) => `PayPulse ${version} yayında\n\n${notes}\n\nYeni sürüm: ${DOWNLOAD_URL}\n\nMasaüstü uygulaması açıldığında kendiliğinden güncellenir; telefonda Google Play'den güncelleyebilirsin.\n\nAbonelikten çık: ${unsub}`;
  for (const u of rows) {
    const unsub = unsubscribeUrl(u.id);
    if (await sendMail({ to: u.email, subject, html: htmlFor(unsub), text: textFor(unsub), bulk: true, unsubscribeUrl: unsub })) sent++;
    await sleep(700); // e-posta sağlayıcısının gönderim hızı sınırına takılmamak için
  }
  await db.execute({ sql: 'UPDATE app_broadcasts SET email_sent = ? WHERE id = ?', args: [sent, broadcastId] }).catch(() => {});
  console.log(`[ADMIN] ${version} duyurusu ${sent}/${rows.length} e-postaya gönderildi.`);
}

router.post('/broadcast-update', async (req, res) => {
  try {
    const version = String(req.body?.version || '').trim();
    const notes = String(req.body?.notes || '').trim().slice(0, 600) || 'Yeni sürüm hazır. Yenilikler ve düzeltmeler için güncelleyin.';
    const sendEmail = req.body?.sendEmail === true;
    const force = req.body?.force === true;
    if (!VERSION_RE.test(version)) return res.status(400).json({ success: false, error: 'Sürüm numarası 1.2.3 biçiminde olmalı.' });

    const prev = await db.execute({ sql: 'SELECT id FROM app_broadcasts WHERE version = ?', args: [version] });
    if (prev.rows.length && !force) {
      return res.status(409).json({ success: false, alreadySent: true, error: `${version} için daha önce duyuru gönderilmiş.` });
    }

    const users = (await db.execute('SELECT id, email, email_verified, email_updates_consent FROM users')).rows;
    const id = crypto.randomBytes(12).toString('hex');
    await db.execute({
      sql: `INSERT INTO app_broadcasts (id, version, notes, sent_by, recipients, email_requested, email_sent, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      args: [id, version, notes, req.authUserId, users.length, sendEmail ? 1 : 0],
    });

    // Uygulama içi: çevrimiçiyse anında, değilse bildirimler listesinde bekler
    const title = `🚀 PayPulse ${version} yayında`;
    const body = `${notes}\n\nMasaüstü sürüm kendiliğinden güncellenir; telefonda Google Play'den güncelleyebilirsin.`;
    for (let i = 0; i < users.length; i += 25) {
      await Promise.all(users.slice(i, i + 25).map(u => sendToUser(u.id, { type: 'APP_UPDATE', title, body }).catch(() => {})));
    }

    // İYS: duyuru e-postası yalnızca açıkça izin vermiş (ve e-postası doğrulanmış) kullanıcılara gider
    const emailTargets = sendEmail ? users.filter(u => u.email && Number(u.email_verified) !== 0 && Number(u.email_updates_consent) === 1) : [];
    if (emailTargets.length) {
      // Yanıtı bekletme: e-postalar arka planda sırayla gider
      sendUpdateEmails(emailTargets, version, notes, id).catch(err => console.error('[ADMIN] E-posta duyuru hatası:', err.message));
    }

    res.json({ success: true, inApp: users.length, emailQueued: emailTargets.length });
  } catch (err) {
    console.error('[ADMIN] Duyuru hatası:', err.message);
    res.status(500).json({ success: false, error: 'Duyuru gönderilemedi.' });
  }
});

router.get('/broadcasts', async (req, res) => {
  try {
    const r = await db.execute('SELECT version, notes, recipients, email_requested, email_sent, created_at FROM app_broadcasts ORDER BY datetime(created_at) DESC LIMIT 20');
    res.json({ success: true, broadcasts: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Duyurular alınamadı.' });
  }
});

// GET /api/admin/users — Kullanıcı listesi (ban ve üyelik detaylarıyla)
router.get('/users', async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT id, email, display_name, avatar, role, is_premium, premium_expires_at,
             subscription_type, subscription_expiry, is_banned, ban_reason, banned_at, banned_until, created_at
      FROM users
      ORDER BY datetime(created_at) DESC
    `);
    const users = r.rows.map(u => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name || '',
      avatar: u.avatar || '',
      role: u.role || 'user',
      isPremium: Number(u.is_premium) === 1 || u.role === 'admin',
      subscriptionType: u.subscription_type || 'free',
      subscriptionExpiry: u.subscription_expiry || u.premium_expires_at || null,
      isBanned: Number(u.is_banned) === 1 && !(u.banned_until && Date.parse(u.banned_until) <= Date.now()),
      banReason: u.ban_reason || null,
      bannedAt: u.banned_at || null,
      bannedUntil: u.banned_until || null,
      createdAt: u.created_at || null
    }));
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kullanıcı listesi alınamadı: ' + err.message });
  }
});

// POST /api/admin/ban-user — Kullanıcı banlama (durationDays: 1-3650 gün; boş/0 → süresiz)
router.post('/ban-user', async (req, res) => {
  try {
    const { targetUserId, reason, durationDays } = req.body;
    if (!targetUserId) return res.status(400).json({ success: false, error: 'targetUserId gerekli' });

    const banReason = (reason || 'Topluluk ve kullanım kurallarının ihlali.').trim().slice(0, 500);
    const days = Math.floor(Number(durationDays) || 0);
    if (days < 0 || days > 3650) return res.status(400).json({ success: false, error: 'Ban süresi 1-3650 gün arasında olmalı (süresiz için boş bırakın).' });
    const bannedUntil = days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

    // Kullanıcıyı banla ve token_version artırarak mevcut tüm oturumlarını anında düşür
    await db.execute({
      sql: `UPDATE users
            SET is_banned = 1,
                ban_reason = ?,
                banned_at = datetime('now'),
                banned_until = ?,
                token_version = COALESCE(token_version, 0) + 1
            WHERE id = ?`,
      args: [banReason, bannedUntil, targetUserId]
    });
    invalidateUser(String(targetUserId)); // önbellekteki eski kullanıcı kaydı 60 sn boyunca geçerli kalmasın

    res.json({
      success: true,
      bannedUntil,
      message: bannedUntil
        ? `Kullanıcı ${days} gün banlandı (bitiş: ${new Date(bannedUntil).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}).`
        : 'Kullanıcı süresiz banlandı ve tüm oturumları sonlandırıldı.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kullanıcı banlanamadı: ' + err.message });
  }
});

// POST /api/admin/unban-user — Kullanıcı banını kaldırma
router.post('/unban-user', async (req, res) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ success: false, error: 'targetUserId gerekli' });

    await db.execute({
      sql: `UPDATE users
            SET is_banned = 0,
                ban_reason = NULL,
                banned_at = NULL,
                banned_until = NULL
            WHERE id = ?`,
      args: [targetUserId]
    });
    invalidateUser(String(targetUserId));

    res.json({ success: true, message: 'Kullanıcının banı kaldırıldı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Ban kaldırılamadı: ' + err.message });
  }
});

// GET /api/admin/reports — Gelen şikayetleri listele
router.get('/reports', async (req, res) => {
  try {
    const sql = `
      SELECT r.id, r.reporter_id, r.reported_user_id, r.reason, r.details, r.message_id, r.status, r.created_at,
             u1.email as reporter_email, u1.display_name as reporter_name,
             u2.email as reported_email, u2.display_name as reported_name, u2.is_banned as reported_is_banned
      FROM user_reports r
      LEFT JOIN users u1 ON r.reporter_id = u1.id
      LEFT JOIN users u2 ON r.reported_user_id = u2.id
      ORDER BY datetime(r.created_at) DESC
      LIMIT 100
    `;
    const result = await db.execute(sql);
    res.json({ success: true, reports: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Şikayetler alınamadı: ' + err.message });
  }
});

// POST /api/admin/resolve-report — Şikayeti sonuçlandır (resolved, dismissed)
router.post('/resolve-report', async (req, res) => {
  try {
    const { reportId, status } = req.body;
    if (!reportId) return res.status(400).json({ success: false, error: 'reportId gerekli' });

    const newStatus = ['resolved', 'dismissed', 'pending'].includes(status) ? status : 'resolved';
    await db.execute({
      sql: 'UPDATE user_reports SET status = ? WHERE id = ?',
      args: [newStatus, reportId]
    });

    res.json({ success: true, message: `Şikayet durumu "${newStatus}" olarak güncellendi.` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'İşlem başarısız: ' + err.message });
  }
});

module.exports = router;

