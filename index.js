const path = require('path');
// Try local .env first, then parent dir (for local dev with root .env)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const http = require('http');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./db/turso');
const { initWebSocket } = require('./websocket');
const { initCron } = require('./cron');
const { initTelegramBot } = require('./bot');

const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const settingsRoutes = require('./routes/settings');
const incomeRoutes = require('./routes/income');
const exchangeRoutes = require('./routes/exchange');
const subscriptionRoutes = require('./routes/subscription');
const dbRoutes = require('./routes/db');
const backupRoutes = require('./routes/backup');
const aiRoutes = require('./routes/ai');
const notificationRoutes = require('./routes/notifications');
const telegramRoutes = require('./routes/telegram');
const customerProfileRoutes = require('./routes/customer-profile');

const app = express();
const PORT = process.env.PORT || process.env.API_PORT || 4000;

// ── Güvenlik Önlemleri ──────────────────────────────────────────
// Sunucu teknolojisini gizle
app.disable('x-powered-by');

// Temel Güvenlik HTTP Başlıkları (XSS, Clickjacking, MIME sniffing engelleme)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Middleware
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || /\.onrender\.com$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, true); // Mobile / desktop app compat
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Genel API Rate limiting (DoS önleme)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, error: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.' }
});
app.use('/api/', limiter);

// Giriş ve Şifre rotaları için Katı Rate Limiting (Brute-force / Şifre tahmin saldırılarını engelleme)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 20, // 15 dakikada en fazla 20 deneme
  message: { success: false, error: 'Çok fazla giriş denemesi yapıldı. Güvenliğiniz için lütfen 15 dakika bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Kök karşılama ve Uyanık tutma (Keep-Alive / Cron) rotası
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'PayPulse API ve Telegram Botu aktif',
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/verify-pin', authLimiter);
app.use('/api/auth/verify-income-password', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/income', incomeRoutes);
app.use('/api/exchange', exchangeRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/db', dbRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/customer-profile', customerProfileRoutes);

// Error Reporting Endpoint
app.post('/api/errors', async (req, res) => {
  try {
    const { error, info, userId } = req.body;
    console.error('[MOBILE CRASH]', error, info);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Endpoint bulunamadı' }));

// Güvenli Error handler (Veritabanı ve sunucu detaylarını dışarı sızdırmaz)
app.use((err, req, res, next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ success: false, error: 'İşlem sırasında bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
});

// HTTP sunucusu oluştur (WebSocket için http.Server gerekli)
const server = http.createServer(app);

// Connect DB → WebSocket → Cron → Start
initDb()
  .then(() => {
    console.log('[DB] Turso bağlandı ✓');

    // WebSocket sunucusunu başlat
    initWebSocket(server);

    // Cron zamanlayıcısını başlat
    initCron();

    // Telegram bot dinleyicisini başlat
    initTelegramBot();

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[API] Port ${PORT} zaten kullanımda, mevcut sunucu üzerinden devam ediliyor.`);
      } else {
        console.error('[API] Server error:', err.message);
      }
    });

    server.listen(PORT, () => {
      console.log(`[API] Server running on port ${PORT}`);
      console.log(`[WS]  WebSocket: ws://localhost:${PORT}/ws`);
    });
  })
  .catch(err => {
    console.error('[DB] Turso bağlantı hatası:', err.message);
    process.exit(1);
  });
