const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const schedule = require('node-schedule');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
require('dotenv').config();

// --- 1. CONFIGURATION ---
const mongoURI = process.env.MONGO_URI || 'mongodb+srv://yehsqn:yehsan1907efe42pbag10kdb17@cluster0.cbct0mv.mongodb.net/OdemeTakipDB?retryWrites=true&w=majority';
const token = process.env.TELEGRAM_BOT_TOKEN || '8329470679:AAFgx7WOzZhe8wI46ytq1VfFPm2u91O-S_0';
const emailUser = process.env.EMAIL_USER || 'yehsanefe20@gmail.com';
const emailPass = process.env.EMAIL_PASS || 'xpvn sqnt pvan tgon'; // Uygulama şifresi

// --- 2. MONGOOSE SCHEMAS ---
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  telegramChatId: String,
  pairingCode: String,
  pairingCodeExpiresAt: Date,
  pin: String,
  incomeExpensePassword: { type: String },
  resetIncomePasswordToken: String,
  resetIncomePasswordExpires: Date,
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
    botToken: { type: String },
    chatId: String,
    notificationsEnabled: { type: Boolean, default: true }
  },
  banks: { type: Array, default: [] },
  notificationDays: { type: Number, default: 3 },
  lastTelegramNotification: String
});

// Daily Income/Expense Schema
const DailyIncomeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    cash: { type: Number, default: 0 },
    cc: { type: Number, default: 0 },
    salary: { type: Number, default: 0 },
    insurance: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
    expenses: [{
      id: String,
      description: String,
      amount: Number,
      category: String,
      method: String, // 'cash', 'cc'
      createdAt: { type: Date, default: Date.now }
    }]
  }, { collection: 'dailyincomes' });

const User = mongoose.model('User', UserSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const DailyIncome = mongoose.model('DailyIncome', DailyIncomeSchema);

// --- 3. BOT SETUP ---
const bot = new TelegramBot(token, { polling: true });
const botStates = {}; // Stores conversation state per chat

// --- 4. EMAIL TRANSPORTER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: emailUser,
      pass: emailPass
    }
});

// --- 5. DATABASE CONNECTION ---
mongoose.connect(mongoURI)
  .then(() => console.log("✅ MongoDB Bağlantısı Başarılı!"))
  .catch(err => console.error("❌ MongoDB Bağlantı Hatası:", err));

// --- 6. HELPER FUNCTIONS ---
function generateCaptcha() {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;
    return {
        question: `${num1} + ${num2} = ?`,
        answer: (num1 + num2).toString()
    };
}

function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

async function sendEmail(to, subject, text) {
    const mailOptions = {
        from: emailUser,
        to: to,
        subject: subject,
        text: text
    };
    return transporter.sendMail(mailOptions);
}

// --- 7. BOT LOGIC ---

// Command: /start
bot.onText(/\/start (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1];

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

            // Update Settings
            const settings = await Settings.findOne({ userId: user._id });
            if (settings) {
                settings.telegram.chatId = chatId.toString();
                await settings.save();
            } else {
                await Settings.create({
                    userId: user._id,
                    telegram: { chatId: chatId.toString(), notificationsEnabled: true }
                });
            }

            await bot.sendMessage(chatId, '✅ Hesabınız başarıyla eşleştirildi! Artık bildirimleri buradan alacaksınız.\n\nKomutlar:\n/gelirgider - Gelir/Gider Yönetimi\n/sifremiunuttum - Şifre Sıfırlama');
        } else {
            await bot.sendMessage(chatId, '❌ Geçersiz veya süresi dolmuş eşleştirme kodu.');
        }
    } catch (error) {
        console.error('Pairing Error:', error);
        await bot.sendMessage(chatId, '⚠️ Bir hata oluştu.');
    }
});

bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '👋 Merhaba! Bu bot Ödeme Takip Sistemi ile entegre çalışır.\n\nEğer hesabınızı eşleştirmek istiyorsanız masaüstü uygulamasından aldığınız QR kodu veya bağlantıyı kullanın.\n\nMevcut Komutlar:\n/gelirgider - Gelir/Gider Ekleme ve Raporlar\n/sifremiunuttum - Şifre Sıfırlama');
});

