const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const schedule = require('node-schedule');
const crypto = require('crypto');
const http = require('http');

// 1. MONGODB BAĞLANTISI
const mongoURI = 'mongodb+srv://yehsqn:yehsan1907efe42pbag10kdb17@cluster0.cbct0mv.mongodb.net/OdemeTakipDB?retryWrites=true&w=majority';

// 2. MONGOOSE ŞEMALARI
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  telegramChatId: String,
  pairingCode: String,
  pairingCodeExpiresAt: Date,
  pin: String,
  incomeExpensePassword: { type: String },
  createdAt: { type: Date, default: Date.now },
  role: { type: String, default: 'user' }
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
}, { collection: 'payments' });

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
const token = '8329470679:AAFgx7WOzZhe8wI46ytq1VfFPm2u91O-S_0';
const bot = new TelegramBot(token, { polling: true });

// Bot Konuşma Durumları
const botStates = {};

// 4. MONGODB'YE BAĞLAN
mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Bağlantısı Başarılı!"))
  .catch(err => {
    console.error("❌ MongoDB Bağlantı Hatası:", err);
  });

// 5. MESAJLARI DİNLE (GELİŞMİŞ SİHİRBAZ)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    console.log(`📩 Mesaj alındı: ${text} (ChatID: ${chatId})`);

    if (!text) return;

    const textLower = text.toLowerCase();

    // --- PING (Durum Kontrolü) ---
    if (textLower === '/ping' || textLower === 'ping') {
        await bot.sendMessage(chatId, '🏓 Pong! Bot çalışıyor.\n📅 Sunucu Zamanı: ' + new Date().toLocaleString('tr-TR'));
        return;
    }

    // --- PAIRING (Eşleştirme) ---
    if (text.startsWith('/start ')) {
        const code = text.split(' ')[1];
        if (code) {
            try {
                const user = await User.findOne({ 
                    pairingCode: code, 
                    pairingCodeExpiresAt: { $gt: new Date() } 
                });

                if (user) {
                    user.telegramChatId = chatId.toString();
                    user.pairingCode = undefined;
                    user.pairingCodeExpiresAt = undefined;
                    await user.save();

                    // Update Settings if exists
                    const settings = await Settings.findOne({ userId: user._id });
                    if (settings) {
                        settings.telegram.chatId = chatId.toString();
                        await settings.save();
                    }

                    await bot.sendMessage(chatId, '✅ Hesabınız başarıyla eşleştirildi! Artık bildirimleri buradan alacaksınız.');
                } else {
                    await bot.sendMessage(chatId, '❌ Geçersiz veya süresi dolmuş eşleştirme kodu.');
                }
            } catch (error) {
                console.error('Pairing Error:', error);
                await bot.sendMessage(chatId, '⚠️ Bir hata oluştu.');
            }
            return;
        }
    }

    // --- CONVERSATION FLOW (Sihirbaz) ---
    if (botStates[chatId]) {
        const state = botStates[chatId];
        try {
            switch (state.step) {
                case 'TITLE':
                    if (textLower === 'iptal') {
                        delete botStates[chatId];
                        await bot.sendMessage(chatId, '🚫 İşlem iptal edildi.');
                        return;
                    }
                    state.data.title = text;
                    state.step = 'AMOUNT';
                    await bot.sendMessage(chatId, '💰 Tutar ne kadar? (Örn: 1500.50)');
                    break;

                case 'AMOUNT':
                    // Replace comma with dot and remove non-numeric except dot
                    const cleanAmount = text.replace(',', '.').replace(/[^0-9.]/g, '');
                    const amount = parseFloat(cleanAmount);
                    
                    if (isNaN(amount) || amount <= 0) {
                        await bot.sendMessage(chatId, '❌ Geçersiz tutar. Lütfen sayısal bir değer girin (Örn: 100 or 100.50):');
                        return; // Keep state
                    }
                    
                    state.data.amount = amount;
                    state.step = 'INSTALLMENTS';
                    await bot.sendMessage(chatId, '📅 Kaç taksit? (Tek çekim için 1 yazın)');
                    break;

                case 'INSTALLMENTS':
                    const installments = parseInt(text.replace(/[^0-9]/g, ''));
                    if (isNaN(installments) || installments < 1) {
                         await bot.sendMessage(chatId, '❌ Lütfen geçerli bir sayı girin (En az 1):');
                         return;
                    }
                    
                    state.data.installments = installments;
                    state.step = 'DATE';
                    await bot.sendMessage(chatId, '🗓️ Ödeme tarihi/günü ne zaman?\n(Format: GÜN.AY.YIL - Örn: 25.05.2024)\nveya "bugün", "yarın" yazabilirsiniz.');
                    break;

                case 'DATE':
                    let dateStr = '';
                    const now = new Date();
                    
                    if (textLower === 'bugün' || textLower === 'bugun') {
                        dateStr = now.toISOString().split('T')[0];
                    } else if (textLower === 'yarın' || textLower === 'yarin') {
                        const tomorrow = new Date(now);
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        dateStr = tomorrow.toISOString().split('T')[0];
                    } else {
                        // Try parsing DD.MM.YYYY
                        const parts = text.split(/[./-]/);
                        if (parts.length === 3) {
                           // Assume DD MM YYYY
                           const d = parts[0].padStart(2, '0');
                           const m = parts[1].padStart(2, '0');
                           let y = parts[2];
                           if (y.length === 2) y = '20' + y;
                           dateStr = `${y}-${m}-${d}`;
                        } else {
                           await bot.sendMessage(chatId, '❌ Geçersiz tarih formatı. Lütfen GÜN.AY.YIL (Örn: 25.05.2024) formatında girin:');
                           return;
                        }
                    }

                    // Check if date is valid
                    if (isNaN(new Date(dateStr).getTime())) {
                        await bot.sendMessage(chatId, '❌ Geçersiz tarih. Tekrar deneyin:');
                        return;
                    }

                    state.data.date = dateStr;
                    state.step = 'BANK';
                    
                    // Bank Options Keyboard
                    const bankKeyboard = {
                        keyboard: [
                            ['Ziraat', 'Garanti', 'İş Bankası'],
                            ['Yapı Kredi', 'Akbank', 'QNB'],
                            ['Diğer']
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    };
                    
                    await bot.sendMessage(chatId, '🏦 Hangi banka?', { reply_markup: bankKeyboard });
                    break;

                case 'BANK':
                    state.data.bank = text;
                    state.step = 'CATEGORY';
                    
                    // Category Options Keyboard
                    const categoryKeyboard = {
                        keyboard: [
                            ['Market', 'Fatura', 'Kira'],
                            ['Giyim', 'Eğitim', 'Sağlık'],
                            ['Eğlence', 'Ulaşım', 'Diğer']
                        ],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    };
                    
                    await bot.sendMessage(chatId, '📂 Hangi kategori?', { reply_markup: categoryKeyboard });
                    break;

                case 'CATEGORY':
                    state.data.category = text;
                    
                    // Find user first
                    const user = await User.findOne({ telegramChatId: chatId.toString() });
                    if (!user) {
                         await bot.sendMessage(chatId, '❌ Kullanıcı bulunamadı.');
                         delete botStates[chatId];
                         return;
                    }

                    // SAVE TO DB
                    const newPayment = {
                        userId: user._id,
                        id: crypto.randomUUID(),
                        title: state.data.title,
                        amount: state.data.amount,
                        installments: state.data.installments,
                        date: state.data.date,
                        type: 'credit_card', 
                        category: state.data.category,
                        bank: state.data.bank,
                        installmentPlan: [],
                        createdAt: new Date().toISOString()
                    };

                    // Generate Installment Plan
                    const plan = [];
                    const startDate = new Date(state.data.date);
                    const perInstallment = state.data.amount / state.data.installments;

                    for (let i = 0; i < state.data.installments; i++) {
                        const d = new Date(startDate);
                        d.setMonth(d.getMonth() + i);
                        plan.push({
                            id: crypto.randomUUID(),
                            installmentNumber: i + 1,
                            date: d.toISOString().slice(0, 10),
                            amount: perInstallment,
                            isPaid: false
                        });
                    }
                    newPayment.installmentPlan = plan;

                    await Payment.create(newPayment);

                    await bot.sendMessage(chatId, `✅ <b>Ödeme Eklendi!</b>\n\n📝 ${newPayment.title}\n💰 ${newPayment.amount} TL\n🏦 ${newPayment.bank}\n📂 ${newPayment.category}\n📅 ${newPayment.date}\n🔢 ${newPayment.installments} Taksit`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
                    
                    // Ask for continuity
                    state.step = 'CONTINUE_CHECK';
                    const continueKeyboard = {
                        keyboard: [['Evet', 'Hayır']],
                        resize_keyboard: true,
                        one_time_keyboard: true
                    };
                    await bot.sendMessage(chatId, '➕ Başka bir ödeme eklemek ister misiniz?', { reply_markup: continueKeyboard });
                    break;

                case 'CONTINUE_CHECK':
                    if (textLower === 'evet' || textLower === 'yes') {
                        // Reset state for new payment
                        botStates[chatId] = { step: 'TITLE', data: {} };
                        await bot.sendMessage(chatId, '🆕 <b>Yeni Ödeme</b>\n\nÖdemenin başlığı/açıklaması nedir?', { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
                    } else {
                        // Finish
                        delete botStates[chatId];
                        await bot.sendMessage(chatId, '👍 İşlem tamamlandı. Menüye dönüldü.', { reply_markup: { remove_keyboard: true } });
                    }
                    break;
            }
        } catch (error) {
            console.error('Bot Conversation Error:', error);
            await bot.sendMessage(chatId, '⚠️ Bir hata oluştu. İşlem iptal edildi.', { reply_markup: { remove_keyboard: true } });
            delete botStates[chatId];
        }
        return; // Stop processing other commands
    }

    // --- COMMANDS ---

    if (textLower === '/iptal' || textLower === 'iptal') {
         if (botStates[chatId]) {
             delete botStates[chatId];
             await bot.sendMessage(chatId, '🚫 İşlem iptal edildi.');
         }
         return;
    }

    if (textLower === '/ekle' || textLower === 'ekle' || textLower === 'yeni ödeme' || textLower === '/yeni') {
        const user = await User.findOne({ telegramChatId: chatId.toString() });
        if (!user) {
            await bot.sendMessage(chatId, '❌ Hesabınız bağlı değil.');
            return;
        }

        botStates[chatId] = { step: 'TITLE', data: {} };
        await bot.sendMessage(chatId, '🆕 <b>Yeni Ödeme Ekleme</b>\n\nÖdemenin başlığı/açıklaması nedir? (İptal için "iptal" yazın)', { parse_mode: 'HTML' });
        return;
    }

    if (textLower === 'ödemelerim' || textLower === 'payments') {
        try {
          const user = await User.findOne({ telegramChatId: chatId.toString() });
          
          if (!user) {
            await bot.sendMessage(chatId, '❌ Bu Telegram hesabı ile eşleşmiş bir kullanıcı bulunamadı.');
            return;
          }

          // Fetch unpaid installments
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

          const totalAmount = upcomingPayments.reduce((sum, p) => sum + p.amount, 0);
          
          let messageText = `📋 <b>Ödeme Listesi</b>\n\nToplam <b>${upcomingPayments.length}</b> adet ödenmemiş borcunuz var.\n\n`;
          const inlineKeyboard = [];

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
              reply_markup: {
                  inline_keyboard: inlineKeyboard
              }
          });

        } catch (error) {
          console.error('Telegram Message Handler Error:', error);
          await bot.sendMessage(chatId, '⚠️ Bir hata oluştu.');
        }
    }
});

