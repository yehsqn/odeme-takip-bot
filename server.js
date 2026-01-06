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

    // Use /tmp for Render compatibility (ephemeral storage)
    const tempDir = '/tmp'; // Render writable path
    const fileName = `Yedek_${email}_${new Date().toISOString().slice(0, 10)}.json`;
    const filePath = path.join(tempDir, fileName);

    try {
        // Ensure connection is active
        if (mongoose.connection.readyState !== 1) {
            console.log('[DB] Reconnecting...');
            await mongoose.connect(MONGO_URI);
        }

        // 1. Create Write Stream
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

        // 2. Fetch Data & Write to Stream (Memory Efficient)
        // We write manually to construct a valid JSON object without loading everything into RAM

        writeStream.write('{\n');
        writeStream.write(`  "date": "${new Date().toISOString()}",\n`);
        writeStream.write(`  "user": { "email": "${email}", "userId": "${userId}" },\n`);
        writeStream.write(`  "source": "Render Server Backup",\n`);

        // Settings
        const settings = await Settings.findOne({ userId }).lean();
        writeStream.write(`  "settings": ${JSON.stringify(settings || {})},\n`);

        // Payments (Streaming array)
        writeStream.write(`  "payments": [`);
        const paymentCursor = Payment.find({ userId }).lean().cursor();
        let isFirstPayment = true;
        for await (const doc of paymentCursor) {
            if (!isFirstPayment) writeStream.write(',');
            writeStream.write(JSON.stringify(doc));
            isFirstPayment = false;
        }
        writeStream.write(`],\n`);

        // Daily Incomes (Streaming array)
        writeStream.write(`  "dailyIncomes": [`);
        const incomeCursor = DailyIncome.find({ userId }).lean().cursor();
        let isFirstIncome = true;
        for await (const doc of incomeCursor) {
            if (!isFirstIncome) writeStream.write(',');
            writeStream.write(JSON.stringify(doc));
            isFirstIncome = false;
        }
        writeStream.write(`]\n`);

        writeStream.write('}');
        writeStream.end();

        // Wait for stream to finish
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });

        console.log(`[BACKUP] File created via stream: ${filePath}`);

        // 3. Send via Telegram
        await bot.sendDocument(chatId, filePath, {
            caption: `ğŸ“¦ <b>Otomatik Sunucu YedeÄŸi</b>\n\nğŸ“… Tarih: ${new Date().toLocaleString('tr-TR')}\nâœ… Verileriniz gÃ¼venle yedeklendi.`,
            parse_mode: 'HTML'
        });

        console.log(`[BACKUP] Sent to Telegram user ${chatId}`);

        // 4. Cleanup
        fs.unlinkSync(filePath);
        console.log(`[BACKUP] Temp file deleted.`);

    } catch (error) {
        console.error(`[BACKUP ERROR] Failed for user ${email}:`, error);

        // Send Error Notification to User
        try {
            await bot.sendMessage(chatId, `âš ï¸ <b>Yedekleme BaÅŸarÄ±sÄ±z Oldu</b>\n\nSunucuda bir hata oluÅŸtu: <i>${error.message}</i>\nLÃ¼tfen daha sonra tekrar deneyin.`, { parse_mode: 'HTML' });
        } catch (sendErr) {
            console.error('[BACKUP] Failed to send error notification:', sendErr);
        }

        // Cleanup if exists
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

// --- MAIN CRON JOB ---
// Runs every minute to check if any user scheduled a backup for "now"
async function checkAndRunBackups() {
    const now = new Date();

    // Explicitly handle TRT Timezone (UTC+3)
    // Intl.DateTimeFormat is reliable across Node versions
    const formatter = new Intl.DateTimeFormat('tr-TR', {
        timeZone: 'Europe/Istanbul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    // Returns "HH:mm"
    const currentTimeStr = formatter.format(now);

    console.log(`[CRON] Checking backups for time: ${currentTimeStr} (TRT) [Server UTC: ${now.toISOString()}]`);

    try {
        // Find users who have backup enabled AND match the current time
        // Note: 'backup.time' in DB is likely stored as "HH:mm" string

        // We need to join Users with Settings to get chatId
        // 1. Find all settings with enabled backup and matching time
        // FIX: Also check for userIds stored as Strings and ObjectIds just in case
        const settingsList = await Settings.find({
            'backup.enabled': true,
            'backup.time': currentTimeStr
        }).lean();

        if (settingsList.length > 0) {
            console.log(`[CRON] Found ${settingsList.length} users scheduled for backup.`);

            for (const setting of settingsList) {
                // Find user by Mixed type (ObjectId or String)
                const user = await User.findOne({
                    $or: [
                        { _id: setting.userId },
                        { _id: new mongoose.Types.ObjectId(setting.userId) }
                    ]
                }).lean();

                if (user && user.telegramChatId) {
                    await performBackupForUser(setting.userId, user.telegramChatId, user.email);
                } else {
                    console.log(`[CRON] User or Telegram ID missing for setting ${setting._id} (User ID: ${setting.userId})`);
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
        console.log('âœ… Connected to MongoDB');

        // Run an immediate check on startup to verify everything works
        console.log('[STARTUP] Running initial backup check...');
        await checkAndRunBackups();

        // Schedule the check every minute
        cron.schedule('* * * * *', checkAndRunBackups);
        console.log('â° Backup Scheduler Started (Running every minute)');

        // Keep process alive with HTTP server for Render health checks
        const http = require('http');
        const server = http.createServer(async (req, res) => {
            if (req.url === '/health' || req.url === '/') {
                // Health check endpoint with debug info
                const now = new Date();
                const formatter = new Intl.DateTimeFormat('tr-TR', {
                    timeZone: 'Europe/Istanbul',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                const turkeyTime = formatter.format(now);

                // Check active backup schedules
                let activeBackups = [];
                try {
                    activeBackups = await Settings.find({ 'backup.enabled': true }).lean();
                } catch (e) {
                    console.error('Health check DB error:', e);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'running',
                    serverTime: now.toISOString(),
                    turkeyTime: turkeyTime,
                    dbConnected: mongoose.connection.readyState === 1,
                    activeBackupUsers: activeBackups.length,
                    scheduledTimes: activeBackups.map(s => ({ userId: s.userId, time: s.backup?.time }))
                }, null, 2));
            } else {
                res.writeHead(200);
                res.end('Backup Server Running');
            }
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`HTTP Server listening on port ${PORT}`);
            console.log(`Health check available at: http://localhost:${PORT}/health`);
        });

        // Self-ping every 10 minutes to prevent Render from sleeping (free tier)
        setInterval(() => {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            http.get(`${url}/health`, (res) => {
                console.log(`[KEEP-ALIVE] Ping successful at ${new Date().toISOString()}`);
            }).on('error', (e) => {
                console.log('[KEEP-ALIVE] Ping failed:', e.message);
            });
        }, 10 * 60 * 1000); // 10 minutes

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();