// Command: /sifremiunuttum
bot.onText(/\/sifremiunuttum/, async (msg) => {
    const chatId = msg.chat.id;
    botStates[chatId] = { step: 'FORGOT_EMAIL', data: {} };
    await bot.sendMessage(chatId, '🔒 Şifre sıfırlama işlemi başlatıldı.\nLütfen sisteme kayıtlı <b>E-posta adresinizi</b> yazın:', { parse_mode: 'HTML' });
});

// Command: /gelirgider
bot.onText(/\/gelirgider/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Check if user is paired
    const user = await User.findOne({ telegramChatId: chatId.toString() });
    if (!user) {
        await bot.sendMessage(chatId, '⚠️ Bu özelliği kullanmak için önce hesabınızı eşleştirmeniz gerekmektedir.');
        return;
    }

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Gelir Ekle', callback_data: 'add_income' }, { text: '➖ Gider Ekle', callback_data: 'add_expense' }],
                [{ text: '📊 Günlük Rapor', callback_data: 'report_daily' }, { text: '📈 Aylık Rapor', callback_data: 'report_monthly' }]
            ]
        }
    };
    await bot.sendMessage(chatId, '💰 <b>Gelir/Gider Yönetimi</b>\nLütfen bir işlem seçin:', { parse_mode: 'HTML', ...opts });
});

// Handle Callback Queries (Menu Buttons)
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    // Check User
    const user = await User.findOne({ telegramChatId: chatId.toString() });
    if (!user) return;

    if (data === 'add_income') {
        botStates[chatId] = { step: 'INCOME_TYPE', data: { type: 'income' } };
        const opts = {
            reply_markup: {
                keyboard: [['Nakit', 'Kredi Kartı'], ['Maaş', 'Diğer'], ['İptal']],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        };
        await bot.sendMessage(chatId, '💵 Gelir türünü seçin:', opts);
    } else if (data === 'add_expense') {
        botStates[chatId] = { step: 'EXPENSE_AMOUNT', data: { type: 'expense' } };
        await bot.sendMessage(chatId, '💸 Gider tutarını girin (TL):');
    } else if (data === 'report_daily') {
        await sendReport(chatId, user._id, 'daily');
    } else if (data === 'report_monthly') {
        await sendReport(chatId, user._id, 'monthly');
    }

    // Answer callback to remove loading state
    bot.answerCallbackQuery(callbackQuery.id);
});

