const cron = require('node-cron');
const { db } = require('./db/turso');
const { sendToUser } = require('./websocket');
const { sendOverdueEmail } = require('./mailer');
const { runEmailBackups } = require('./emailBackup');
const { retryPendingContracts } = require('./contracts');

/**
 * Belirli bir kullanıcı veya saati gelen tüm kullanıcılar için ödeme hatırlatıcılarını kontrol eder.
 * @param {boolean} forceAll - True ise saat kontrolü yapmadan tüm kullanıcıları kontrol eder (manuel test için)
 * @param {string|null} targetUserId - Belirli bir kullanıcı için zorlama
 */
async function checkUpcomingPayments(forceAll = false, targetUserId = null) {
  const now = new Date();
  
  // Istanbul saatine göre güncel saat ve tarih
  const timeFormatter = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const currentTimeStr = timeFormatter.format(now);

  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' });
  const todayStr = dateFormatter.format(now);
  const todayDate = new Date(todayStr);
  todayDate.setHours(0, 0, 0, 0);

  const day1Date = new Date(todayDate); day1Date.setDate(day1Date.getDate() + 1);
  const day2Date = new Date(todayDate); day2Date.setDate(day2Date.getDate() + 2);
  const day1Str = day1Date.toISOString().split('T')[0];
  const day2Str = day2Date.toISOString().split('T')[0];

  try {
    // 1. Ayarları al ve bildirimi açık olanları filtrele
    let settingsSql = `SELECT * FROM settings WHERE notifications_enabled != 0`;
    const settingsArgs = [];

    if (!forceAll && !targetUserId) {
      settingsSql += ` AND (notification_time = ? OR (notification_time IS NULL AND ? = '09:00'))`;
      settingsArgs.push(currentTimeStr, currentTimeStr);
    } else if (targetUserId) {
      settingsSql = `SELECT * FROM settings WHERE user_id = ?`;
      settingsArgs.push(targetUserId);
    }

    const settingsRes = await db.execute({ sql: settingsSql, args: settingsArgs });
    const eligibleSettings = settingsRes.rows;

    if (eligibleSettings.length === 0 && !forceAll) {
      return { checked: 0, sent: 0 };
    }

    // forceAll && !targetUserId ise undefined (tüm kullanıcılar geçer)
    // Aksi hâlde: settings'ten gelen user_id'lerden oluşan Set
    const eligibleUserIds = (forceAll && !targetUserId)
      ? undefined
      : new Set(eligibleSettings.map((s) => s.user_id));

    // 2. Ödemeleri çek
    const paymentsResult = await db.execute({
      sql: `SELECT p.id, p.user_id, p.title, p.amount, p.installment_plan
            FROM payments p
            WHERE p.installment_plan != '[]' AND p.installment_plan IS NOT NULL`,
      args: [],
    });

    let sentCount = 0;
    // userId → bu çalışmada bildirilen gecikmiş ödemeler (e-posta özeti için)
    const overdueByUser = new Map();

    for (const row of paymentsResult.rows) {
      const userId = row.user_id;

      // Kullanıcı bu saat için uygun mu?
      if (eligibleUserIds && !eligibleUserIds.has(userId)) {
        continue;
      }

      const userSetting = eligibleSettings.find((s) => s.user_id === userId) || {};
      const notifyOnDue = userSetting.notify_on_due !== 0;
      const notifyOverdue = userSetting.notify_overdue !== 0;
      const notifyDaysBefore = userSetting.notification_days ?? 2;

      let plan;
      try {
        plan = JSON.parse(row.installment_plan || '[]');
      } catch {
        continue;
      }

      for (const inst of plan) {
        if (inst.isPaid || !inst.date) continue;

        const instDateStr = inst.date.split('T')[0];
        const instDate = new Date(instDateStr);
        instDate.setHours(0, 0, 0, 0);

        const diffDays = Math.round((instDate - todayDate) / (1000 * 60 * 60 * 24));

        let notifType = null;
        let title = '';
        let dayText = '';

        if (diffDays < 0 && notifyOverdue) {
          // Gecikmiş
          notifType = 'reminder_overdue';
          const overdueDays = Math.abs(diffDays);
          dayText = `${overdueDays} gün gecikti`;
          title = `⚠️ Gecikmiş Ödeme (${overdueDays} Gün)`;
        } else if (diffDays === 0 && notifyOnDue) {
          // Bugün
          notifType = 'reminder_today';
          dayText = 'bugün';
          title = '🔥 Bugün Son Ödeme Günü!';
        } else if (diffDays === 1 && notifyDaysBefore >= 1) {
          // Yarın
          notifType = 'reminder_1day';
          dayText = 'yarın';
          title = '⏰ Yarın Ödemeniz Var';
        } else if (diffDays === 2 && notifyDaysBefore >= 2) {
          // 2 gün sonra
          notifType = 'reminder_2day';
          dayText = '2 gün sonra';
          title = '🔔 2 Gün Sonra Ödemeniz Var';
        }

        if (!notifType) continue;

        // Tekrar bildirim engeli: Aynı kullanıcı + aynı ödeme + aynı tür + bugün
        try {
          const existCheck = await db.execute({
            sql: `SELECT id FROM notifications
                  WHERE user_id = ? AND type = ? AND payment_id = ?
                  AND date(created_at) = ?`,
            args: [userId, notifType, row.id, todayStr],
          });
          if (existCheck.rows.length > 0) {
            continue;
          }
        } catch (err) {
          console.error('[CRON] Tekrar kontrol hatası:', err.message);
        }

        const amountStr = (inst.amount || 0).toLocaleString('tr-TR', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

        const body = `${row.title} — ${amountStr} TL tutarındaki ödemeniz ${dayText} (${instDateStr}) vadeli.`;

        await sendToUser(userId, {
          type: notifType,
          title,
          body,
          paymentId: row.id,
        });

        if (notifType === 'reminder_overdue') {
          if (!overdueByUser.has(userId)) overdueByUser.set(userId, []);
          overdueByUser.get(userId).push({
            title: row.title,
            amountStr,
            dateStr: instDateStr,
            overdueDays: Math.abs(diffDays),
          });
        }

        sentCount++;
        console.log(`[CRON] ✅ Bildirim gönderildi: ${userId} → ${row.title} [${notifType}]`);
      }
    }

    // Gecikmiş ödemeler için e-posta (Gmail) özeti — kullanıcı başına tek e-posta
    for (const [userId, items] of overdueByUser) {
      try {
        const userRow = await db.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [userId] });
        const email = userRow.rows[0]?.email;
        if (!email) continue;
        const ok = await sendOverdueEmail(email, items);
        console.log(`[CRON] ${ok ? '📧 E-posta gönderildi' : '❌ E-posta gönderilemedi'}: ${email} (${items.length} gecikmiş)`);
      } catch (mailErr) {
        console.error('[CRON MAIL HATA]:', mailErr.message);
      }
    }

    return { success: true, sent: sentCount, time: currentTimeStr };
  } catch (err) {
    console.error('[CRON] Genel hata:', err.message);
    return { success: false, error: err.message };
  }
}

