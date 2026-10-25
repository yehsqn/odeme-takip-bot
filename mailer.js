const nodemailer = require('nodemailer');

/**
 * Spam filtrelerine karşı: her e-postaya düz metin sürümü, yanıtlanabilir adres ve
 * "abonelikten çık" başlığı eklenir. Konu satırlarında emoji kullanılmaz.
 */
const htmlToText = (html) => String(html || '')
  .replace(/<(br|\/p|\/div|\/h\d|\/tr|\/li)[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const replyTo = () => process.env.MAIL_REPLY_TO || 'yehsanefe20@gmail.com';
const unsubscribeHeaders = () => ({
  'List-Unsubscribe': `<mailto:${replyTo()}?subject=unsubscribe>`,
});

/**
 * Gmail (SMTP) üzerinden e-posta gönderir.
 * Gerekli ortam değişkenleri: SMTP_USER (Gmail adresi) + SMTP_PASS (Google "Uygulama şifresi").
 * Tanımlı değilse RESEND_API_KEY yedek olarak denenir.
 * @returns {Promise<boolean>}
 */
async function sendMail({ to, subject, html, text, attachments = [] }) {
  const plain = text || htmlToText(html);
  // attachments: [{ filename, content: Buffer, contentType, cid? }]
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: smtpUser, pass: smtpPass },
      });
      await transporter.sendMail({
        from: `"PayPulse Ödeme Takip" <${smtpUser}>`,
        to,
        subject,
        html,
        text: plain,
        replyTo: replyTo(),
        headers: unsubscribeHeaders(),
        attachments,
      });
      return true;
    } catch (err) {
      console.error('[MAIL] Gmail SMTP hatası:', err.message);
      return false;
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { error } = await resend.emails.send({
        from: process.env.MAIL_FROM || 'PayPulse <noreply@sqnova.software>', // Resend'de doğrulanmış alan adı
        to: [to],
        subject,
        html,
        text: plain,
        replyTo: replyTo(),
        headers: unsubscribeHeaders(),
        attachments: attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })),
      });
      if (error) {
        console.error('[MAIL] Resend hatası:', error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[MAIL] Resend SDK hatası:', err.message);
      return false;
    }
  }

  console.warn('[MAIL] E-posta yapılandırması yok (SMTP_USER/SMTP_PASS veya RESEND_API_KEY).');
  return false;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Geciken ödemeler için özet e-postası gönderir.
 * @param {string} email
 * @param {{title:string, amountStr:string, dateStr:string, overdueDays:number}[]} items
 */
function sendOverdueEmail(email, items) {
  const rows = items
    .map(
      (i) => `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #334155;">${escapeHtml(i.title)}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #334155;text-align:right;white-space:nowrap;">${escapeHtml(i.amountStr)} TL</td>
          <td style="padding:10px 8px;border-bottom:1px solid #334155;text-align:right;color:#f87171;white-space:nowrap;">${i.overdueDays} gün (${escapeHtml(i.dateStr)})</td>
        </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0f172a;color:#f8fafc;border-radius:16px;border:1px solid #334155;">
      <h2 style="color:#38bdf8;text-align:center;margin-top:0;">PayPulse</h2>
      <p style="font-size:15px;color:#cbd5e1;text-align:center;">⚠️ <b>${items.length}</b> adet gecikmiş ödemeniz var:</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#f1f5f9;">
        <thead>
          <tr style="color:#94a3b8;font-size:12px;text-align:left;">
            <th style="padding:6px 8px;">Ödeme</th>
            <th style="padding:6px 8px;text-align:right;">Tutar</th>
            <th style="padding:6px 8px;text-align:right;">Gecikme</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#94a3b8;text-align:center;margin-bottom:0;">Bildirimleri uygulamadaki ayarlardan yönetebilirsiniz.</p>
    </div>`;

  return sendMail({
    to: email,
    subject: `PayPulse: ${items.length} gecikmiş ödemeniz var`,
    html,
  });
}

module.exports = { sendMail, sendOverdueEmail, htmlToText };