// Handle Text Messages (Conversation Flow)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) return; // Ignore commands

    if (botStates[chatId]) {
        const state = botStates[chatId];
        const user = await User.findOne({ telegramChatId: chatId.toString() });

        if (text.toLowerCase() === 'iptal') {
            delete botStates[chatId];
            await bot.sendMessage(chatId, '🚫 İşlem iptal edildi.', { reply_markup: { remove_keyboard: true } });
            return;
        }

        // --- FORGOT PASSWORD FLOW ---
        if (state.step === 'FORGOT_EMAIL') {
            const email = text.trim();
            const foundUser = await User.findOne({ email: new RegExp(`^${email}$`, 'i') });
            
            if (!foundUser) {
                // Security: Don't reveal if email exists or not explicitly, but for UX we usually say "not found" or generic.
                // User asked: "E-posta bilgisi verilse bile, e-posta adresi sistemde kayıtlı değilse herhangi bir bağlantı gönderilmemeli"
                // So we will just say "İşlem devam ediyor..." and then do nothing if not found, or say "Kayıt bulunamadı".
                // Let's be explicit for now as per "E-posta doğrulama süreci" request.
                await bot.sendMessage(chatId, '❌ Bu e-posta adresi ile kayıtlı kullanıcı bulunamadı.');
                delete botStates[chatId];
                return;
            }

            state.data.userId = foundUser._id;
            state.data.email = foundUser.email;
            
            // CAPTCHA
            const captcha = generateCaptcha();
            state.data.captchaAnswer = captcha.answer;
            state.step = 'FORGOT_CAPTCHA';
            
            await bot.sendMessage(chatId, `🤖 Güvenlik Doğrulaması:\n\n<b>${captcha.question}</b>\n\nİşlemin sonucu nedir?`, { parse_mode: 'HTML' });

        } else if (state.step === 'FORGOT_CAPTCHA') {
            if (text.trim() === state.data.captchaAnswer) {
                // Correct CAPTCHA
                try {
                    const code = Math.floor(100000 + Math.random() * 900000).toString();
                    
                    // Update User with Token
                    await User.findByIdAndUpdate(state.data.userId, {
                        resetIncomePasswordToken: code,
                        resetIncomePasswordExpires: Date.now() + 3600000 * 24 // 24 hours
                    });

                    // Send Email
                    const emailText = `Merhaba,\n\nŞifre sıfırlama talebiniz alındı.\n\nSıfırlama Kodu: ${code}\n\nBu kod 24 saat geçerlidir.`;
                    await sendEmail(state.data.email, 'Şifre Sıfırlama Kodu', emailText);

                    await bot.sendMessage(chatId, `✅ Doğrulama başarılı! Şifre sıfırlama kodu <b>${state.data.email}</b> adresine gönderildi.\nKod 24 saat geçerlidir.`, { parse_mode: 'HTML' });
                } catch (err) {
                    console.error('Email Send Error:', err);
                    await bot.sendMessage(chatId, '❌ E-posta gönderilirken bir hata oluştu.');
                }
                delete botStates[chatId];
            } else {
                await bot.sendMessage(chatId, '❌ Yanlış cevap. Lütfen tekrar deneyin (/sifremiunuttum).');
                delete botStates[chatId];
            }
        
        // --- INCOME FLOW ---
        } else if (state.step === 'INCOME_TYPE') {
            state.data.incomeType = text; // Nakit, Kredi Kartı, Maaş, Diğer
            state.step = 'INCOME_AMOUNT';
            await bot.sendMessage(chatId, '💰 Gelir tutarını girin (TL):', { reply_markup: { remove_keyboard: true } });

        } else if (state.step === 'INCOME_AMOUNT') {
            const amount = parseFloat(text.replace(',', '.'));
            if (isNaN(amount)) {
                await bot.sendMessage(chatId, '❌ Geçerli bir sayı girin:');
                return;
            }
            state.data.amount = amount;
            
            // Save Income
            await saveDailyTransaction(user._id, {
                type: 'income',
                category: state.data.incomeType, // Map selection to field
                amount: amount
            });
            
            await bot.sendMessage(chatId, `✅ <b>Gelir Eklendi!</b>\nTür: ${state.data.incomeType}\nTutar: ${amount} TL`, { parse_mode: 'HTML' });
            delete botStates[chatId];

        // --- EXPENSE FLOW ---
        } else if (state.step === 'EXPENSE_AMOUNT') {
            const amount = parseFloat(text.replace(',', '.'));
            if (isNaN(amount)) {
                await bot.sendMessage(chatId, '❌ Geçerli bir sayı girin:');
                return;
            }
            state.data.amount = amount;
            state.step = 'EXPENSE_CATEGORY';
            
            const opts = {
                reply_markup: {
                    keyboard: [['Market', 'Yemek', 'Ulaşım'], ['Fatura', 'Sağlık', 'Eğlence'], ['Diğer']],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            await bot.sendMessage(chatId, '📂 Kategori seçin:', opts);

        } else if (state.step === 'EXPENSE_CATEGORY') {
            state.data.category = text;
            state.step = 'EXPENSE_DESC';
            await bot.sendMessage(chatId, '📝 Açıklama girin (İsteğe bağlı, yoksa - koyun):', { reply_markup: { remove_keyboard: true } });

        } else if (state.step === 'EXPENSE_DESC') {
            state.data.description = text;
            state.step = 'EXPENSE_METHOD';
             const opts = {
                reply_markup: {
                    keyboard: [['Nakit', 'Kredi Kartı']],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            };
            await bot.sendMessage(chatId, '💳 Ödeme Yöntemi:', opts);

        } else if (state.step === 'EXPENSE_METHOD') {
            state.data.method = text === 'Kredi Kartı' ? 'cc' : 'cash';
            
            // Save Expense
            await saveDailyTransaction(user._id, {
                type: 'expense',
                amount: state.data.amount,
                category: state.data.category,
                description: state.data.description,
                method: state.data.method
            });

            await bot.sendMessage(chatId, `✅ <b>Gider Eklendi!</b>\nKategori: ${state.data.category}\nTutar: ${state.data.amount} TL\nÖdeme: ${text}`, { parse_mode: 'HTML' });
            delete botStates[chatId];
        }
    }
});

// --- 8. DATA HELPERS ---
async function saveDailyTransaction(userId, data) {
    const today = getTodayDateString();
    let daily = await DailyIncome.findOne({ userId, date: today });

    if (!daily) {
        daily = new DailyIncome({ userId, date: today });
    }

    if (data.type === 'income') {
        // Map simplified income types to schema fields
        // 'Nakit', 'Kredi Kartı', 'Maaş', 'Diğer'
        if (data.category === 'Nakit') daily.cash = (daily.cash || 0) + data.amount;
        else if (data.category === 'Kredi Kartı') daily.cc = (daily.cc || 0) + data.amount;
        else if (data.category === 'Maaş') daily.salary = (daily.salary || 0) + data.amount;
        else daily.other = (daily.other || 0) + data.amount;
    } else if (data.type === 'expense') {
        daily.expenses.push({
            id: crypto.randomUUID(),
            description: data.description,
            amount: data.amount,
            category: data.category,
            method: data.method,
            createdAt: new Date()
        });
    }

    await daily.save();
}

async function sendReport(chatId, userId, type) {
    const today = getTodayDateString();
    let text = '';

    if (type === 'daily') {
        const daily = await DailyIncome.findOne({ userId, date: today });
        if (!daily) {
            text = '📅 Bugün için henüz kayıt bulunmamaktadır.';
        } else {
            const totalIncome = (daily.cash || 0) + (daily.cc || 0) + (daily.salary || 0) + (daily.other || 0);
            const totalExpense = daily.expenses.reduce((sum, e) => sum + e.amount, 0);
            
            text = `📊 <b>GÜNLÜK RAPOR (${today})</b>\n\n` +
                   `➕ <b>Gelirler:</b>\n` +
                   `   Nakit: ${daily.cash || 0} TL\n` +
                   `   Maaş: ${daily.salary || 0} TL\n` +
                   `   Diğer: ${daily.other || 0} TL\n` +
                   `   <b>Toplam Gelir: ${totalIncome} TL</b>\n\n` +
                   `➖ <b>Giderler:</b>\n` +
                   `   Adet: ${daily.expenses.length}\n` +
                   `   <b>Toplam Gider: ${totalExpense} TL</b>\n\n` +
                   `💰 <b>Net Durum: ${totalIncome - totalExpense} TL</b>`;
        }
    } else if (type === 'monthly') {
        // Simple monthly summary (current month)
        const startOfMonth = today.substring(0, 7) + '-01';
        const docs = await DailyIncome.find({ 
            userId, 
            date: { $gte: startOfMonth } 
        });

        let totalIncome = 0;
        let totalExpense = 0;

        docs.forEach(doc => {
            totalIncome += (doc.cash || 0) + (doc.cc || 0) + (doc.salary || 0) + (doc.other || 0);
            totalExpense += doc.expenses.reduce((sum, e) => sum + e.amount, 0);
        });

        text = `📈 <b>AYLIK RAPOR (${today.substring(0, 7)})</b>\n\n` +
               `➕ Toplam Gelir: ${totalIncome} TL\n` +
               `➖ Toplam Gider: ${totalExpense} TL\n` +
               `💰 <b>Net Durum: ${totalIncome - totalExpense} TL</b>`;
    }

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

// --- 9. SCHEDULED JOBS ---
// Her ayın 1'inde saat 09:00'da aylık rapor gönder
schedule.scheduleJob('0 9 1 * *', async () => {
    const users = await User.find({ telegramChatId: { $exists: true } });
    for (const user of users) {
        try {
            await sendReport(user.telegramChatId, user._id, 'monthly');
        } catch (e) {
            console.error(`Auto report error for user ${user.email}:`, e);
        }
    }
});

console.log('🤖 Bot başarıyla başlatıldı!');
