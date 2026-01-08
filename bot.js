const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const schedule = require('node-schedule');
const http = require('http');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// 1. MONGODB BAĞLANTISI
const mongoURI = '***REMOVED***';

// 2. MONGOOSE ŞEMALARI (Masaüstü uygulamasıyla birebir aynı olmalı)
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  telegramChatId: String,
  pairingCode: String,
  pairingCodeExpiresAt: Date,
  pin: String,
  incomeExpensePassword: String,
  createdAt: { type: Date, default: Date.now }
});

const PaymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  id: String,
  title: String,
  amount: Number,
  installments: Number,
  date: String,
  category: String,
  bank: String,
  type: String,
  installmentPlan: Array,
  createdAt: String
});

const SettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  cutOffDay: { type: Number, default: 10 },
  telegram: {
    botToken: { type: String, default: '***REMOVED***' },
    chatId: String,
    notificationsEnabled: { type: Boolean, default: true }
  },
  banks: { type: Array, default: [] },
  notificationDays: { type: Number, default: 3 },
  lastTelegramNotification: String,
  appPassword: String,
  backup: {
    enabled: { type: Boolean, default: false },
    time: { type: String, default: '00:00' }
  }
});

const User = mongoose.model('User', UserSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// Daily Income Schema - Store as array of days for flexibility
const DailyIncomeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date: { type: String, required: true }, // "YYYY-MM-DD"
  cash: { type: Number, default: 0 },
  cc: { type: Number, default: 0 },
  salary: { type: Number, default: 0 },
  insurance: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  expenses: [{ // New detailed expenses
    description: String,
    amount: Number,
    date: { type: Date, default: Date.now }
  }]
});

// Compound index for daily income to ensure one record per day per user
DailyIncomeSchema.index({ userId: 1, date: 1 }, { unique: true });

const DailyIncome = mongoose.model('DailyIncome', DailyIncomeSchema);


// 3. BOT AYARLARI
const token = '***REMOVED***'; // Masaüstü uygulamasındaki token ile aynı olmalı
const bot = new TelegramBot(token, { polling: true });

// 4. MONGODB'YE BAĞLAN
mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Bağlantısı Başarılı!"))
  .catch(err => {
    console.error("❌ MongoDB Bağlantı Hatası:", err);
    console.log("HATA DETAYI:", err.message);
  });

// Kullanıcı oturumları (ödeme ekleme akışı için)
const userSessions = new Map();

