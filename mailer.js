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
const unsubscribeHeaders = (url) => (url
  ? { 'List-Unsubscribe': `<${url}>, <mailto:${replyTo()}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
  : { 'List-Unsubscribe': `<mailto:${replyTo()}?subject=unsubscribe>` });

async function trySmtp({ to, subject, html, plain, attachments, unsubscribeUrl }) {
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  if (!smtpUser || !smtpPass) return null; // yapılandırılmamış
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpPass },
      // SMTP portu engelliyse (ör. barındırma) dakikalarca beklemeden Resend'e geç
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 15000,
    });
    await transporter.sendMail({
      from: `"PayPulse" <${smtpUser}>`,
      to,
      subject,
      html,
      text: plain,
      replyTo: replyTo(),
      headers: unsubscribeHeaders(unsubscribeUrl),
      attachments,
    });
    return true;
  } catch (err) {
    console.error('[MAIL] Gmail SMTP hatası:', err.message);
    return false;
  }
}

async function tryResend({ to, subject, html, plain, attachments, unsubscribeUrl }) {
  if (!process.env.RESEND_API_KEY) return null; // yapılandırılmamış
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.MAIL_FROM || 'PayPulse <bildirim@yehsqn.com>', // Resend'de doğrulanmış alan adı
      to: [to],
      subject,
      html,
      text: plain,
      replyTo: replyTo(),
      headers: unsubscribeHeaders(unsubscribeUrl),
      attachments: attachments.map(x => ({ filename: x.filename, content: x.content.toString('base64') })),
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

/**
 * E-posta gönderir. Kanal sırası:
 *  - hesap e-postaları (kod, şifre sıfırlama, hatırlatma): önce Gmail SMTP (SMTP_USER + SMTP_PASS),
 *    Gmail alıcılarında gelen kutusuna düşme oranı yüksek; yoksa / hata verirse Resend
 *  - bulk: true (toplu duyurular): önce Resend (MAIL_FROM alan adı), Gmail'in günlük sınırını korumak için
 *  - unsubscribeUrl: duyurularda tek tıkla abonelikten çıkma bağlantısı (İYS / Gmail toplu gönderici kuralları)
 * @returns {Promise<boolean>}
 */
async function sendMail({ to, subject, html, text, attachments = [], bulk = false, unsubscribeUrl = null }) {
  const msg = { to, subject, html, plain: text || htmlToText(html), attachments, unsubscribeUrl };
  const order = bulk ? [tryResend, trySmtp] : [trySmtp, tryResend];
  let configured = false;
  for (const send of order) {
    const r = await send(msg);
    if (r === true) return true;
    if (r === false) configured = true;
  }
  if (!configured) console.warn('[MAIL] E-posta yapılandırması yok (SMTP_USER/SMTP_PASS veya RESEND_API_KEY).');
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
