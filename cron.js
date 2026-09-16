const cron = require('node-cron');
const { db } = require('./db/turso');
const { sendToUser } = require('./websocket');
const { getBot } = require('./bot');

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

        // Telegram bildirimi gönder (Kullanıcının telegram hesabı bağlı ve izinli ise)
        try {
          const b = getBot();
          if (b && userSetting.telegram_notifications_enabled !== 0) {
            const userRow = await db.execute({
              sql: 'SELECT telegram_chat_id FROM users WHERE id = ?',
              args: [userId],
            });
            const tgChatId = userRow.rows[0]?.telegram_chat_id;
            if (tgChatId) {
              const tgText = `🔔 <b>${title}</b>\n\n${body}`;
              b.sendMessage(tgChatId, tgText, { parse_mode: 'HTML' }).catch((err) => {
                console.error(`[CRON TG HATA] ${userId}:`, err.message);
              });
            }
          }
        } catch (tgErr) {
          console.error('[CRON TG HATA]:', tgErr.message);
        }

        sentCount++;
        console.log(`[CRON] ✅ Bildirim gönderildi: ${userId} → ${row.title} [${notifType}]`);
      }
    }

    return { success: true, sent: sentCount, time: currentTimeStr };
  } catch (err) {
    console.error('[CRON] Genel hata:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Cron zamanlayıcısını başlatır.
 * Her dakika başı çalışır ('* * * * *') ve o anki saate ayarlı kullanıcıların bildirimlerini tetikler.
 */
function initCron() {
  cron.schedule('* * * * *', async () => {
    await checkUpcomingPayments(false);
  });

  console.log('[CRON] Dinamik saatli hatırlatıcı zamanlayıcısı aktif (Her dakika kontrol edilir)');
}

module.exports = { initCron, checkUpcomingPayments };