// 6. CALLBACK QUERY (BUTON TIKLAMALARI)
bot.on('callback_query', async (query) => {
  const { data, message, id } = query;
  const parts = data.split(':');
  
  if (parts.length < 3) return;

  const action = parts[0];
  const paymentId = parts[1];
  const date = parts.slice(2).join(':');

  if (action === 'PAY') {
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
            reply_markup: { inline_keyboard: newKeyboard }
          });
        } else {
            await bot.answerCallbackQuery(id, { text: 'Bu ödeme zaten yapılmış veya bulunamadı.' });
        }
      }
    } catch (error) {
      console.error('Callback Error:', error);
    }
  }
});

// 7. HATIRLATICI (GÜNLÜK KONTROL)
const checkAndSendReminders = async () => {
  try {
    const allSettings = await Settings.find({ 
      'telegram.notificationsEnabled': true,
      'telegram.chatId': { $exists: true, $ne: null }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const setting of allSettings) {
      const { telegram, userId } = setting;
      if (!telegram?.botToken || !telegram?.chatId) continue;

      const payments = await Payment.find({ userId });
      
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
        const lastNotified = setting.lastTelegramNotification;
        const todayStr = today.toISOString().split('T')[0];
        
        if (lastNotified === todayStr) continue;

        const totalAmount = upcomingPayments.reduce((sum, p) => sum + p.amount, 0);
        
        let messageText = `📢 <b>Ödeme Hatırlatıcı</b>\n\nYaklaşan <b>${upcomingPayments.length}</b> adet ödemeniz var (Son 3 gün).\n\n`;
        const inlineKeyboard = [];

        upcomingPayments.slice(0, 10).forEach((p) => {
            const dateStr = new Date(p.date).toLocaleDateString('tr-TR');
            const diffDays = Math.ceil((new Date(p.date) - today) / (1000 * 60 * 60 * 24));
            let dayText = diffDays === 0 ? ' (BUGÜN)' : diffDays === 1 ? ' (Yarın)' : ` (${diffDays} gün kaldı)`;

            messageText += `▪️ <b>${p.paymentTitle}</b> - ${p.amount.toLocaleString('tr-TR')} TL - ${dateStr}${dayText}\n`;

            inlineKeyboard.push([{
                text: `✅ Öde: ${p.paymentTitle}`,
                callback_data: `PAY:${p.paymentId}:${p.date}`
            }]);
        });

        if (upcomingPayments.length > 10) messageText += `\n<i>...ve ${upcomingPayments.length - 10} diğer ödeme.</i>`;

        messageText += `\nToplam: <b>${totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</b>`;

        await bot.sendMessage(telegram.chatId, messageText, { 
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
        
        setting.lastTelegramNotification = todayStr;
        await setting.save();
      }
    }
  } catch (error) {
    console.error('Reminder Error:', error);
  }
};

// Cron Job (09:00, 12:00, 14:00)
schedule.scheduleJob('0 9,12,14 * * *', checkAndSendReminders);

// Health Check Server (Opsiyonel)
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running\n');
}).listen(process.env.PORT || 3000);

console.log('🤖 Bot started...');
