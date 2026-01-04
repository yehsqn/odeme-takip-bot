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

// 5. BUTON TIKLAMALARINI DİNLE (Callback Query)
bot.on('callback_query', async (query) => {
  const { data, message, id } = query;
  // Format: PAY:PaymentID:Date
  const parts = data.split(':');
  
  if (parts.length < 3) return;

  const action = parts[0];
  const paymentId = parts[1];
  const date = parts.slice(2).join(':'); // Tarih bazen : içerebilir ama burada YYYY-MM-DD formatı bekliyoruz

  if (action === 'PAY') {
    try {
      const payment = await Payment.findById(paymentId);
      if (payment) {
        const installment = payment.installmentPlan.find(i => i.date === date);
        if (installment && !installment.isPaid) {
          installment.isPaid = true;
          payment.markModified('installmentPlan');
          await payment.save();

          // Cevap ver (Toast mesajı)
          await bot.answerCallbackQuery(id, { text: 'Ödemeniz başarıyla kaydedildi! ✅' });

          // Mesajı güncelle: Tıklanan butonu kaldır ve metne "Ödendi" ekle
          const currentKeyboard = message.reply_markup.inline_keyboard;
          // Tıklanan butonu filtrele (data eşleşmesine göre)
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
  const lowerText = text.toLowerCase();

  console.log(`[Telegram] Mesaj alındı: ${text} (ChatID: ${chatId})`);

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

        // Generate new password
        const newPassword = Math.floor(100000 + Math.random() * 900000).toString();
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
  else if (lowerText === 'ödemelerim' || lowerText === 'payments') {
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
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  
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
