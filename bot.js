const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const schedule = require('node-schedule');
const http = require('http');

// 1. MONGODB BAĞLANTISI
const mongoURI = 'mongodb+srv://yehsqn:yehsan1907efe42pbag10kdb17@cluster0.cbct0mv.mongodb.net/OdemeTakipDB?retryWrites=true&w=majority';

// 2. MONGOOSE ŞEMALARI (Masaüstü uygulamasıyla birebir aynı olmalı)
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  telegramChatId: String,
  pairingCode: String,
  pin: String,
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
    botToken: { type: String, default: '8329470679:AAFeVOV3Hexp8GmNyCMR-RSYosSukBRcWhg' },
    chatId: String,
    notificationsEnabled: { type: Boolean, default: true }
  },
  banks: { type: Array, default: [] },
  notificationDays: { type: Number, default: 3 },
  lastTelegramNotification: String,
  appPassword: String
});

const User = mongoose.model('User', UserSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// 3. BOT AYARLARI
const token = '8329470679:AAFgx7WOzZhe8wI46ytq1VfFPm2u91O-S_0'; // Masaüstü uygulamasındaki token ile aynı olmalı
const bot = new TelegramBot(token, { polling: true });

// 4. MONGODB'YE BAĞLAN
mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Bağlantısı Başarılı!"))
  .catch(err => console.error("❌ MongoDB Bağlantı Hatası:", err));

// 5. EŞLEŞME MANTIĞI (Masaüstü uygulamasından gelen kod)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  // 5-6 haneli sayı kontrolü (Eşleşme Kodu)
  if (/^\d{5,6}$/.test(text)) {
    try {
      // Bu kodu veritabanında arıyoruz (Masaüstü uygulaması User tablosuna kaydediyor)
      const user = await User.findOne({ pairingCode: text });
      
      if (user) {
        user.telegramChatId = chatId.toString();
        user.pairingCode = null; // Kodu temizle, tekrar kullanılamasın
        await user.save();
        
        // Ayarları da güncelle
        let settings = await Settings.findOne({ userId: user._id });
        if (!settings) {
          settings = new Settings({ userId: user._id });
        }
        settings.telegram.chatId = chatId.toString();
        await settings.save();

        bot.sendMessage(chatId, `✅ Eşleşme Başarılı! Hoş geldin, ${user.email}. Artık ödeme hatırlatmalarını buradan alacaksın.`);
        console.log(`Kullanıcı eşleşti: ${user.email} (ChatID: ${chatId})`);
      } else {
        bot.sendMessage(chatId, `❌ Geçersiz veya süresi dolmuş kod. Lütfen uygulamadan yeni kod alıp tekrar deneyin.`);
      }
    } catch (error) {
      console.error('Eşleşme Hatası:', error);
      bot.sendMessage(chatId, `❌ Bir hata oluştu.`);
    }
  } else if (text === '/start') {
    bot.sendMessage(chatId, '👋 Merhaba! Ödeme Takip Sistemi ile eşleşmek için masaüstü uygulamasındaki "Ayarlar" bölümünden aldığın 5-6 haneli kodu buraya yaz.');
  }
});

// 6. GÜNLÜK KONTROL FONKSİYONU
async function checkAndSendReminders() {
  console.log('🔄 Ödeme kontrolleri yapılıyor...');
  try {
    // Bildirimleri açık olan kullanıcıları bul
    const allSettings = await Settings.find({ 
      'telegram.notificationsEnabled': true,
      'telegram.chatId': { $exists: true, $ne: null }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const setting of allSettings) {
      const { telegram, userId } = setting;
      
      // Eğer kullanıcının chat ID'si yoksa atla
      if (!telegram?.chatId) continue;

      const payments = await Payment.find({ userId });
      
      // Ödenmemiş taksitleri bul ve tarihine göre filtrele (0-3 gün kalanlar)
      const upcomingPayments = payments.flatMap(p => 
        p.installmentPlan
          .filter(inst => !inst.isPaid)
          .map(inst => ({ ...inst, paymentTitle: p.title, type: p.type }))
      ).filter(inst => {
        const instDate = new Date(inst.date);
        instDate.setHours(0, 0, 0, 0);
        
        const diffTime = instDate - today;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        return diffDays >= 0 && diffDays <= 3;
      });

      if (upcomingPayments.length > 0) {
        // Bugün zaten bildirim gönderildiyse tekrar gönderme
        const lastNotified = setting.lastTelegramNotification;
        const todayStr = today.toISOString().split('T')[0];
        
        if (lastNotified === todayStr) {
           console.log(`User ${userId} için bugün zaten bildirim atıldı.`);
           continue;
        }

        const totalAmount = upcomingPayments.reduce((sum, p) => sum + p.amount, 0);
        
        // Mesajı oluştur
        const paymentDetails = upcomingPayments.slice(0, 10).map(p => {
          const dateStr = new Date(p.date).toLocaleDateString('tr-TR');
          const instDate = new Date(p.date);
          instDate.setHours(0, 0, 0, 0);
          const diffTime = instDate - today;
          const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
          
          let dayText = '';
          if (daysLeft === 0) dayText = ' (BUGÜN)';
          else if (daysLeft === 1) dayText = ' (Yarın)';
          else dayText = ` (${daysLeft} gün kaldı)`;

          return `▪️ <b>${dateStr}</b>${dayText} - ${p.paymentTitle}: <b>${p.amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} TL</b>`;
        }).join('\n');
        
        const moreCount = upcomingPayments.length - 10;
        const moreText = moreCount > 0 ? `\n<i>...ve ${moreCount} diğer ödeme.</i>` : '';

        const message = `� <b>Ödeme Hatırlatıcı</b>\n\nYaklaşan <b>${upcomingPayments.length}</b> adet ödemeniz var (Son 3 gün).\n\n${paymentDetails}${moreText}\n\nToplam Tutar: <b>${totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>\n\nLütfen kontrol ediniz.`;
        
        try {
          await bot.sendMessage(telegram.chatId, message, { parse_mode: 'HTML' });
          console.log(`✅ Bildirim gönderildi: User ${userId}`);
          
          // Son bildirim tarihini güncelle
          setting.lastTelegramNotification = todayStr;
          await setting.save();
        } catch (error) {
          console.error(`❌ Bildirim gönderme hatası (User ${userId}):`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Genel Kontrol Hatası:', error);
  }
}

// 7. ZAMANLAYICI (Her gün sabah 09:00'da çalışır)
schedule.scheduleJob('0 9 * * *', () => {
  console.log('⏰ Sabah 09:00 - Günlük kontrol çalışıyor...');
  checkAndSendReminders();
});

// Render Health Check için basit HTTP sunucusu (Render Web Service kullanılıyorsa gereklidir)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('Odeme Takip Botu Calisiyor!');
  res.end();
}).listen(PORT, () => {
  console.log(`🌐 HTTP Sunucusu ${PORT} portunda dinleniyor.`);
});

console.log("🚀 Bot başlatıldı ve dinlemeye geçti...");