/** Hata kayıtlarını ve 90 gündür kullanılmayan oturumları siler (oturum anahtarları zaten 60 günde dolar). */
/** Denemesi 24 saat içinde bitecek kullanıcılara uygulama içi bir kez hatırlatma gönderir. */
async function sendTrialReminders() {
  const r = await db.execute(`SELECT u.id, (SELECT COUNT(*) FROM payments p WHERE p.user_id = u.id) AS cnt FROM users u
    WHERE u.subscription_type = 'trial' AND u.trial_reminded_at IS NULL
      AND datetime(u.subscription_expiry) > datetime('now')
      AND datetime(u.subscription_expiry) <= datetime('now', '+24 hours')`);
  for (const u of r.rows) {
    const cnt = Number(u.cnt) || 0;
    await db.execute({ sql: "UPDATE users SET trial_reminded_at = datetime('now') WHERE id = ?", args: [u.id] });
    await sendToUser(u.id, {
      type: 'TRIAL_ENDING',
      title: '⏳ PRO denemen yarın bitiyor',
      body: `${cnt ? `Şu an ${cnt} ödemeni takip ediyorsun. ` : ''}Kayıtların silinmez; deneme bitince yeni kayıt ekleme ve PRO özellikleri ücretsiz sınırlara döner.`,
    }).catch(err => console.error('[TRIAL] Bildirim hatası:', err.message));
  }
  console.log(`[TRIAL] ${r.rows.length} deneme hatırlatması gönderildi.`);
}