// 5. BUTON TIKLAMALARINI DİNLE (Callback Query)
bot.on('callback_query', async (query) => {
  const { data, message, id } = query;
  const chatId = message.chat.id.toString();

  // Format: ACTION:Param1:Param2...
  const parts = data.split(':');
  const action = parts[0];

  // ÖDEME EKLEME AKIŞI
  if (action === 'ADD_PAY') {
    const category = parts[1];
    const categoryNames = {
      'kredi_karti': 'Kredi Kartı',
      'cek': 'Çek',
      'senet': 'Senet',
      'kira': 'Kira',
      'fatura': 'Fatura',
      'diger': 'Diğer'
    };

    // Session başlat
    userSessions.set(chatId, {
      step: 'awaiting_title',
      category: category,
      categoryName: categoryNames[category] || 'Diğer'
    });

    await bot.answerCallbackQuery(id);
    await bot.sendMessage(chatId,
      `📝 <b>${categoryNames[category]} Ödemesi</b>\n\nÖdeme başlığını yazın:\n\n<i>Örnek: Akbank Kredi Kartı</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // TAKSİT SAYISI SEÇİMİ
  if (action === 'INST') {
    const installments = parseInt(parts[1]);
    const session = userSessions.get(chatId);

    if (!session) {
      await bot.answerCallbackQuery(id, { text: 'Oturum süresi doldu.' });
      return;
    }

    session.installments = installments;
    session.step = 'awaiting_date';
    userSessions.set(chatId, session);

    await bot.answerCallbackQuery(id);
    await bot.sendMessage(chatId,
      `📅 <b>Ödeme Tarihi</b>\n\nİlk ödeme tarihini girin:\n\n<i>Format: GG.AA.YYYY (örn: 15.02.2026)</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  // ÖDEME ONAYLAMA
  if (action === 'CONFIRM_PAY') {
    const session = userSessions.get(chatId);

    if (!session || !session.ready) {
      await bot.answerCallbackQuery(id, { text: 'Oturum süresi doldu.' });
      return;
    }

    try {
      const user = await User.findOne({ telegramChatId: chatId });
      if (!user) {
        await bot.answerCallbackQuery(id, { text: 'Kullanıcı bulunamadı.' });
        return;
      }

      // Taksit planı oluştur
      const installmentPlan = [];
      const startDate = new Date(session.date);
      const monthlyAmount = session.amount / session.installments;

      for (let i = 0; i < session.installments; i++) {
        const instDate = new Date(startDate);
        instDate.setMonth(instDate.getMonth() + i);

        installmentPlan.push({
          date: instDate.toISOString().split('T')[0],
          amount: Math.round(monthlyAmount * 100) / 100,
          isPaid: false
        });
      }

      // Ödeme oluştur
      const payment = new Payment({
        userId: user._id,
        id: `TG_${Date.now()}`,
        title: session.title,
        amount: session.amount,
        installments: session.installments,
        date: session.date,
        category: session.categoryName,
        type: session.category,
        installmentPlan: installmentPlan,
        createdAt: new Date().toISOString()
      });

      await payment.save();

      await bot.answerCallbackQuery(id, { text: 'Ödeme eklendi! ✅' });

      await bot.editMessageText(
        `✅ <b>Ödeme Başarıyla Eklendi!</b>\n\n` +
        `📋 ${session.title}\n` +
        `💰 ${session.amount.toLocaleString('tr-TR')} TL\n` +
        `📅 ${session.installments} taksit\n` +
        `📁 ${session.categoryName}\n\n` +
        `<i>Ödeme uygulamaya senkronize edildi.</i>`,
        {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: 'HTML'
        }
      );

      userSessions.delete(chatId);

    } catch (error) {
      console.error('Ödeme ekleme hatası:', error);
      await bot.answerCallbackQuery(id, { text: 'Hata oluştu!' });
    }
    return;
  }

  // ÖDEME İPTAL
  if (action === 'CANCEL_PAY') {
    userSessions.delete(chatId);
    await bot.answerCallbackQuery(id, { text: 'İptal edildi.' });
    await bot.editMessageText('❌ Ödeme ekleme iptal edildi.', {
      chat_id: chatId,
      message_id: message.message_id
    });
    return;
  }

  // ÖDEME İŞARETLEME (PAY)
  if (action === 'PAY' && parts.length >= 3) {
    const paymentId = parts[1];
    const date = parts.slice(2).join(':');

    try {
      const payment = await Payment.findById(paymentId);
      if (payment) {
        const installment = payment.installmentPlan.find(i => i.date === date);
        if (installment && !installment.isPaid) {
          installment.isPaid = true;
          payment.markModified('installmentPlan');
          await payment.save();

          await bot.answerCallbackQuery(id, { text: 'Ödemeniz başarıyla kaydedildi! ✅' });

          const currentKeyboard = message.reply_markup.inline_keyboard;
          const newKeyboard = currentKeyboard.filter(row => row[0].callback_data !== data);

          let newText = message.text;
          newText += `\n✅ ${payment.title} Ödendi`;

          await bot.editMessageText(newText, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: newKeyboard }
          });
        } else {
          await bot.answerCallbackQuery(id, { text: 'Bu taksit zaten ödenmiş veya bulunamadı.' });
        }
      } else {
        await bot.answerCallbackQuery(id, { text: 'Ödeme kaydı bulunamadı.' });
      }
    } catch (error) {
      console.error('Callback Error:', error);
      await bot.answerCallbackQuery(id, { text: 'İşlem sırasında bir hata oluştu.' });
    }
  }
});

