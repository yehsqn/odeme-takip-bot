
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { db } = require('./db/turso');

let bot = null;

// ── Yardımcılar ─────────────────────────────────────────────────────────────
async function getUserByChatId(chatId) {
  try {
    const res = await db.execute({
      sql: 'SELECT * FROM users WHERE telegram_chat_id = ?',
      args: [String(chatId)],
    });
    return res.rows[0] || null;
  } catch (err) {
    console.error('[BOT DB ERROR getUserByChatId]:', err.message);
    return null;
  }
}

async function linkUserByChatId(chatId, userId) {
  await db.execute({
    sql: 'UPDATE users SET telegram_chat_id = ? WHERE id = ?',
    args: [String(chatId), userId],
  });
}

function formatCurrency(amount) {
  return Number(amount || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' ₺';
}

function sendNotLinked(chatId) {
  if (!bot) return;
  return bot.sendMessage(chatId,
    '🔗 <b>Hesabınız henüz bağlı değil.</b>\n\n' +
    'Bağlamak için uygulamadan <b>Ayarlar → Telegram Bağla</b> bölümünden pairing code (eşleşme kodu) alın.\n\n' +
    'Ardından buraya: <code>/start KODUNUZ</code> yazın.',
    { parse_mode: 'HTML' }
  );
}

// Tüm ödemeleri taksit planı ile birlikte çeker
async function getAllPayments(userId) {
  const res = await db.execute({
    sql: 'SELECT id, title, amount, installments, installment_plan, category, bank FROM payments WHERE user_id = ?',
    args: [userId],
  });
  return res.rows.map(row => ({
    ...row,
    plan: (() => { try { return JSON.parse(row.installment_plan || '[]'); } catch { return []; } })()
  }));
}

// ── Bot Başlatıcı ───────────────────────────────────────────────────────────
function initTelegramBot() {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) {
    console.warn('⚠️ [BOT] TELEGRAM_BOT_TOKEN bulunamadı! Telegram bot dinleyicisi başlatılmadı.');
    return null;
  }

  if (bot) {
    return bot;
  }

  try {
    bot = new TelegramBot(TOKEN, { 
      polling: true,
      request: {
        agentOptions: {
          keepAlive: true,
          family: 4
        }
      }
    });
    console.log('🤖 [BOT] PayPulse Telegram Botu başarıyla başlatıldı (Polling aktif).');

    // ── Keep-Alive: Render'ın botu uyutmasını engelle ────────────────────────
    // Render Free tier 15 dakikada uyur. Dış URL'ye her 9-10 dakikada bir istek atar.
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || Boolean(process.env.RENDER_EXTERNAL_URL);
    const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || process.env.VITE_API_URL || (isProduction ? 'https://odeme-takip-bot.onrender.com' : null);
    if (KEEP_ALIVE_URL) {
      const https = require('https');
      const http = require('http');
      setInterval(() => {
        try {
          const url = new URL(KEEP_ALIVE_URL);
          const client = url.protocol === 'https:' ? https : http;
          client.get(`${KEEP_ALIVE_URL}/health`, (res) => {
            console.log(`[BOT KEEP-ALIVE] Ping: ${res.statusCode}`);
          }).on('error', (e) => {
            console.warn('[BOT KEEP-ALIVE] Ping hatası:', e.message);
          });
        } catch (e) {
          console.warn('[BOT KEEP-ALIVE] URL hatası:', e.message);
        }
      }, 9 * 60 * 1000); // 9 dakika (15 dk limitinden önce)
      console.log('[BOT] Keep-alive aktif →', KEEP_ALIVE_URL);
    }

    // ── /start /bagla /baglam — Pairing code ile hesap bağlama / tekrar bağlama ──
    bot.onText(/\/(?:start|bagla|baglam)(?: (.+))?/i, async (msg, match) => {
      const chatId = msg.chat.id;
      const code = (match[1] || '').trim();

      // Pairing code ile bağlama / tekrar bağlama (zaten bağlı olsa dahi yeni hesaba bağlar)
      if (code) {
        const res = await db.execute({
          sql: 'SELECT * FROM users WHERE pairing_code = ?',
          args: [code],
        });
        const user = res.rows[0];
        if (!user) {
          return bot.sendMessage(chatId,
            '❌ Geçersiz veya süresi dolmuş eşleşme kodu.\n\n' +
            'Uygulamadan Ayarlar → Telegram bölümünden yeni bir kod oluşturup tekrar deneyin.'
          );
        }

        await linkUserByChatId(chatId, user.id);
        // Kodu temizle
        await db.execute({ sql: 'UPDATE users SET pairing_code = NULL WHERE id = ?', args: [user.id] });

        return bot.sendMessage(chatId,
          `✅ <b>Hesabınız başarıyla bağlandı!</b>\n\n` +
          `👤 <b>Kullanıcı:</b> ${user.display_name || user.email}\n` +
          `💳 <b>Müşteri Türü:</b> ${user.customer_type === 'CORPORATE' ? '🏢 Kurumsal' : '👤 Bireysel'}\n\n` +
          `Artık ödeme hatırlatıcıları, bildirimler ve komutlar doğrudan bu Telegram hesabınızla senkronizedir.\n\n` +
          `💡 Kullanabileceğiniz komutlar için /yardim yazabilirsiniz.`,
          { parse_mode: 'HTML' }
        );
      }

      // Kod verilmemişse ve zaten bağlıysa
      const existing = await getUserByChatId(chatId);
      if (existing) {
        return bot.sendMessage(chatId,
          `👋 Merhaba <b>${existing.display_name || existing.email}</b>!\n\n` +
          `Hesabınız şu anda bağlı durumda. Komutları listelemek için /yardim yazabilirsiniz.\n\n` +
          `<i>Yeniden bağlamak veya hesap değiştirmek için: <code>/bagla KOD</code> yazabilirsiniz.</i>`,
          { parse_mode: 'HTML' }
        );
      }

      // Kod yoksa ve bağlı değilse talimat ver
      bot.sendMessage(chatId,
        `👋 <b>PayPulse Asistanına Hoş Geldiniz!</b>\n\n` +
        `Telegram hesabınızı uygulamaya bağlamak için:\n\n` +
        `1️⃣ PayPulse uygulamasını açın\n` +
        `2️⃣ <b>Ayarlar → Telegram Bağla</b> bölümüne gidin\n` +
        `3️⃣ <b>"Bağlama Kodu Oluştur"</b> butonuna tıklayın\n` +
        `4️⃣ Bu bota <code>/bagla KODUNUZ</code> veya <code>/start KODUNUZ</code> yazın\n\n` +
        `<i>Örnek:</i> <code>/bagla 12345</code>`,
        { parse_mode: 'HTML' }
      );
    });

    // ── /durum — Bu ayki ödeme özeti ────────────────────────────────────────
    bot.onText(/\/durum/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();

        const payments = await getAllPayments(user.id);
        let totalThisMonth = 0, paidThisMonth = 0, pendingThisMonth = 0, overdueThisMonth = 0;

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date) continue;
            const d = new Date(inst.date);
            if (d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
              totalThisMonth += inst.amount || 0;
              if (inst.isPaid) paidThisMonth += inst.amount || 0;
              else if (d < now) overdueThisMonth += inst.amount || 0;
              else pendingThisMonth += inst.amount || 0;
            }
          }
        }

        const monthName = now.toLocaleString('tr-TR', { month: 'long', year: 'numeric' });
        const pct = totalThisMonth > 0 ? Math.round((paidThisMonth / totalThisMonth) * 100) : 0;
        const bar = '▓'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));

        bot.sendMessage(chatId,
          `📊 <b>${monthName} Ödeme Durumu</b>\n\n` +
          `💳 Bu Ay Toplam: <b>${formatCurrency(totalThisMonth)}</b>\n` +
          `✅ Ödenen: <b>${formatCurrency(paidThisMonth)}</b>\n` +
          `⏳ Bekleyen: <b>${formatCurrency(pendingThisMonth)}</b>\n` +
          `⚠️ Geciken: <b>${formatCurrency(overdueThisMonth)}</b>\n\n` +
          `📈 <code>[${bar}] %${pct}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, '❌ Veriler alınırken hata oluştu: ' + err.message);
      }
    });

    // ── /aylik — Aylık özet (son 3 ay karşılaştırma) ────────────────────────
    bot.onText(/\/aylik/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const payments = await getAllPayments(user.id);
        const now = new Date();
        const months = [];

        for (let i = 2; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push({
            label: d.toLocaleString('tr-TR', { month: 'long', year: 'numeric' }),
            month: d.getMonth(),
            year: d.getFullYear(),
            total: 0,
            paid: 0,
          });
        }

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date) continue;
            const d = new Date(inst.date);
            const m = months.find(x => x.month === d.getMonth() && x.year === d.getFullYear());
            if (!m) continue;
            m.total += inst.amount || 0;
            if (inst.isPaid) m.paid += inst.amount || 0;
          }
        }

        let text = `📅 <b>Son 3 Aylık Özet</b>\n\n`;
        for (const m of months) {
          const pct = m.total > 0 ? Math.round((m.paid / m.total) * 100) : 0;
          text += `🗓 <b>${m.label}</b>\n` +
            `   Toplam: ${formatCurrency(m.total)} | Ödenen: ${formatCurrency(m.paid)} (%${pct})\n\n`;
        }
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /ozet — Tüm ödeme özeti ──────────────────────────────────────────────
    bot.onText(/\/ozet/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const payments = await getAllPayments(user.id);
        let totalAll = 0, paidAll = 0, pendingAll = 0, overdueAll = 0;
        const now = new Date();
        now.setHours(0, 0, 0, 0);

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date) continue;
            const d = new Date(inst.date.split('T')[0]);
            d.setHours(0, 0, 0, 0);
            totalAll += inst.amount || 0;
            if (inst.isPaid) paidAll += inst.amount || 0;
            else if (d < now) overdueAll += inst.amount || 0;
            else pendingAll += inst.amount || 0;
          }
        }

        bot.sendMessage(chatId,
          `📋 <b>Genel Ödeme Özeti</b>\n\n` +
          `🔢 Toplam Ödeme Sayısı: <b>${payments.length}</b>\n\n` +
          `💰 Toplam Tutar: <b>${formatCurrency(totalAll)}</b>\n` +
          `✅ Tamamlanan: <b>${formatCurrency(paidAll)}</b>\n` +
          `⏳ Bekleyen: <b>${formatCurrency(pendingAll)}</b>\n` +
          `⚠️ Geciken: <b>${formatCurrency(overdueAll)}</b>\n\n` +
          `ℹ️ Belirli bir ödemeyi ödemek için:\n<code>/odeme ÖDEME_ADI</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /yaklasan — Önümüzdeki 7 gündeki ödemeler ───────────────────────────
    bot.onText(/\/yaklasan/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const in7 = new Date(now);
        in7.setDate(in7.getDate() + 7);

        const payments = await getAllPayments(user.id);
        const upcoming = [];

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date || inst.isPaid) continue;
            const d = new Date(inst.date.split('T')[0]);
            d.setHours(0, 0, 0, 0);
            if (d >= now && d <= in7) {
              upcoming.push({ title: p.title, date: d, amount: inst.amount || 0, paymentId: p.id });
            }
          }
        }

        if (upcoming.length === 0) {
          return bot.sendMessage(chatId, '✅ Önümüzdeki 7 gün içinde bekleyen ödemeniz bulunmuyor.');
        }

        upcoming.sort((a, b) => a.date - b.date);
        let text = `⏰ <b>Yaklaşan Ödemeler (Önümüzdeki 7 Gün)</b>\n\n`;
        for (const p of upcoming) {
          const diffDays = Math.round((p.date - now) / 86400000);
          const dayText = diffDays === 0 ? '🔥 Bugün' : diffDays === 1 ? '⚡ Yarın' : `📅 ${diffDays} gün sonra`;
          text += `${dayText}\n▪️ <b>${p.title}</b> — ${formatCurrency(p.amount)}\n   <i>Vade: ${p.date.toLocaleDateString('tr-TR')}</i>\n\n`;
        }
        text += `\n💡 Ödeme yapmak için: <code>/odeme ÖDEME_ADI</code>`;
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /geciken — Vadesi geçmiş ödemeler ───────────────────────────────────
    bot.onText(/\/geciken/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const now = new Date();
        now.setHours(0, 0, 0, 0);

        const payments = await getAllPayments(user.id);
        const overdue = [];

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date || inst.isPaid) continue;
            const d = new Date(inst.date.split('T')[0]);
            d.setHours(0, 0, 0, 0);
            if (d < now) {
              overdue.push({ title: p.title, date: d, amount: inst.amount || 0, paymentId: p.id });
            }
          }
        }

        if (overdue.length === 0) {
          return bot.sendMessage(chatId, '✅ Geciken ödemeniz bulunmuyor. Harika!');
        }

        overdue.sort((a, b) => a.date - b.date);
        const total = overdue.reduce((s, p) => s + p.amount, 0);
        let text = `⚠️ <b>Geciken Ödemeler (${overdue.length} adet)</b>\n\n`;
        for (const p of overdue) {
          const diffDays = Math.round((now - p.date) / 86400000);
          text += `🔴 <b>${p.title}</b>\n   ${formatCurrency(p.amount)} — <i>${diffDays} gün gecikti</i>\n\n`;
        }
        text += `💸 Toplam Geciken: <b>${formatCurrency(total)}</b>\n\n`;
        text += `💡 Ödeme yapmak için: <code>/odeme ÖDEME_ADI</code>`;
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /odeme — Belirli bir ödemenin en yakın taksitini ödendi işaretle ────
    bot.onText(/\/odeme (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      const searchTerm = (match[1] || '').trim().toLowerCase();

      try {
        const payments = await getAllPayments(user.id);
        const now = new Date();
        now.setHours(0, 0, 0, 0);

        // Ödeme adında arama yap
        const found = payments.filter(p =>
          p.title.toLowerCase().includes(searchTerm)
        );

        if (found.length === 0) {
          return bot.sendMessage(chatId,
            `❌ "<b>${match[1]}</b>" ile eşleşen ödeme bulunamadı.\n\n` +
            `Tüm ödemelerinizi görmek için /ozet yazın.`,
            { parse_mode: 'HTML' }
          );
        }

        if (found.length > 3) {
          let list = `🔍 <b>Çok fazla sonuç (${found.length} adet).</b> Daha spesifik bir isim deneyin:\n\n`;
          found.slice(0, 5).forEach(p => { list += `▪️ ${p.title}\n`; });
          return bot.sendMessage(chatId, list, { parse_mode: 'HTML' });
        }

        const payment = found[0];
        const plan = payment.plan;

        // En yakın ödenmemiş taksiti bul
        const unpaidInsts = plan
          .map((inst, idx) => ({ ...inst, idx }))
          .filter(inst => !inst.isPaid && inst.date);

        if (unpaidInsts.length === 0) {
          return bot.sendMessage(chatId,
            `✅ <b>${payment.title}</b> — tüm taksitler zaten ödenmiş!`,
            { parse_mode: 'HTML' }
          );
        }

        // En yakın (veya geçmiş) taksiti seç
        unpaidInsts.sort((a, b) => new Date(a.date) - new Date(b.date));
        const target = unpaidInsts[0];
        const targetDate = new Date(target.date.split('T')[0]);

        // Planı güncelle
        const updatedPlan = plan.map((inst, idx) => {
          if (idx === target.idx) {
            return { ...inst, isPaid: true, paidAt: new Date().toISOString() };
          }
          return inst;
        });

        await db.execute({
          sql: 'UPDATE payments SET installment_plan = ? WHERE id = ?',
          args: [JSON.stringify(updatedPlan), payment.id],
        });

        const remaining = unpaidInsts.length - 1;
        bot.sendMessage(chatId,
          `✅ <b>Ödeme işaretlendi!</b>\n\n` +
          `💳 <b>${payment.title}</b>\n` +
          `💰 Tutar: <b>${formatCurrency(target.amount)}</b>\n` +
          `📅 Vade: ${targetDate.toLocaleDateString('tr-TR')}\n\n` +
          (remaining > 0
            ? `📌 Kalan taksit sayısı: <b>${remaining}</b>`
            : `🎉 Tüm taksitler ödendi!`),
          { parse_mode: 'HTML' }
        );

      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /odeme (parametresiz) — Yardım mesajı ────────────────────────────────
    bot.onText(/^\/odeme$/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      bot.sendMessage(chatId,
        `💳 <b>Ödeme Yapma Komutu</b>\n\n` +
        `Bir ödemenin en yakın taksitini "ödendi" olarak işaretlemek için:\n\n` +
        `<code>/odeme ÖDEME_ADI</code>\n\n` +
        `<i>Örnekler:</i>\n` +
        `<code>/odeme Araba</code>\n` +
        `<code>/odeme Kredi Kartı</code>\n` +
        `<code>/odeme Netflix</code>\n\n` +
        `📋 Tüm ödemeleriniz için: /ozet\n` +
        `⚠️ Gecikenler için: /geciken`,
        { parse_mode: 'HTML' }
      );
    });

    // ── /aramaodeme — Ödeme listele/ara ──────────────────────────────────────
    bot.onText(/\/aramaodeme ?(.*)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      const searchTerm = (match[1] || '').trim().toLowerCase();

      try {
        const payments = await getAllPayments(user.id);
        const filtered = searchTerm
          ? payments.filter(p => p.title.toLowerCase().includes(searchTerm))
          : payments;

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, `❌ "${match[1]}" ile eşleşen ödeme bulunamadı.`);
        }

        const now = new Date();
        now.setHours(0, 0, 0, 0);

        let text = searchTerm
          ? `🔍 <b>"${match[1]}" için Sonuçlar</b>\n\n`
          : `📋 <b>Tüm Ödemeler (${filtered.length} adet)</b>\n\n`;

        for (const p of filtered.slice(0, 10)) {
          const unpaid = p.plan.filter(i => !i.isPaid && i.date);
          const paid = p.plan.filter(i => i.isPaid);
          const overdue = unpaid.filter(i => new Date(i.date.split('T')[0]) < now);
          const status = unpaid.length === 0 ? '✅' : overdue.length > 0 ? '⚠️' : '⏳';
          const totalAmount = p.plan.reduce((s, i) => s + (i.amount || 0), 0);
          text += `${status} <b>${p.title}</b>\n` +
            `   ${formatCurrency(totalAmount)} | ${paid.length}/${p.plan.length} taksit\n\n`;
        }

        if (filtered.length > 10) {
          text += `<i>...ve ${filtered.length - 10} ödeme daha</i>\n\n`;
        }
        text += `💡 Ödemek için: <code>/odeme ÖDEME_ADI</code>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /istatistik — Kategori bazlı harcama analizi ─────────────────────────
    bot.onText(/\/istatistik/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const payments = await getAllPayments(user.id);
        const categoryMap = {};

        for (const p of payments) {
          const cat = p.category || 'Diğer';
          if (!categoryMap[cat]) categoryMap[cat] = { total: 0, paid: 0, count: 0 };
          for (const inst of p.plan) {
            categoryMap[cat].total += inst.amount || 0;
            if (inst.isPaid) categoryMap[cat].paid += inst.amount || 0;
          }
          categoryMap[cat].count++;
        }

        const sorted = Object.entries(categoryMap).sort((a, b) => b[1].total - a[1].total);
        let text = `📊 <b>Kategori Bazlı Harcama Analizi</b>\n\n`;

        for (const [cat, data] of sorted) {
          const pct = data.total > 0 ? Math.round((data.paid / data.total) * 100) : 0;
          text += `🏷 <b>${cat}</b> (${data.count} ödeme)\n` +
            `   Toplam: ${formatCurrency(data.total)} | %${pct} ödendi\n\n`;
        }

        const totalAll = sorted.reduce((s, [, v]) => s + v.total, 0);
        text += `─────────────────\n💰 Genel Toplam: <b>${formatCurrency(totalAll)}</b>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /bakiye — Banka/kart bazında ödeme özeti ─────────────────────────────
    bot.onText(/\/bakiye/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const payments = await getAllPayments(user.id);
        const bankMap = {};

        for (const p of payments) {
          const bank = p.bank || 'Belirtilmemiş';
          if (!bankMap[bank]) bankMap[bank] = { total: 0, pending: 0, count: 0 };
          for (const inst of p.plan) {
            if (!inst.isPaid) {
              bankMap[bank].pending += inst.amount || 0;
            }
            bankMap[bank].total += inst.amount || 0;
          }
          bankMap[bank].count++;
        }

        const sorted = Object.entries(bankMap).sort((a, b) => b[1].pending - a[1].pending);
        let text = `🏦 <b>Banka/Kart Bazında Bekleyen Ödemeler</b>\n\n`;

        for (const [bank, data] of sorted) {
          if (data.pending > 0) {
            text += `💳 <b>${bank}</b>\n` +
              `   Bekleyen: ${formatCurrency(data.pending)} / ${formatCurrency(data.total)}\n\n`;
          }
        }

        if (text === `🏦 <b>Banka/Kart Bazında Bekleyen Ödemeler</b>\n\n`) {
          text += '✅ Tüm ödemeler tamamlanmış!';
        }

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /hatirlatici — Bu haftanın detaylı hatırlatıcısı ────────────────────
    bot.onText(/\/hatirlatici/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const in14 = new Date(now);
        in14.setDate(in14.getDate() + 14);

        const payments = await getAllPayments(user.id);
        const upcoming = [];

        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.date || inst.isPaid) continue;
            const d = new Date(inst.date.split('T')[0]);
            d.setHours(0, 0, 0, 0);
            if (d >= now && d <= in14) {
              upcoming.push({ title: p.title, date: d, amount: inst.amount || 0 });
            }
          }
        }

        if (upcoming.length === 0) {
          return bot.sendMessage(chatId, '✅ Önümüzdeki 14 gün içinde ödemeniz yok.');
        }

        upcoming.sort((a, b) => a.date - b.date);
        let text = `📅 <b>14 Günlük Ödeme Takvimi</b>\n\n`;
        let lastDay = null;

        for (const p of upcoming) {
          const dayStr = p.date.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
          if (dayStr !== lastDay) {
            text += `\n🗓 <b>${dayStr}</b>\n`;
            lastDay = dayStr;
          }
          text += `   ▪️ ${p.title} — ${formatCurrency(p.amount)}\n`;
        }

        const total = upcoming.reduce((s, p) => s + p.amount, 0);
        text += `\n─────────────────\n💰 14 Günlük Toplam: <b>${formatCurrency(total)}</b>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /gelirgidersifre — Gelir/Gider şifresi görüntüle ─────────────────────
    bot.onText(/\/gelirgidersifre/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const res = await db.execute({
          sql: 'SELECT income_expense_password FROM users WHERE id = ?',
          args: [user.id],
        });
        const pw = res.rows[0]?.income_expense_password;
        if (!pw) {
          return bot.sendMessage(chatId,
            'ℹ️ Gelir/Gider bölümü için henüz bir şifre belirlenmemiş.\n\n' +
            'Uygulamadan <b>Ayarlar → Gelir/Gider Şifresi</b> bölümünden şifre oluşturabilirsiniz.',
            { parse_mode: 'HTML' }
          );
        }
        bot.sendMessage(chatId,
          `🔐 <b>Gelir/Gider Şifreniz:</b>\n\n` +
          `<code>${pw}</code>\n\n` +
          `⚠️ <i>Güvenliğiniz için bu mesajı gördükten sonra silebilirsiniz.</i>`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /doviz — Canlı döviz ve altın kurları ────────────────────────────────
    bot.onText(/\/doviz/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const res = await axios.get('https://api.genelpara.com/embed/para-birimleri.json', { timeout: 7000 });
        const d = res.data;
        const usd = d?.USD?.satis || '0';
        const usdDegisim = d?.USD?.degisim || '0';
        const eur = d?.EUR?.satis || '0';
        const eurDegisim = d?.EUR?.degisim || '0';
        const btc = d?.BTC?.satis || '0';
        const gau = d?.GA?.satis || '0'; // Gram Altın

        let text = `📈 <b>Canlı Piyasa Kurları</b>\n\n`;
        text += `💵 <b>Dolar (USD):</b> ${usd} ₺  <i>(%${usdDegisim})</i>\n`;
        text += `💶 <b>Euro (EUR):</b> ${eur} ₺  <i>(%${eurDegisim})</i>\n`;
        if (gau && gau !== '0') text += `🪙 <b>Gram Altın:</b> ${gau} ₺\n`;
        if (btc && btc !== '0') text += `₿ <b>Bitcoin:</b> $${Number(btc).toLocaleString('en-US')}\n`;
        text += `\n🕒 <i>Kaynak: GenelPara (${new Date().toLocaleTimeString('tr-TR')})</i>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Döviz kurları alınamadı: ' + err.message);
      }
    });

    // ── /bugun — Günün ödeme ve finans özeti ─────────────────────────────────
    bot.onText(/\/bugun/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const payments = await getAllPayments(user.id);

        const dueToday = [];
        for (const p of payments) {
          for (const inst of p.plan) {
            if (!inst.paid && inst.dueDate === todayStr) {
              dueToday.push({ title: p.title, amount: inst.amount, installment: inst.installment });
            }
          }
        }

        const incomeRes = await db.execute({
          sql: 'SELECT * FROM daily_incomes WHERE user_id = ? AND date = ?',
          args: [user.id, todayStr],
        });
        const incomeRow = incomeRes.rows[0];
        let todayIncomeTotal = 0;
        let todayExpenseTotal = 0;
        if (incomeRow) {
          todayIncomeTotal = (Number(incomeRow.cash) || 0) + (Number(incomeRow.cc) || 0) + (Number(incomeRow.salary) || 0) + (Number(incomeRow.insurance) || 0) + (Number(incomeRow.other_income) || 0);
          try {
            const expList = JSON.parse(incomeRow.expenses || '[]');
            todayExpenseTotal = expList.reduce((s, e) => s + (Number(e.amount) || 0), 0);
          } catch {}
        }

        let text = `📅 <b>Günün Özeti (${new Date().toLocaleDateString('tr-TR')})</b>\n\n`;

        text += `<b>💳 Bugün Vadesi Gelen Ödemeler:</b>\n`;
        if (dueToday.length === 0) {
          text += `✅ Bugün vadesi olan ödemeniz bulunmuyor.\n\n`;
        } else {
          for (const item of dueToday) {
            text += `▪️ ${item.title} (${item.installment}. Taksit): <b>${formatCurrency(item.amount)}</b>\n`;
          }
          const totalDue = dueToday.reduce((s, x) => s + x.amount, 0);
          text += `💰 <b>Toplam:</b> ${formatCurrency(totalDue)}\n\n`;
        }

        text += `<b>📊 Günlük Kasa / Gelir - Gider:</b>\n`;
        text += `🟢 Gelir: <b>${formatCurrency(todayIncomeTotal)}</b>\n`;
        text += `🔴 Gider: <b>${formatCurrency(todayExpenseTotal)}</b>\n`;
        const net = todayIncomeTotal - todayExpenseTotal;
        text += `⚖️ Net Durum: <b>${formatCurrency(net)}</b>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /gelir [miktar] [açıklama] — Hızlı gelir kaydet ─────────────────────
    bot.onText(/\/gelir(?: (.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      const input = (match[1] || '').trim();
      if (!input) {
        return bot.sendMessage(chatId,
          `ℹ️ <b>Gelir Ekleme Kullanımı:</b>\n\n` +
          `<code>/gelir TUTAR AÇIKLAMA</code>\n\n` +
          `<i>Örnek:</i> <code>/gelir 500 Prim Ödemesi</code>\n` +
          `<i>Örnek:</i> <code>/gelir 2500 Ek Kazanç</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const parts = input.split(' ');
      const amount = parseFloat(parts[0].replace(',', '.'));
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Lütfen geçerli bir tutar belirtin. Örnek: <code>/gelir 500 Satış</code>', { parse_mode: 'HTML' });
      }
      const desc = parts.slice(1).join(' ') || 'Diğer Gelir';
      const todayStr = new Date().toISOString().split('T')[0];

      try {
        const existing = await db.execute({
          sql: 'SELECT * FROM daily_incomes WHERE user_id = ? AND date = ?',
          args: [user.id, todayStr],
        });

        if (existing.rows.length === 0) {
          await db.execute({
            sql: `INSERT INTO daily_incomes (user_id, date, other_income) VALUES (?, ?, ?)`,
            args: [user.id, todayStr, amount],
          });
        } else {
          await db.execute({
            sql: `UPDATE daily_incomes SET other_income = other_income + ? WHERE user_id = ? AND date = ?`,
            args: [amount, user.id, todayStr],
          });
        }

        bot.sendMessage(chatId,
          `✅ <b>Gelir Başarıyla Kaydedildi!</b>\n\n` +
          `💰 Tutar: <b>${formatCurrency(amount)}</b>\n` +
          `📝 Açıklama: ${desc}\n` +
          `📅 Tarih: ${todayStr}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, '❌ Gelir eklenirken hata: ' + err.message);
      }
    });

    // ── /gider [miktar] [açıklama] — Hızlı gider kaydet ─────────────────────
    bot.onText(/\/gider(?: (.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      const input = (match[1] || '').trim();
      if (!input) {
        return bot.sendMessage(chatId,
          `ℹ️ <b>Gider Ekleme Kullanımı:</b>\n\n` +
          `<code>/gider TUTAR AÇIKLAMA</code>\n\n` +
          `<i>Örnek:</i> <code>/gider 150 Öğle Yemeği</code>\n` +
          `<i>Örnek:</i> <code>/gider 750 Market Alışverişi</code>`,
          { parse_mode: 'HTML' }
        );
      }

      const parts = input.split(' ');
      const amount = parseFloat(parts[0].replace(',', '.'));
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Lütfen geçerli bir tutar belirtin. Örnek: <code>/gider 150 Benzin</code>', { parse_mode: 'HTML' });
      }
      const desc = parts.slice(1).join(' ') || 'Genel Gider';
      const todayStr = new Date().toISOString().split('T')[0];

      try {
        const existing = await db.execute({
          sql: 'SELECT * FROM daily_incomes WHERE user_id = ? AND date = ?',
          args: [user.id, todayStr],
        });

        const newExpenseItem = { id: Date.now().toString(), description: desc, amount: amount, time: new Date().toLocaleTimeString('tr-TR') };

        if (existing.rows.length === 0) {
          const expList = [newExpenseItem];
          await db.execute({
            sql: `INSERT INTO daily_incomes (user_id, date, expenses) VALUES (?, ?, ?)`,
            args: [user.id, todayStr, JSON.stringify(expList)],
          });
        } else {
          let expList = [];
          try { expList = JSON.parse(existing.rows[0].expenses || '[]'); } catch {}
          expList.push(newExpenseItem);
          await db.execute({
            sql: `UPDATE daily_incomes SET expenses = ? WHERE user_id = ? AND date = ?`,
            args: [JSON.stringify(expList), user.id, todayStr],
          });
        }

        bot.sendMessage(chatId,
          `✅ <b>Gider Başarıyla Kaydedildi!</b>\n\n` +
          `💸 Tutar: <b>${formatCurrency(amount)}</b>\n` +
          `📝 Açıklama: ${desc}\n` +
          `📅 Tarih: ${todayStr}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        bot.sendMessage(chatId, '❌ Gider eklenirken hata: ' + err.message);
      }
    });

    // ── /yedek — Anlık JSON yedeği indir ────────────────────────────────────
    bot.onText(/\/yedek/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const [payments, settingsRes, dailyIncomesRes] = await Promise.all([
          getAllPayments(user.id),
          db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [user.id] }),
          db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [user.id] }),
        ]);

        const backupData = {
          exportDate: new Date().toISOString(),
          version: '1.1.71',
          user: {
            email: user.email,
            displayName: user.display_name,
            customerType: user.customer_type,
          },
          settings: settingsRes.rows[0] || {},
          payments: payments,
          dailyIncomes: dailyIncomesRes.rows,
        };

        const fileBuffer = Buffer.from(JSON.stringify(backupData, null, 2), 'utf-8');
        const fileName = `PayPulse_Yedek_${new Date().toISOString().slice(0, 10)}.json`;

        await bot.sendDocument(chatId, fileBuffer, {
          caption: `📦 <b>PayPulse Güvenli Yedeğiniz</b>\n\n📅 Tarih: ${new Date().toLocaleString('tr-TR')}\n💾 Toplam Ödeme: ${payments.length}\n✅ Bu JSON dosyasını dilediğiniz zaman uygulama içerisinden geri yükleyebilirsiniz.`,
          parse_mode: 'HTML',
        }, {
          filename: fileName,
          contentType: 'application/json',
        });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Yedek oluşturulurken hata: ' + err.message);
      }
    });

    // ── /hesap — Kullanıcı profil ve istatistik özeti ───────────────────────
    bot.onText(/\/hesap/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      try {
        const countRes = await db.execute({
          sql: 'SELECT COUNT(*) as total FROM payments WHERE user_id = ?',
          args: [user.id],
        });
        const totalPayments = countRes.rows[0]?.total || 0;

        const isPremium = user.is_premium && (!user.subscription_expiry || new Date(user.subscription_expiry) > new Date());
        const customerTypeLabel = user.customer_type === 'CORPORATE' ? '🏢 Kurumsal' : '👤 Bireysel';

        let text = `👤 <b>Hesap Bilgileriniz</b>\n\n`;
        text += `📧 <b>E-Posta:</b> ${user.email}\n`;
        if (user.display_name) text += `🏷️ <b>İsim:</b> ${user.display_name}\n`;
        text += `📋 <b>Müşteri Türü:</b> ${customerTypeLabel}\n`;
        text += `⭐ <b>Abonelik:</b> ${isPremium ? 'PRO Üye ✨' : 'Standart (Ücretsiz)'}\n`;
        text += `📁 <b>Kayıtlı Ödeme Sayısı:</b> ${totalPayments}\n`;
        text += `🔒 <b>PIN Koruması:</b> ${user.pin ? 'Aktif' : 'Yok'}\n`;
        text += `🔐 <b>Gelir/Gider Şifresi:</b> ${user.income_expense_password ? 'Aktif' : 'Yok'}\n\n`;
        text += `<i>PayPulse sistemiyle anlık senkronizedir.</i>`;

        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      } catch (err) {
        bot.sendMessage(chatId, '❌ Hata: ' + err.message);
      }
    });

    // ── /cikis — Hesap bağlantısını kaldır ──────────────────────────────────
    bot.onText(/\/cikis/, async (msg) => {
      const chatId = msg.chat.id;
      const user = await getUserByChatId(chatId);
      if (!user) return sendNotLinked(chatId);

      await db.execute({
        sql: 'UPDATE users SET telegram_chat_id = NULL WHERE id = ?',
        args: [user.id],
      });
      bot.sendMessage(chatId,
        '👋 Hesabınızın Telegram bağlantısı başarıyla kaldırıldı.\n\n' +
        'Yeniden bağlanmak istediğinizde uygulamadan yeni bir pairing code oluşturabilirsiniz.'
      );
    });

    // ── /yardim ─────────────────────────────────────────────────────────────
    bot.onText(/\/yardim|\/help/, (msg) => {
      bot.sendMessage(msg.chat.id,
        `📱 <b>PayPulse Bot — Komut Listesi</b>\n\n` +
        `<b>📊 Finans & Raporlar</b>\n` +
        `/durum — Bu ayki ödeme durumu\n` +
        `/bugun — Günün ödemeleri ve kasa özeti\n` +
        `/doviz — Canlı Dolar, Euro ve Altın kurları\n` +
        `/aylik — Son 3 aylık karşılaştırma\n` +
        `/ozet — Genel ödeme özeti\n` +
        `/istatistik — Kategori bazlı analiz\n` +
        `/bakiye — Banka/kart bazında bekleyenler\n\n` +
        `<b>⚡ Hızlı İşlemler</b>\n` +
        `/gelir TUTAR AÇIKLAMA — Hızlı gelir kaydet\n` +
        `/gider TUTAR AÇIKLAMA — Hızlı gider kaydet\n` +
        `/yedek — JSON formatında anlık yedek al\n\n` +
        `<b>⏰ Hatırlatıcılar & Vade</b>\n` +
        `/yaklasan — Yaklaşan ödemeler (7 gün)\n` +
        `/geciken — Geciken ödemeler\n` +
        `/hatirlatici — 14 günlük takvim\n\n` +
        `<b>💳 Ödeme İşlemleri</b>\n` +
        `/odeme — Ödeme yapma yardımı\n` +
        `/odeme ÖDEME_ADI — En yakın taksiti öde\n` +
        `/aramaodeme — Tüm ödemeleri listele\n` +
        `/aramaodeme KELIME — Ödeme ara\n\n` +
        `<b>⚙️ Hesap & Ayarlar</b>\n` +
        `/hesap — Kullanıcı ve abonelik durumu\n` +
        `/gelirgidersifre — Gelir/Gider şifresini öğren\n` +
        `/bagla KOD — Hesabı bağla veya tazele\n` +
        `/cikis — Hesap bağlantısını kaldır`,
        { parse_mode: 'HTML' }
      );
    });

    // ── Telegram Bot Menüsünü Kaydet ─────────────────────────────────────────
    try {
      bot.setMyCommands([
        { command: 'durum', description: 'Bu ayki ödeme durumu' },
        { command: 'bugun', description: 'Bugünün ödemeleri & kasa özeti' },
        { command: 'yaklasan', description: '7 gün içindeki ödemeler' },
        { command: 'doviz', description: 'Canlı piyasa ve döviz kurları' },
        { command: 'gelir', description: 'Hızlı gelir ekle (örn: /gelir 500)' },
        { command: 'gider', description: 'Hızlı gider ekle (örn: /gider 150)' },
        { command: 'yedek', description: 'Anlık JSON yedeği indir' },
        { command: 'hesap', description: 'Hesap bilgileri ve profil' },
        { command: 'geciken', description: 'Geciken ödemeler' },
        { command: 'yardim', description: 'Tüm komutları listele' },
      ]);
    } catch (cmdErr) {
      console.warn('[BOT] setMyCommands hatası:', cmdErr.message);
    }

    // ── Bilinmeyen / Normal mesajlar veya Çıplak Kod ────────────────────────
    bot.on('message', async (msg) => {
      const text = (msg.text || '').trim();
      if (text.startsWith('/')) return; // komutları atla

      // Eğer 5-6 haneli bir sayıysa, kod olarak değerlendir (eski uyumluluk)
      if (/^\d{5,6}$/.test(text)) {
        const chatId = msg.chat.id;
        const res = await db.execute({
          sql: 'SELECT * FROM users WHERE pairing_code = ?',
          args: [text],
        });
        const user = res.rows[0];
        if (!user) {
          return bot.sendMessage(chatId,
            '❌ Geçersiz veya süresi dolmuş eşleşme kodu.\n\n' +
            'Uygulamadan Ayarlar → Telegram bölümünden yeni bir kod oluşturup tekrar deneyin.'
          );
        }

        await linkUserByChatId(chatId, user.id);
        await db.execute({ sql: 'UPDATE users SET pairing_code = NULL WHERE id = ?', args: [user.id] });

        return bot.sendMessage(chatId,
          `✅ <b>Hesabınız başarıyla bağlandı!</b>\n\n` +
          `👤 <b>Kullanıcı:</b> ${user.display_name || user.email}\n` +
          `💳 <b>Müşteri Türü:</b> ${user.customer_type === 'CORPORATE' ? '🏢 Kurumsal' : '👤 Bireysel'}\n\n` +
          `Artık ödeme hatırlatıcıları, bildirimler ve komutlar doğrudan bu Telegram hesabınızla senkronizedir.\n\n` +
          `💡 Kullanabileceğiniz komutlar için /yardim yazabilirsiniz.`,
          { parse_mode: 'HTML' }
        );
      }

      bot.sendMessage(msg.chat.id,
        '💬 Komutları görmek için /yardim yazabilirsiniz. 😊'
      );
    });

    // ── Hata Yakalama ────────────────────────────────────────────────────────
    bot.on('polling_error', (err) => {
      if (err.code === 'ETELEGRAM' && err.message?.includes('409 Conflict')) {
        console.warn('⚠️ [BOT POLLING] Başka bir bot örneği çalışıyor olabilir (409 Conflict).');
      } else {
        console.error('[BOT POLLING ERROR]', err.code || '', err.message || err);
      }
    });

    return bot;
  } catch (err) {
    console.error('❌ [BOT] Bot başlatılırken hata:', err.message);
    return null;
  }
}

function getBot() {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN) {
    return initTelegramBot();
  }
  return bot;
}

module.exports = { initTelegramBot, getBot };

// Render doğrudan `node bot.js` çalıştırırsa API sunucusunu başlat
if (require.main === module) {
  require('./index.js');
}
