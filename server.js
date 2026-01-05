const mongoose = require('mongoose');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://yehsqn:yehsan1907efe42pbag10kdb17@cluster0.cbct0mv.mongodb.net/OdemeTakipDB?retryWrites=true&w=majority';
// Using the same token from the main app for now, but in production, env vars should be used
const BOT_TOKEN = process.env.BOT_TOKEN || '8329470679:AAFgx7WOzZhe8wI46ytq1VfFPm2u91O-S_0'; 

// --- SCHEMAS (Simplified for backup purposes) ---
// We only need enough schema definition to read the collections.
// Using 'strict: false' allows us to pull everything without defining every field.

const UserSchema = new mongoose.Schema({}, { strict: false, collection: 'users' });
const PaymentSchema = new mongoose.Schema({}, { strict: false, collection: 'payments' });
const SettingsSchema = new mongoose.Schema({}, { strict: false, collection: 'settings' });
const DailyIncomeSchema = new mongoose.Schema({}, { strict: false, collection: 'dailyincomes' });

const User = mongoose.model('User', UserSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const DailyIncome = mongoose.model('DailyIncome', DailyIncomeSchema);

// --- TELEGRAM BOT ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false }); // No polling needed, just sending

// --- BACKUP FUNCTION ---
async function performBackupForUser(userId, chatId, email) {
    console.log(`[BACKUP] Starting backup for user: ${email} (${userId})`);
    
    try {
        // 1. Fetch Data
        const payments = await Payment.find({ userId }).lean();
        const dailyIncomes = await DailyIncome.find({ userId }).lean();
        const settings = await Settings.findOne({ userId }).lean();
        
        // 2. Prepare JSON
        const backupData = {
            date: new Date().toISOString(),
            user: { email, userId },
            payments,
            dailyIncomes,
            settings,
            source: 'Render Server Backup'
        };
        
        const jsonString = JSON.stringify(backupData, null, 2);
        
        // 3. Create Temporary File
        // Ensure /tmp exists (it does on Render/Linux)
        const tempDir = path.join(__dirname, 'temp_backups');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const fileName = `Yedek_${email}_${new Date().toISOString().slice(0, 10)}.json`;
        const filePath = path.join(tempDir, fileName);
        
        fs.writeFileSync(filePath, jsonString);
        console.log(`[BACKUP] File created: ${filePath}`);
        
        // 4. Send via Telegram
        await bot.sendDocument(chatId, filePath, {
            caption: `📦 <b>Otomatik Sunucu Yedeği</b>\n\n📅 Tarih: ${new Date().toLocaleString('tr-TR')}\n✅ Verileriniz sunucu tarafından otomatik olarak yedeklendi.`,
            parse_mode: 'HTML'
        });
        
        console.log(`[BACKUP] Sent to Telegram user ${chatId}`);
        
        // 5. Cleanup
        fs.unlinkSync(filePath);
        console.log(`[BACKUP] Temp file deleted.`);
        
    } catch (error) {
        console.error(`[BACKUP ERROR] Failed for user ${email}:`, error);
        // Optional: Send error message to user?
    }
}

// --- MAIN CRON JOB ---
// Runs every minute to check if any user scheduled a backup for "now"
async function checkAndRunBackups() {
    const now = new Date();
    // Format: "HH:mm" (e.g., "14:05")
    // Note: Render servers are usually UTC. We need to handle timezone.
    // The user sets time in their local time (TRT = UTC+3).
    // So if user says "23:00", it means 20:00 UTC.
    // However, to be safe, let's assume the stored time is what they see.
    // We should convert current server time to TRT to compare.
    
    const trtNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Istanbul' }));
    const currentHour = String(trtNow.getHours()).padStart(2, '0');
    const currentMinute = String(trtNow.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHour}:${currentMinute}`;
    
    console.log(`[CRON] Checking backups for time: ${currentTimeStr} (TRT)`);
    
    try {
        // Find users who have backup enabled AND match the current time
        // Note: 'backup.time' in DB is likely stored as "HH:mm" string
        
        // We need to join Users with Settings to get chatId
        // 1. Find all settings with enabled backup and matching time
        const settingsList = await Settings.find({
            'backup.enabled': true,
            'backup.time': currentTimeStr
        }).lean();
        
        if (settingsList.length > 0) {
            console.log(`[CRON] Found ${settingsList.length} users scheduled for backup.`);
            
            for (const setting of settingsList) {
                const user = await User.findById(setting.userId).lean();
                if (user && user.telegramChatId) {
                    await performBackupForUser(user._id, user.telegramChatId, user.email);
                } else {
                    console.log(`[CRON] User or Telegram ID missing for setting ${setting._id}`);
                }
            }
        }
        
    } catch (error) {
        console.error('[CRON] Error checking backups:', error);
    }
}

// --- INITIALIZATION ---
async function startServer() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');
        
        // Schedule the check every minute
        cron.schedule('* * * * *', checkAndRunBackups);
        console.log('⏰ Backup Scheduler Started (Running every minute)');
        
        // Keep process alive
        // On Render, we might need to listen on a port to pass health checks
        const http = require('http');
        const server = http.createServer((req, res) => {
            res.writeHead(200);
            res.end('Backup Server Running');
        });
        
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`HTTP Server listening on port ${PORT}`);
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