// 6. MESAJLARI DİNLE (Eşleşme ve Komutlar)
bot.on('message', async (msg) => {
  const text = msg.text ? msg.text.trim() : '';
  const chatId = msg.chat.id;
  const chatIdStr = chatId.toString();
  const lowerText = text.toLowerCase();

  console.log(`[Telegram] Mesaj alındı: ${text} (ChatID: ${chatId})`);

  // ÖDEME EKLEME AKIŞI KONTROLÜ (Session varsa)
  const session = userSessions.get(chatIdStr);
  if (session && !text.startsWith('/')) {

    // ADIM 1: Başlık Bekleniyor
    if (session.step === 'awaiting_title') {
      session.title = text;
      session.step = 'awaiting_amount';
      userSessions.set(chatIdStr, session);

      await bot.sendMessage(chatId,
        `💰 <b>Tutar</b>\n\nToplam ödeme tutarını girin (TL):\n\n<i>Örnek: 5000</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // ADIM 2: Tutar Bekleniyor
    if (session.step === 'awaiting_amount') {
      const amount = parseFloat(text.replace(',', '.').replace(/[^\d.]/g, ''));

      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, '❌ Geçersiz tutar. Lütfen sayı girin (örn: 5000)');
        return;
      }

      session.amount = amount;
      session.step = 'awaiting_installments';
      userSessions.set(chatIdStr, session);

      // Taksit seçenekleri
      const installmentButtons = [
        [
          { text: '1 Taksit (Tek)', callback_data: 'INST:1' },
          { text: '2 Taksit', callback_data: 'INST:2' }
        ],
        [
          { text: '3 Taksit', callback_data: 'INST:3' },
          { text: '4 Taksit', callback_data: 'INST:4' }
        ],
        [
          { text: '6 Taksit', callback_data: 'INST:6' },
          { text: '9 Taksit', callback_data: 'INST:9' }
        ],
        [
          { text: '12 Taksit', callback_data: 'INST:12' },
          { text: '18 Taksit', callback_data: 'INST:18' }
        ],
        [
          { text: '24 Taksit', callback_data: 'INST:24' },
          { text: '36 Taksit', callback_data: 'INST:36' }
        ]
      ];

      await bot.sendMessage(chatId,
        `📊 <b>Taksit Sayısı</b>\n\nKaç taksit olarak ödenecek?`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: installmentButtons }
        }
      );
      return;
    }

    // ADIM 3: Tarih Bekleniyor
    if (session.step === 'awaiting_date') {
      // Tarih formatları: GG.AA.YYYY veya GG/AA/YYYY veya YYYY-MM-DD
      let parsedDate;

      // GG.AA.YYYY veya GG/AA/YYYY
      const dateParts = text.split(/[.\/\-]/);
      if (dateParts.length === 3) {
        let day, month, year;

        if (dateParts[0].length === 4) {
          // YYYY-MM-DD
          year = parseInt(dateParts[0]);
          month = parseInt(dateParts[1]) - 1;
          day = parseInt(dateParts[2]);
        } else {
          // GG.AA.YYYY
          day = parseInt(dateParts[0]);
          month = parseInt(dateParts[1]) - 1;
          year = parseInt(dateParts[2]);
        }

        parsedDate = new Date(year, month, day);
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) {
        await bot.sendMessage(chatId, '❌ Geçersiz tarih. Lütfen GG.AA.YYYY formatında girin (örn: 15.02.2026)');
        return;
      }

      session.date = parsedDate.toISOString().split('T')[0];
      session.ready = true;
      userSessions.set(chatIdStr, session);

      // Onay mesajı
      const confirmButtons = [
        [{ text: '✅ Onayla', callback_data: 'CONFIRM_PAY' }],
        [{ text: '❌ İptal', callback_data: 'CANCEL_PAY' }]
      ];

      await bot.sendMessage(chatId,
        `📋 <b>Ödeme Özeti</b>\n\n` +
        `📝 Başlık: <b>${session.title}</b>\n` +
        `💰 Tutar: <b>${session.amount.toLocaleString('tr-TR')} TL</b>\n` +
        `📊 Taksit: <b>${session.installments}</b>\n` +
        `📅 İlk Ödeme: <b>${new Date(session.date).toLocaleDateString('tr-TR')}</b>\n` +
        `📁 Kategori: <b>${session.categoryName}</b>\n\n` +
        `Onaylıyor musunuz?`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: confirmButtons }
        }
      );
      return;
    }
  }

  // EŞLEŞME KODU KONTROLÜ (5-6 haneli sayı)
  if (/^\d{5,6}$/.test(text)) {
    try {
      // 1. Bu kodu bekleyen kullanıcıyı bul
      const user = await User.findOne({ pairingCode: text });

      if (user) {
        // 2. ChatID'yi Gmail hesabına MÜHÜRLE
        user.telegramChatId = chatId.toString();
        user.pairingCode = null; // Kodu imha et (güvenlik için)
        await user.save();

        // Ayarları da güncelle
        try {
          let settings = await Settings.findOne({ userId: user._id });
          if (settings) {
            settings.telegram.chatId = chatId.toString();
            await settings.save();
          } else {
            // Ayar yoksa oluştur
            await Settings.create({
              userId: user._id,
              telegram: { chatId: chatId.toString(), notificationsEnabled: true }
            });
          }
        } catch (settingsErr) {
          console.error("Settings update error:", settingsErr);
        }

        bot.sendMessage(chatId, `✅ Selam ${user.email}!\n\nHesabın başarıyla bağlandı. Artık masaüstü uygulaman kapalı olsa bile ödeme hatırlatmaların buraya gelecek.`);
        console.log(`Kullanıcı eşleşti: ${user.email} (ChatID: ${chatId})`);
      } else {
        bot.sendMessage(chatId, "❌ Geçersiz veya süresi dolmuş kod. Lütfen uygulamadaki 'Ayarlar' kısmından yeni bir kod al.");
      }
    } catch (err) {
      console.error('Eşleşme Hatası:', err);
      bot.sendMessage(chatId, "⚠️ Bir hata oluştu, lütfen daha sonra dene.");
    }
  }
  // KOMUTLAR: /sifre
  else if (lowerText === '/sifre') {
    try {
      console.log(`[BOT] /sifre komutu alındı: ${chatId}`);
      const user = await User.findOne({ telegramChatId: chatId.toString() });

      if (!user) {
        await bot.sendMessage(chatId, '❌ Bu Telegram hesabı ile eşleşmiş bir kullanıcı bulunamadı. Lütfen önce uygulamanızdan eşleşme yapın.');
        return;
      }

      // Generate new password (8 digits)
      const newPassword = Math.floor(10000000 + Math.random() * 90000000).toString();
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      user.password = hashedPassword;
      await user.save();

      await bot.sendMessage(chatId, `✅ <b>Şifre Sıfırlama Başarılı</b>\n\n🔑 Yeni Giriş Şifreniz: <code>${newPassword}</code>\n\nLütfen giriş yaptıktan sonra şifrenizi değiştirin.`, { parse_mode: 'HTML' });
      console.log(`Şifre sıfırlandı: ${user.email}`);

    } catch (error) {
      console.error('Bot Password Reset Error:', error);
      await bot.sendMessage(chatId, '❌ Bir hata oluştu.');
    }
  }
  // KOMUTLAR: /gelirgidersifre
  else if (lowerText === '/gelirgidersifre') {
    try {
      console.log(`[BOT] /gelirgidersifre komutu alındı: ${chatId}`);
      const user = await User.findOne({ telegramChatId: chatId.toString() });

      if (!user) {
        await bot.sendMessage(chatId, '❌ Bu Telegram hesabı ile eşleşmiş bir kullanıcı bulunamadı. Lütfen önce uygulamanızdan eşleşme yapın.');
        return;
      }

      // Generate new password (8 digits)
      const newPassword = Math.floor(10000000 + Math.random() * 90000000).toString();
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      user.incomeExpensePassword = hashedPassword;
      await user.save();

      await bot.sendMessage(chatId, `✅ <b>Gelir/Gider Şifresi Sıfırlandı</b>\n\n🔑 Yeni Şifreniz: <code>${newPassword}</code>\n\nBu şifre ile Gelir/Gider sayfasına erişebilirsiniz.`, { parse_mode: 'HTML' });
      console.log(`Gelir/Gider şifresi sıfırlandı: ${user.email}`);

    } catch (error) {
      console.error('Bot Income Password Reset Error:', error);
      await bot.sendMessage(chatId, '❌ Bir hata oluştu.');
    }
  }
  // KOMUTLAR: /start
  else if (lowerText === '/start') {
    bot.sendMessage(chatId, '👋 Merhaba! Ödeme Takip Sistemi ile eşleşmek için masaüstü uygulamasındaki "Ayarlar" bölümünden aldığın 5-6 haneli kodu buraya yaz.');
  }
  // KOMUTLAR: ödemelerim / payments
  else if (lowerText === 'ödemelerim' || lowerText === 'payments' || lowerText === '/odemeler') {
    try {
      console.log(`[Telegram] 'ödemelerim' komutu işleniyor... ChatID: ${chatId}`);

      const user = await User.findOne({ telegramChatId: chatId.toString() });

      if (!user) {
        await bot.sendMessage(chatId, '❌ Bu Telegram hesabı ile eşleşmiş bir kullanıcı bulunamadı. Lütfen uygulamadan eşleştirme yapın.');
        return;
      }

      // Ödemeleri getir
      const payments = await Payment.find({ userId: user._id });
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const upcomingPayments = payments.flatMap(p =>
        p.installmentPlan
          .filter(inst => !inst.isPaid)
          .map(inst => ({ ...inst, paymentTitle: p.title, type: p.type, paymentId: p._id }))
      ).sort((a, b) => new Date(a.date) - new Date(b.date));

      if (upcomingPayments.length === 0) {
        await bot.sendMessage(chatId, '🎉 Harika! Hiç ödenmemiş borcunuz bulunmuyor.');
        return;
      }

      // Özet Mesaj Oluştur
      const totalAmount = upcomingPayments.reduce((sum, p) => sum + p.amount, 0);

      let messageText = `📋 <b>Ödeme Listesi</b>\n\nToplam <b>${upcomingPayments.length}</b> adet ödenmemiş borcunuz var.\n\n`;
      const inlineKeyboard = [];

      // İlk 15 ödemeyi göster
      upcomingPayments.slice(0, 15).forEach((p) => {
        const dateStr = new Date(p.date).toLocaleDateString('tr-TR');
        const instDate = new Date(p.date);
        instDate.setHours(0, 0, 0, 0);
        const diffTime = instDate - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        let dayText = '';
        if (diffDays < 0) dayText = ` (⚠️ ${Math.abs(diffDays)} gün gecikti)`;
        else if (diffDays === 0) dayText = ' (BUGÜN)';
        else if (diffDays === 1) dayText = ' (Yarın)';
        else dayText = ` (${diffDays} gün kaldı)`;

        messageText += `▪️ <b>${p.paymentTitle}</b> - ${p.amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL - ${dateStr}${dayText}\n`;

        // Öde Butonu Ekle
        inlineKeyboard.push([{
          text: `✅ Öde: ${p.paymentTitle} (${p.amount.toLocaleString('tr-TR')} TL)`,
          callback_data: `PAY:${p.paymentId}:${p.date}`
        }]);
      });

      if (upcomingPayments.length > 15) {
        messageText += `\n<i>...ve ${upcomingPayments.length - 15} diğer ödeme.</i>`;
      }

      messageText += `\nToplam Borç: <b>${totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>`;

      await bot.sendMessage(chatId, messageText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      });

    } catch (error) {
      console.error('Telegram Komut Hatası:', error);
      await bot.sendMessage(chatId, '⚠️ Bir hata oluştu. Lütfen daha sonra tekrar deneyiniz.');
    }
  }
  // KOMUTLAR: /bakiye - Toplam Borç Özeti
  else if (lowerText === '/bakiye') {
    try {
      const user = await User.findOne({ telegramChatId: chatId.toString() });
      if (!user) {
        await bot.sendMessage(chatId, '❌ Hesabınız eşleşmemiş. Lütfen uygulamadan eşleştirme yapın.');
        return;
      }

      const payments = await Payment.find({ userId: user._id });
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Tüm ödenmemiş taksitleri hesapla
      let totalDebt = 0;
      let overdueDebt = 0;
      let thisMonthDebt = 0;
      let overdueCount = 0;
      let thisMonthCount = 0;

      payments.forEach(p => {
        p.installmentPlan.filter(inst => !inst.isPaid).forEach(inst => {
          const instDate = new Date(inst.date);
          instDate.setHours(0, 0, 0, 0);
          const amount = inst.amount || 0;

          totalDebt += amount;

          if (instDate < today) {
            overdueDebt += amount;
            overdueCount++;
          }

          // Bu ay
          if (instDate.getMonth() === today.getMonth() && instDate.getFullYear() === today.getFullYear()) {
            thisMonthDebt += amount;
            thisMonthCount++;
          }
        });
      });

      let message = `💰 <b>Bakiye Özeti</b>\n\n`;
      message += `📊 Toplam Borç: <b>${totalDebt.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>\n\n`;

      if (overdueCount > 0) {
        message += `⚠️ Gecikmiş: <b>${overdueDebt.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b> (${overdueCount} ödeme)\n`;
      }

      message += `📅 Bu Ay: <b>${thisMonthDebt.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b> (${thisMonthCount} ödeme)\n`;

      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    } catch (error) {
      console.error('Bakiye komut hatası:', error);
      await bot.sendMessage(chatId, '⚠️ Bir hata oluştu.');
    }
  }
  // KOMUTLAR: /yedek - Manuel Yedek Al
  else if (lowerText === '/yedek') {
    try {
      const user = await User.findOne({ telegramChatId: chatId.toString() });
      if (!user) {
        await bot.sendMessage(chatId, '❌ Hesabınız eşleşmemiş.');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Yedek hazırlanıyor...');

      const userId = user._id;
      const [userData, payments, settingsData, dailyIncomes] = await Promise.all([
        User.findById(userId).lean(),
        Payment.find({ userId }).lean(),
        Settings.findOne({ userId }).lean(),
        DailyIncome.find({ userId }).lean()
      ]);

      const backupData = {
        timestamp: new Date().toISOString(),
        user: userData,
        settings: settingsData,
        payments: payments,
        dailyIncomes: dailyIncomes
      };

      const jsonString = JSON.stringify(backupData);
      const checksum = crypto.createHash('sha256').update(jsonString).digest('hex');

      const finalBackup = { ...backupData, checksum };
      const buffer = Buffer.from(JSON.stringify(finalBackup, null, 2), 'utf-8');
      const fileName = `Yedek_${user.email}_${new Date().toISOString().split('T')[0]}.json`;

      await bot.sendDocument(chatId, buffer, {
        caption: `📦 <b>Manuel Yedekleme</b>\n\n📅 Tarih: ${new Date().toLocaleString('tr-TR')}\n✅ Verileriniz güvenle yedeklendi.`,
        parse_mode: 'HTML'
      }, {
        filename: fileName,
        contentType: 'application/json'
      });

    } catch (error) {
      console.error('Yedek komut hatası:', error);
      await bot.sendMessage(chatId, '⚠️ Yedekleme sırasında hata oluştu.');
    }
  }
  // KOMUTLAR: /kur - Güncel Döviz Kurları
  else if (lowerText === '/kur') {
    try {
      await bot.sendMessage(chatId, '⏳ Kurlar yükleniyor...');

      const axios = require('axios');
      const [currencyRes, goldRes] = await Promise.all([
        axios.get('https://api.genelpara.com/json/?list=doviz&sembol=all', {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }),
        axios.get('https://api.genelpara.com/json/?list=altin&sembol=all', {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
      ]);

      const currency = currencyRes.data.data;
      const gold = goldRes.data.data;

      let message = `💱 <b>Güncel Döviz Kurları</b>\n\n`;

      // Dövizler
      if (currency) {
        message += `🇺🇸 <b>USD:</b> ${currency.USD?.satis || '-'} TL\n`;
        message += `🇪🇺 <b>EUR:</b> ${currency.EUR?.satis || '-'} TL\n`;
        message += `🇬🇧 <b>GBP:</b> ${currency.GBP?.satis || '-'} TL\n`;
        message += `🇨🇭 <b>CHF:</b> ${currency.CHF?.satis || '-'} TL\n\n`;
      }

      // Altın
      message += `🥇 <b>Altın Fiyatları</b>\n\n`;
      if (gold) {
        message += `• <b>Gram Altın:</b> ${gold.GA?.satis || gold.ga?.satis || '-'} TL\n`;
        message += `• <b>Çeyrek Altın:</b> ${gold.C?.satis || gold.c?.satis || '-'} TL\n`;
        message += `• <b>Yarım Altın:</b> ${gold.Y?.satis || gold.y?.satis || '-'} TL\n`;
        message += `• <b>Tam Altın:</b> ${gold.T?.satis || gold.t?.satis || '-'} TL\n`;
      }

      message += `\n<i>Son güncelleme: ${new Date().toLocaleTimeString('tr-TR')}</i>`;

      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });

    } catch (error) {
      console.error('Kur komut hatası:', error);
      await bot.sendMessage(chatId, '⚠️ Kurlar yüklenirken hata oluştu.');
    }
  }
  // KOMUTLAR: /odemeekle - Ödeme Ekle (Interaktif)
  else if (lowerText === '/odemeekle' || lowerText.startsWith('/odemeekle ')) {
    try {
      const user = await User.findOne({ telegramChatId: chatId.toString() });
      if (!user) {
        await bot.sendMessage(chatId, '❌ Hesabınız eşleşmemiş.');
        return;
      }

      // Inline keyboard ile kategori seçimi
      const categories = [
        [{ text: '💳 Kredi Kartı', callback_data: 'ADD_PAY:kredi_karti' }],
        [{ text: '📄 Çek', callback_data: 'ADD_PAY:cek' }],
        [{ text: '📃 Senet', callback_data: 'ADD_PAY:senet' }],
        [{ text: '🏠 Kira', callback_data: 'ADD_PAY:kira' }],
        [{ text: '⚡ Fatura', callback_data: 'ADD_PAY:fatura' }],
        [{ text: '📦 Diğer', callback_data: 'ADD_PAY:diger' }]
      ];

      await bot.sendMessage(chatId,
        `➕ <b>Yeni Ödeme Ekle</b>\n\nÖdeme türünü seçin:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: categories }
        }
      );

    } catch (error) {
      console.error('Ödeme ekle komut hatası:', error);
      await bot.sendMessage(chatId, '⚠️ Bir hata oluştu.');
    }
  }
  // KOMUTLAR: /yardim - Komut Listesi
  else if (lowerText === '/yardim' || lowerText === '/help') {
    const helpMessage = `📚 <b>Kullanılabilir Komutlar</b>\n\n` +
      `💳 <b>/odemeler</b> - Bekleyen ödemeleri listele\n` +
      `💰 <b>/bakiye</b> - Toplam borç özeti\n` +
      `➕ <b>/odemeekle</b> - Yeni ödeme ekle\n` +
      `💱 <b>/kur</b> - Güncel döviz kurları\n` +
      `📦 <b>/yedek</b> - Manuel yedek al\n` +
      `🔑 <b>/sifre</b> - Giriş şifresini sıfırla\n` +
      `🔐 <b>/gelirgidersifre</b> - Gelir/Gider şifresini sıfırla\n\n` +
      `<i>Sorularınız için: @yehsqn</i>`;

    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
  }
});

// 7. GÜNLÜK KONTROL FONKSİYONU (Kalıcı Hafızadan Okuma)
async function checkAndSendReminders() {
  console.log('🔄 Ödeme kontrolleri yapılıyor...');
  try {
    // ChatID'si olan tüm kullanıcıları bul
    const usersWithChatId = await User.find({
      telegramChatId: { $exists: true, $ne: null }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    for (const user of usersWithChatId) {
      const { telegramChatId, _id: userId, email } = user;

      // Ayarları kontrol et
      let settings = await Settings.findOne({ userId });

      // Bildirimler kapalıysa atla
      if (settings && settings.telegram && settings.telegram.notificationsEnabled === false) {
        continue;
      }

      // Bugün zaten bildirim gittiyse atla
      if (settings && settings.lastTelegramNotification === todayStr) {
        console.log(`User ${email} için bugün zaten bildirim atıldı.`);
        continue;
      }

      // Ödemeleri getir
      const payments = await Payment.find({ userId });

      // Yaklaşan ödemeleri filtrele (0-3 gün)
      const upcomingPayments = payments.flatMap(p =>
        p.installmentPlan
          .filter(inst => !inst.isPaid)
          .map(inst => ({ ...inst, paymentTitle: p.title, type: p.type, paymentId: p._id }))
      ).filter(inst => {
        const instDate = new Date(inst.date);
        instDate.setHours(0, 0, 0, 0);

        const diffTime = instDate - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        return diffDays >= 0 && diffDays <= 3;
      });

      if (upcomingPayments.length > 0) {
        const totalAmount = upcomingPayments.reduce((sum, p) => sum + p.amount, 0);

        // GRUPLANDIRILMIŞ MESAJ OLUŞTUR
        let messageText = `📢 <b>Ödeme Hatırlatıcı</b>\n\nSayın ${email}, yaklaşan <b>${upcomingPayments.length}</b> adet ödemeniz var (Son 3 gün).\n\n`;
        const inlineKeyboard = [];

        upcomingPayments.slice(0, 10).forEach(p => {
          const dateStr = new Date(p.date).toLocaleDateString('tr-TR');
          const instDate = new Date(p.date);
          instDate.setHours(0, 0, 0, 0);
          const diffTime = instDate - today;
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          let dayText = '';
          if (diffDays === 0) dayText = ' (BUGÜN)';
          else if (diffDays === 1) dayText = ' (Yarın)';
          else dayText = ` (${diffDays} gün kaldı)`;

          messageText += `▪️ <b>${p.paymentTitle}</b> - ${p.amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL - ${dateStr}${dayText}\n`;

          // Buton ekle
          inlineKeyboard.push([{
            text: `✅ Öde: ${p.paymentTitle} (${p.amount.toLocaleString('tr-TR')} TL)`,
            callback_data: `PAY:${p.paymentId}:${p.date}`
          }]);
        });

        if (upcomingPayments.length > 10) {
          messageText += `\n<i>...ve ${upcomingPayments.length - 10} diğer ödeme.</i>`;
        }

        messageText += `\nToplam Tutar: <b>${totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>\n\nÖdeme yapmak için butonları kullanabilirsiniz.`;

        try {
          await bot.sendMessage(telegramChatId, messageText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: inlineKeyboard }
          });
          console.log(`✅ Bildirim gönderildi: ${email}`);

          // Son bildirim tarihini güncelle
          if (settings) {
            settings.lastTelegramNotification = todayStr;
            await settings.save();
          } else {
            await Settings.create({ userId, lastTelegramNotification: todayStr });
          }
        } catch (error) {
          console.error(`❌ Bildirim gönderme hatası (${email}):`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Genel Kontrol Hatası:', error);
  }
}

// 8. ZAMANLAYICI (Her gün 09:00, 12:00 ve 14:00'te çalışır)
schedule.scheduleJob('0 9,12,14 * * *', () => {
  console.log('⏰ Otomatik Kontrol (09/12/14) çalışıyor...');
  checkAndSendReminders();
});

// 9. OTOMATİK YEDEKLEME (Dakikalık Kontrol - Kullanıcı Ayarına Göre)
schedule.scheduleJob('* * * * *', async () => {
  const now = new Date();

  // TÜRKİYE SAATİ (Europe/Istanbul - UTC+3)
  const formatter = new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const currentTime = formatter.format(now);

  try {
    // Yedekleme ayarı açık olan ve saati gelen ayarları bul
    const targetSettings = await Settings.find({
      'backup.enabled': true,
      'backup.time': currentTime
    });

    if (targetSettings.length > 0) {
      console.log(`📦 Otomatik Yedekleme Tetiklendi: ${currentTime} (${targetSettings.length} kullanıcı)`);
    }

    for (const setting of targetSettings) {
      try {
        const userId = setting.userId;
        const user = await User.findById(userId);

        if (!user || !user.telegramChatId) continue;

        const chatId = user.telegramChatId;

        // Kullanıcıya ait tüm verileri çek
        const [userData, payments, settingsData, dailyIncomes] = await Promise.all([
          User.findById(userId).lean(),
          Payment.find({ userId }).lean(),
          Settings.findOne({ userId }).lean(),
          DailyIncome.find({ userId }).lean()
        ]);

        const backupData = {
          timestamp: new Date().toISOString(),
          user: userData,
          settings: settingsData,
          payments: payments,
          dailyIncomes: dailyIncomes
        };

        // Calculate Checksum (SHA-256) for data integrity
        const jsonString = JSON.stringify(backupData);
        const checksum = crypto.createHash('sha256').update(jsonString).digest('hex');

        // Add checksum to the final object
        const finalBackup = {
          ...backupData,
          checksum
        };

        const finalJsonString = JSON.stringify(finalBackup, null, 2);
        const buffer = Buffer.from(finalJsonString, 'utf-8');

        const fileName = `Yedek_${user.email}_${new Date().toISOString().split('T')[0]}.json`;

        await bot.sendDocument(chatId, buffer, {
          caption: `📅 Günlük Otomatik Veri Yedeği (${new Date().toLocaleDateString('tr-TR')})\n\nBu dosya tüm verilerinizi içerir.`
        }, {
          filename: fileName,
          contentType: 'application/json'
        });

        console.log(`✅ Yedek gönderildi: ${user.email}`);
      } catch (err) {
        console.error(`❌ Yedekleme hatası (UserID: ${setting.userId}):`, err);
      }
    }
  } catch (globalErr) {
    console.error('Genel Yedekleme Hatası:', globalErr);
  }
});

// 10. HTTP SUNUCUSU (Render Health Check)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Odeme Takip Botu Calisiyor!');
  res.end();
}).listen(PORT, () => {
  console.log(`🌐 HTTP Sunucusu ${PORT} portunda dinleniyor.`);
});

// Hata yakalama
bot.on('polling_error', (error) => {
  console.log(`[Polling Error] ${error.code}: ${error.message}`);
});

console.log("🚀 Bot başlatıldı ve dinlemeye geçti...");