/** Önümüzdeki 7 günde ödemesi olan kullanıcılara haftalık özet bırakır (hatırlatmaları kapatanlar hariç). */
async function sendWeeklySummaries() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' });
  const today = fmt.format(new Date());
  const last = fmt.format(new Date(Date.now() + 6 * 86400000));
  const r = await db.execute(`SELECT p.user_id, p.title, p.installment_plan FROM payments p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN settings s ON s.user_id = p.user_id
    WHERE COALESCE(u.is_banned, 0) = 0 AND COALESCE(s.notifications_enabled, 1) = 1`);

  const byUser = new Map();
  for (const row of r.rows) {
    let plan = [];
    try { plan = JSON.parse(row.installment_plan || '[]'); } catch { continue; }
    for (const inst of plan) {
      if (inst.isPaid || !inst.date) continue;
      const when = new Date(inst.date);
      if (Number.isNaN(when.getTime())) continue;
      const day = fmt.format(when);
      if (day < today || day > last) continue;
      if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
      byUser.get(row.user_id).push({ title: row.title, day, amount: Number(inst.amount) || 0 });
    }
  }

  for (const [userId, items] of byUser) {
    items.sort((a, b) => a.day.localeCompare(b.day));
    const total = items.reduce((s, i) => s + i.amount, 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const [y, m, d] = items[0].day.split('-');
    await sendToUser(userId, {
      type: 'WEEKLY_SUMMARY',
      title: `📅 Bu hafta ${items.length} ödemen var`,
      body: `Toplam ${total} TL. En yakını: ${items[0].title}, ${d}.${m}.${y}`,
    }).catch(err => console.error('[WEEKLY] Bildirim hatası:', err.message));
  }
  console.log(`[WEEKLY] ${byUser.size} kullanıcıya haftalık özet gönderildi.`);
}

async function pruneOldRecords() {
  const [errors, sessions] = await db.batch([
    `DELETE FROM app_errors WHERE datetime(created_at) < datetime('now', '-90 days')`,
    `DELETE FROM user_sessions WHERE datetime(last_active_at) < datetime('now', '-90 days')`,
    `DELETE FROM app_events WHERE datetime(created_at) < datetime('now', '-90 days')`,
  ], 'write');
  console.log(`[CRON] Eski kayıtlar silindi: ${errors.rowsAffected} hata, ${sessions.rowsAffected} oturum`);
}

/**
 * Cron zamanlayıcısını başlatır.
 * Her dakika başı çalışır ('* * * * *') ve o anki saate ayarlı kullanıcıların bildirimlerini tetikler.
 */
function initCron() {
  // PulseCity: her Pazartesi 00:10 (TR) haftalık lig turu
  cron.schedule('10 0 * * 1', () => {
    require('./routes/game').runWeeklyLeagues().catch(err => console.error('[GAME] Lig turu hatası:', err.message));
  }, { timezone: 'Europe/Istanbul' });

  // Her gece 03:00 (TR): verisi değişen kullanıcılara e-posta yedeği
  cron.schedule('0 3 * * *', () => {
    runEmailBackups().catch(err => console.error('[BACKUP] Gece yedeği hatası:', err.message));
  }, { timezone: 'Europe/Istanbul' });

  cron.schedule('0 4 * * *', () => {
    pruneOldRecords().catch(err => console.error('[CRON] Kayıt temizliği hatası:', err.message));
  }, { timezone: 'Europe/Istanbul' });

  cron.schedule('0 9 * * 1', () => {
    sendWeeklySummaries().catch(err => console.error('[WEEKLY] Özet hatası:', err.message));
  }, { timezone: 'Europe/Istanbul' });

  // Gönderilemeyen sözleşme kopyalarını tekrar dene
  cron.schedule('*/15 * * * *', () => {
    retryPendingContracts().catch(err => console.error('[CONTRACT] Tekrar deneme hatası:', err.message));
  });

  cron.schedule('0 10 * * *', () => {
    sendTrialReminders().catch(err => console.error('[TRIAL] Hatırlatma hatası:', err.message));
  }, { timezone: 'Europe/Istanbul' });

  cron.schedule('* * * * *', async () => {
    await checkUpcomingPayments(false);
  });

  console.log('[CRON] Dinamik saatli hatırlatıcı zamanlayıcısı aktif (Her dakika kontrol edilir)');
}

module.exports = { sendWeeklySummaries, sendTrialReminders, initCron, checkUpcomingPayments, pruneOldRecords };
