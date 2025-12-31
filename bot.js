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
  .catch(err => {
    console.error("❌ MongoDB Bağlantı Hatası:", err);
    console.log("HATA DETAYI:", err.message);
  });

// 5. EŞLEŞME MANTIĞI (Kalıcı Eşleşme)
bot.on('message', async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (text && /^\d{5,6}$/.test(text)) {
    try {
      // 1. Bu kodu bekleyen kullanıcıyı bul
      const user = await User.findOne({ pairingCode: text });

      if (user) {
        // 2. ChatID'yi Gmail hesabına MÜHÜRLE
        user.telegramChatId = chatId.toString();
        user.pairingCode = null; // Kodu imha et (güvenlik için)
        await user.save();

        // Ayarları da güncelle (Opsiyonel ama tutarlılık için iyi)
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
  } else if (text === '/start') {
    bot.sendMessage(chatId, '👋 Merhaba! Ödeme Takip Sistemi ile eşleşmek için masaüstü uygulamasındaki "Ayarlar" bölümünden aldığın 5-6 haneli kodu buraya yaz.');
  }
});

// 6. GÜNLÜK KONTROL FONKSİYONU (Kalıcı Hafızadan Okuma)
async function checkAndSendReminders() {
  console.log('🔄 Ödeme kontrolleri yapılıyor...');
  try {
    // ChatID'si olan tüm kullanıcıları bul (Gmail tabanlı tarama)
    const usersWithChatId = await User.find({ 
      telegramChatId: { $exists: true, $ne: null } 
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const user of usersWithChatId) {
      const { telegramChatId, _id: userId, email } = user;
      
      // Kullanıcının ayarlarını kontrol et (Bildirimler açık mı?)
      const settings = await Settings.findOne({ userId });
      if (settings && settings.telegram && settings.telegram.notificationsEnabled === false) {
        continue;
      }

      // Ödemeleri getir
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
        
        // 3 gün, 2 gün, 1 gün ve BUGÜN (0)
        return diffDays >= 0 && diffDays <= 3;
      });

      if (upcomingPayments.length > 0) {
        // 3, 2, 1, 0 gün mantığını uygula
        // Her gün hatırlatıcı göndermek istiyoruz, yani lastNotified kontrolünü güncellememiz lazım
        // Kullanıcı isteği: "Ödemeye 3 gün kala, 2 gün kala, 1 gün kala ve son gün; her gün... hatırlatıcı gönderilmeli."
        // Mevcut kod lastNotified === todayStr ise göndermiyor. Bu doğru, çünkü günde 1 kere çalışmalı.
        // Ama scheduleJob 09, 12, 14 saatlerinde çalışıyor. 
        // Eğer 09'da gönderdiyse, 12'de tekrar göndermemeli.
        
        let lastNotified = null;
        if (settings) {
            lastNotified = settings.lastTelegramNotification;
        }
        
        const todayStr = today.toISOString().split('T')[0];
        
        // Eğer bugün zaten bildirim gittiyse atla
        if (lastNotified === todayStr) {
           console.log(`User ${email} için bugün zaten bildirim atıldı.`);
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

        const message = `📢 <b>Ödeme Hatırlatıcı</b>\n\nSayın ${email}, yaklaşan <b>${upcomingPayments.length}</b> adet ödemeniz var.\n\n${paymentDetails}${moreText}\n\nToplam Tutar: <b>${totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>\n\nLütfen kontrol ediniz.`;
        
        try {
          await bot.sendMessage(telegramChatId, message, { parse_mode: 'HTML' });
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

// 7. ZAMANLAYICI (Her gün 09:00, 12:00 ve 14:00'te çalışır)
schedule.scheduleJob('0 9,12,14 * * *', () => {
  console.log('⏰ Otomatik Kontrol (09/12/14) çalışıyor...');
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