const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { sendMail } = require('../mailer');
const { requireAdmin } = require('../middleware/session');

// POST /api/feedback — Kullanıcı geri bildirim ve hata bildirimi
router.post('/', async (req, res) => {
  try {
    const { userId, email, type, subject, message, appVersion, platform, screenshot, context } = req.body || {};

    // Ekran görüntüsü: data:image/jpeg|png;base64,... (en fazla ~6MB)
    let shot = null;
    if (typeof screenshot === 'string') {
      const m = screenshot.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
      if (m) {
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length <= 6 * 1024 * 1024) shot = { buf, ext: m[1] === 'png' ? 'png' : 'jpg', mime: `image/${m[1]}` };
      }
    }
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ctx = context && typeof context === 'object' ? context : {};

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Mesaj alanı zorunludur.' });
    }

    const cleanType = ['bug', 'feature', 'suggestion', 'general'].includes(type) ? type : 'feedback';
    const cleanSubject = (subject || '').trim() || (cleanType === 'bug' ? 'Hata Bildirimi' : 'Geri Bildirim');
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanVersion = appVersion || '1.1.75';
    const cleanPlatform = platform || 'Web/Mobile';

    // 1. Turso DB'ye kaydet
    await db.execute({
      sql: `INSERT INTO feedbacks (user_id, user_email, type, subject, message, app_version, platform)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        userId || null,
        cleanEmail || null,
        cleanType,
        cleanSubject,
        message.trim(),
        cleanVersion,
        cleanPlatform
      ]
    });

    // 2. Admin'e e-posta bildirimi gönder (arka planda çalışır, response'u geciktirmez)
    const adminEmail = process.env.FEEDBACK_EMAIL || 'yehsanefe20@gmail.com';
    const typeLabel = cleanType === 'bug' ? '🚨 Hata Bildirimi' : (cleanType === 'feature' ? '💡 Özellik İsteği' : '💬 Geri Bildirim');

    const htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #1e293b;">
        <h2 style="color: #38bdf8; margin-top: 0;">PayPulse — ${typeLabel}</h2>
        <div style="background: #1e293b; padding: 16px; border-radius: 12px; margin-bottom: 20px;">
          <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Konu:</strong> ${esc(cleanSubject)}</p>
          <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Gönderen:</strong> ${esc(cleanEmail || 'Anonim')} (ID: ${esc(userId || '-')})</p>
          <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Platform / Sürüm:</strong> ${esc(cleanPlatform)} (v${esc(cleanVersion)})</p>
          ${ctx.view ? `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Ekran:</strong> ${esc(ctx.view)}</p>` : ''}
          ${ctx.clicked ? `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Son tıklanan:</strong> ${esc(ctx.clicked)}</p>` : ''}
          ${ctx.viewport ? `<p style="margin: 0 0 8px 0; font-size: 14px;"><strong>Ekran boyutu:</strong> ${esc(ctx.viewport)}</p>` : ''}
          <p style="margin: 0; font-size: 14px;"><strong>Zaman:</strong> ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}</p>
        </div>
        <div style="background: #090d16; padding: 16px; border-radius: 12px; border-left: 4px solid #38bdf8; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">
${esc(message.trim())}
        </div>
        ${shot ? `<p style="margin: 20px 0 8px 0; font-size: 14px;"><strong>📸 Ekran görüntüsü</strong> (ekte de var)</p>
        <img src="cid:screenshot" alt="Ekran görüntüsü" style="max-width: 100%; border-radius: 12px; border: 1px solid #1e293b;" />` : ''}
        <p style="font-size: 12px; color: #64748b; margin-top: 24px; text-align: center;">Bu e-posta PayPulse uygulama içi geri bildirim sistemi tarafından otomatik iletilmiştir.</p>
      </div>
    `;

    // sendMail arka planda denenir
    sendMail({
      to: adminEmail,
      subject: `[PayPulse ${typeLabel}] ${cleanSubject}`,
      html: htmlContent,
      attachments: shot ? [{ filename: `ekran-goruntusu.${shot.ext}`, content: shot.buf, contentType: shot.mime, cid: 'screenshot' }] : [],
    }).catch(err => console.error('[FEEDBACK] Mail iletim hatası:', err.message));

    res.json({
      success: true,
      message: 'Geri bildiriminiz başarıyla iletildi. Katkınız için teşekkür ederiz!'
    });
  } catch (err) {
    console.error('[FEEDBACK ERROR]', err);
    res.status(500).json({ success: false, error: 'Geri bildirim kaydedilemedi. Lütfen daha sonra tekrar deneyin.' });
  }
});

// GET /api/feedback — Admin listesi (son 50)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 50'
    });
    res.json({ success: true, feedbacks: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
