const crypto = require('crypto');
const { db } = require('./db/turso');
const { sendMail } = require('./mailer');
const { unsubscribeSig } = require('./middleware/session');
const { loadUserData } = require('./routes/db');

const API_BASE_URL = (process.env.API_BASE_URL || 'https://api.yehsqn.com').replace(/\/+$/, '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const unsubscribeUrl = (uid) =>
  `${API_BASE_URL}/api/auth/unsubscribe?type=backup&u=${encodeURIComponent(uid)}&s=${unsubscribeSig(uid)}`;

function sendBackupMail(user, content, dateStr) {
  const unsub = unsubscribeUrl(user.id);
  return sendMail({
    to: user.email,
    subject: `PayPulse yedeğin (${dateStr})`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">
      <p>Merhaba,</p>
      <p>PayPulse verilerinin güncel yedeği ektedir. Gerekirse uygulamada Ayarlar → Veri Yönetimi bölümünden geri yükleyebilirsin.</p>
      <p>Ek dosyada finansal kayıtların bulunur, başkalarıyla paylaşma.</p>
      <p style="font-size:12px;color:#666">Yedek yalnızca verilerin değiştiğinde gönderilir. <a href="${unsub}" style="color:#666">Yedek e-postalarını kapat</a></p>
    </div>`,
    text: `Merhaba,\n\nPayPulse verilerinin güncel yedeği ektedir. Gerekirse uygulamada Ayarlar → Veri Yönetimi bölümünden geri yükleyebilirsin.\n\nEk dosyada finansal kayıtların bulunur, başkalarıyla paylaşma.\n\nYedek e-postalarını kapat: ${unsub}`,
    attachments: [{ filename: `paypulse-yedek-${dateStr}.json`, content: Buffer.from(content, 'utf8') }],
    bulk: true, // Gmail'in günlük sınırını korumak için önce Resend
    unsubscribeUrl: unsub,
  });
}

/** Verisi olan ve yedeği açık kullanıcılara, son gönderimden sonra değişiklik varsa yedek e-postası atar. */
async function runEmailBackups() {
  const users = (await db.execute(`SELECT id, email, email_backup_hash FROM users
    WHERE COALESCE(email_backup_enabled, 1) = 1 AND COALESCE(email_verified, 1) = 1 AND COALESCE(is_banned, 0) = 0`)).rows;

  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const data = await loadUserData(user.id);
      if (data.payments.length === 0 && Object.keys(data.dailyIncomes).length === 0) continue;

      const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
      if (hash === user.email_backup_hash) continue;

      const content = JSON.stringify({ exportDate: new Date().toISOString(), ...data }, null, 2);
      if (await sendBackupMail(user, content, dateStr)) {
        await db.execute({ sql: 'UPDATE users SET email_backup_hash = ? WHERE id = ?', args: [hash, user.id] });
        sent++;
      } else {
        failed++; // özet güncellenmez, ertesi gece yeniden denenir
      }
      await sleep(700); // e-posta sağlayıcısının gönderim hızı sınırına takılmamak için
    } catch (err) {
      failed++;
      console.error(`[BACKUP] ${user.id} yedeklenemedi:`, err.message);
    }
  }

  console.log(`[BACKUP] Gece yedeği: ${sent} gönderildi, ${failed} başarısız, ${users.length} kullanıcı tarandı.`);
  return { sent, failed };
}

module.exports = { runEmailBackups };
