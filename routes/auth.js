const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { getBot } = require('../bot');
const { CUSTOMER_TYPE, PAYMENT_PERMISSIONS, PAYMENT_METHOD_LABELS } = require('../constants/customerTypes');
const { signToken, ensureSelfParam, invalidateUser } = require('../middleware/session');
const { sendMail } = require('../mailer');

// Yol parametresindeki kullanıcı kimliği oturum sahibi olmalı (/user/:id, /premium/:id, /pairing-status/:userId)
router.param('id', ensureSelfParam);
router.param('userId', ensureSelfParam);

/** Hash'li (bcrypt) veya eski düz metin sırrı doğrular */
const checkSecret = async (stored, plain) => {
  if (!stored || plain == null) return false;
  const v = String(stored);
  return v.startsWith('$2') ? bcrypt.compare(String(plain), v) : v === String(plain);
};

const genCode = () => String(crypto.randomInt(100000, 1000000)); // tahmin edilemez 6 haneli kod

/** Kullanıcı bilgisi + oturum anahtarı ile yanıt */
function sendSession(res, row, extra = {}) {
  res.json({ success: true, user: formatUser(row), token: signToken(row), ...extra });
}

async function sendVerificationEmail(email, code) {
  return sendMail({
    to: email,
    subject: '✉️ PayPulse — E-posta doğrulama kodun',
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#070b1a;color:#e6ecff;border-radius:16px;border:1px solid #1e2a55">
      <h2 style="color:#5ee7ff;margin-top:0">PayPulse'a hoş geldin!</h2>
      <p>Hesabını doğrulamak için bu kodu uygulamaya gir:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#fff;background:#0d1430;padding:16px;border-radius:12px;text-align:center">${code}</p>
      <p style="color:#8ea0d8;font-size:13px">Kod 30 dakika geçerlidir. Bu kaydı sen yapmadıysan e-postayı yok sayabilirsin.</p>
    </div>`,
  });
}

/** Doğrulama kodu üretir, kaydeder ve e-postayla gönderir */
async function issueVerificationCode(userId, email) {
  const code = genCode();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await db.execute({ sql: 'UPDATE users SET email_verify_code = ?, email_verify_expires_at = ? WHERE id = ?', args: [code, expiresAt, userId] });
  return sendVerificationEmail(email, code);
}

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// Helper: row → user response
function formatUser(row) {
  if (!row) return null;
  const isActive = row.is_premium && (!row.subscription_expiry || new Date(row.subscription_expiry) > new Date());
  const customerType = String(row.customer_type || CUSTOMER_TYPE.INDIVIDUAL).toUpperCase();
  return {
    id: row.id,
    email: row.email,
    telegramChatId: row.telegram_chat_id || '',
    hasPin: !!row.pin,
    hasIncomePassword: !!row.income_expense_password,
    isPremium: !!isActive,
    language: row.language || 'tr',
    pairingCode: row.pairing_code || '',
    subscriptionType: row.subscription_type || 'free',
    subscriptionStatus: row.subscription_status || 'active',
    subscriptionExpiry: row.subscription_expiry || null,
    aiAnalysisTokens: isActive ? 999 : (row.ai_analysis_tokens ?? 1),
    displayName: row.display_name || '',
    avatar: row.avatar || '',
    // Müşteri tipi bilgileri
    customerType,
    allowedPaymentMethods: (PAYMENT_PERMISSIONS[customerType] || []).map(m => ({
      key: m,
      label: PAYMENT_METHOD_LABELS[m] || m,
    })),
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email ve şifre gerekli' });

    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email.toLowerCase().trim()]
    });
    const user = result.rows[0];
    if (!user) return res.status(401).json({ success: false, error: 'E-posta veya şifre hatalı' });

    let isPasswordValid = false;
    // Bcrypt hash kontrolü
    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
      isPasswordValid = await bcrypt.compare(password, user.password);
    } else {
      // Legacy düz metin şifre kontrolü ve otomatik bcrypt'e yükseltme (re-hash)
      if (user.password === password) {
        isPasswordValid = true;
        try {
          const newHash = await bcrypt.hash(password, 10);
          await db.execute({
            sql: 'UPDATE users SET password = ? WHERE id = ?',
            args: [newHash, user.id]
          });
        } catch (hashErr) {
          console.error('[AUTH] Auto-rehash failed:', hashErr.message);
        }
      }
    }

    if (!isPasswordValid) return res.status(401).json({ success: false, error: 'E-posta veya şifre hatalı' });

    if (Number(user.email_verified) === 0) {
      const emailSent = await issueVerificationCode(user.id, user.email);
      return res.status(403).json({ success: false, needsVerification: true, email: user.email, emailSent, error: 'E-posta adresin henüz doğrulanmadı. Sana yeni bir kod gönderdik.' });
    }

    sendSession(res, user);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Giriş yapılırken bir hata oluştu.' });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const {
      email,
      password,
      customerType: rawType,
      // Bireysel alanlar
      firstName,
      lastName,
      // Kurumsal alanlar
      companyName,
    } = req.body;

    if (!email || !password) return res.status(400).json({ success: false, error: 'Email ve şifre gerekli' });
    if (password.length < 6) return res.status(400).json({ success: false, error: 'Şifre en az 6 karakter olmalıdır' });

    // Müşteri tipi doğrulaması
    const customerType = rawType === CUSTOMER_TYPE.CORPORATE ? CUSTOMER_TYPE.CORPORATE : CUSTOMER_TYPE.INDIVIDUAL;

    // Bireysel validasyon
    if (customerType === CUSTOMER_TYPE.INDIVIDUAL) {
      if (!firstName?.trim())  return res.status(400).json({ success: false, error: 'Ad gerekli' });
      if (!lastName?.trim())   return res.status(400).json({ success: false, error: 'Soyad gerekli' });
    }

    // Kurumsal validasyon
    if (customerType === CUSTOMER_TYPE.CORPORATE) {
      if (!companyName?.trim()) return res.status(400).json({ success: false, error: 'Şirket Unvanı gerekli' });
    }

    // Mevcut email kontrolü
    const existing = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email.toLowerCase().trim()]
    });
    if (existing.rows.length > 0) return res.status(409).json({ success: false, error: 'Bu email zaten kayıtlı' });

    const id = genId();
    const displayName = customerType === CUSTOMER_TYPE.INDIVIDUAL
      ? `${firstName} ${lastName}`.trim()
      : companyName.trim();

    // Güvenlik: Şifreyi bcrypt ile hashle
    const hashedPassword = await bcrypt.hash(password, 10);

    // Kullanıcı oluştur
    await db.execute({
      sql: 'INSERT INTO users (id, email, password, customer_type, display_name, email_verified) VALUES (?, ?, ?, ?, ?, 0)',
      args: [id, email.toLowerCase().trim(), hashedPassword, customerType, displayName]
    });

    // Profil oluştur
    const now = new Date().toISOString();
    if (customerType === CUSTOMER_TYPE.INDIVIDUAL) {
      await db.execute({
        sql: `INSERT INTO individual_profiles
                (user_id, first_name, last_name, updated_at)
              VALUES (?, ?, ?, ?)`,
        args: [id, firstName.trim(), lastName.trim(), now],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO corporate_profiles
                (user_id, company_name, updated_at)
              VALUES (?, ?, ?)`,
        args: [id, companyName.trim(), now],
      });
    }

    // Yeni oluşturulan kullanıcıyı getir ve formatla
    const emailSent = await issueVerificationCode(id, email.toLowerCase().trim());
    res.json({ success: true, needsVerification: true, email: email.toLowerCase().trim(), emailSent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/user/:id
router.get('/user/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [req.params.id]
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    res.json({ success: true, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/language
router.put('/language', async (req, res) => {
  try {
    const { userId, language } = req.body;
    await db.execute({
      sql: 'UPDATE users SET language = ? WHERE id = ?',
      args: [language, userId]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/premium/:id
router.get('/premium/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT is_premium, premium_expires_at, subscription_plan FROM users WHERE id = ?',
      args: [req.params.id]
    });
    const user = result.rows[0];
    if (!user) return res.json({ success: false, isPremium: false });

    const isActive = user.is_premium && (!user.premium_expires_at || new Date(user.premium_expires_at) > new Date());
    res.json({ success: true, isPremium: !!isActive, plan: isActive ? user.subscription_plan : 'free' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: JWT payload decode without signature verification (for debug & audience inspection)
function decodeJwtPayload(jwtToken) {
  try {
    if (!jwtToken || typeof jwtToken !== 'string') return null;
    const parts = jwtToken.split('.');
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const jsonStr = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// Helper: Collect all valid Google OAuth Client IDs (audiences)
function getAllowedGoogleAudiences() {
  const audiences = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
    process.env.VITE_GOOGLE_CLIENT_ID,
    '786955286273-agdl3o6n9h87iptl618knpd0k2e4mbrb.apps.googleusercontent.com',
    '214147261440-rmmia8qnauqmbo4pm382nejch7ddh99t.apps.googleusercontent.com'
  ];

  if (process.env.GOOGLE_IOS_CLIENT_ID) {
    audiences.push(process.env.GOOGLE_IOS_CLIENT_ID);
  }

  if (process.env.GOOGLE_AUDIENCES) {
    const extras = process.env.GOOGLE_AUDIENCES.split(',').map(s => s.trim()).filter(Boolean);
    audiences.push(...extras);
  }

  return Array.from(new Set(audiences.filter(Boolean)));
}

// POST /api/auth/google
router.post('/google', async (req, res) => {
  try {
    const { credential, accessToken } = req.body;
    if (!credential && !accessToken) return res.status(400).json({ success: false, error: 'Google token gerekli' });

    const validAudiences = getAllowedGoogleAudiences();
    let payload;
    if (credential) {
      // Native (Android/iOS) akış: ID token
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: validAudiences
        });
        payload = ticket.getPayload();
      } catch (verifyErr) {
        const decoded = decodeJwtPayload(credential);
        const tokenAud = decoded?.aud;
        const tokenIss = decoded?.iss;

        console.error('❌ [Google Auth] verifyIdToken doğrulama hatası:', verifyErr.message);
        console.error('🔍 [Google Auth Debug] Token payload.aud:', tokenAud);
        console.error('🔍 [Google Auth Debug] Token payload.iss:', tokenIss);
        console.error('🎯 [Google Auth Debug] Backend beklenen geçerli audience listesi:', validAudiences);

        return res.status(401).json({
          success: false,
          error: 'Google kimlik doğrulama hatası (Audience Uyuşmazlığı)',
          details: verifyErr.message,
          debug: {
            tokenAudience: tokenAud || 'Bilinmiyor',
            allowedAudiences: validAudiences
          }
        });
      }
    } else {
      // Web popup akışı: access token — Google'dan doğrula (aud geçerli audience listemizde olmalı)
      const info = await googleClient.getTokenInfo(accessToken);
      if (!validAudiences.includes(info.aud)) {
        console.error('❌ [Google Auth] Access token aud uyuşmazlığı:', info.aud, 'Beklenen:', validAudiences);
        throw new Error(`Token bu uygulama için üretilmemiş (aud: ${info.aud})`);
      }
      if (!info.email || info.email_verified === false) throw new Error('Google e-postası doğrulanmamış');
      payload = { sub: info.sub, email: info.email, name: '', picture: '' };
      try {
        const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (r.ok) {
          const p = await r.json();
          payload.name = p.name || '';
          payload.picture = p.picture || '';
        }
      } catch { /* profil bilgisi opsiyonel */ }
    }
    const email = payload.email.toLowerCase().trim();

    // Find or create user
    let result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    let user = result.rows[0];

    if (!user) {
      const id = genId();
      await db.execute({
        sql: `INSERT INTO users (id, email, password, google_id, display_name, avatar, customer_type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, email, 'google_oauth_' + Date.now(), payload.sub, payload.name || '', payload.picture || '', CUSTOMER_TYPE.INDIVIDUAL]
      });

      const now = new Date().toISOString();
      const nameParts = (payload.name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      try {
        await db.execute({
          sql: `INSERT OR IGNORE INTO individual_profiles (user_id, first_name, last_name, updated_at) VALUES (?, ?, ?, ?)`,
          args: [id, firstName, lastName, now]
        });
      } catch (profErr) {
        console.warn('Google user profile insert warning:', profErr.message);
      }

      result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
      user = result.rows[0];
    } else if (!user.google_id) {
      await db.execute({
        sql: "UPDATE users SET google_id = ?, display_name = COALESCE(NULLIF(display_name, ''), ?), avatar = COALESCE(NULLIF(avatar, ''), ?) WHERE id = ?",
        args: [payload.sub, payload.name || '', payload.picture || '', user.id]
      });
      result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [user.id] });
      user = result.rows[0];
    }

    if (Number(user.email_verified) === 0) {
      await db.execute({ sql: 'UPDATE users SET email_verified = 1, email_verify_code = NULL WHERE id = ?', args: [user.id] });
    }
    const formatted = formatUser(user);
    formatted.displayName = formatted.displayName || payload.name || '';
    formatted.avatar = formatted.avatar || payload.picture || '';

    res.json({ success: true, user: formatted, token: signToken(user) });
  } catch (err) {
    console.error('Google Auth Error:', err.message);
    res.status(401).json({ success: false, error: 'Google ile giriş doğrulanamadı. Lütfen tekrar deneyin.' });
  }
});

// POST /api/auth/set-pin
router.post('/set-pin', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });
    // pin boş/null → PIN kaldırılır; aksi halde tam 4 rakam olmalı
    if (pin && !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ success: false, error: 'PIN 4 haneli rakam olmalı.' });
    }
    const pinHash = pin ? await bcrypt.hash(String(pin), 10) : null;
    await db.execute({ sql: 'UPDATE users SET pin = ? WHERE id = ?', args: [pinHash, userId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/verify-pin
router.post('/verify-pin', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user || !user.pin || !pin) return res.status(401).json({ success: false, error: 'PIN hatalı.' });

    const stored = String(user.pin);
    const isHashed = stored.startsWith('$2');
    const ok = isHashed ? await bcrypt.compare(String(pin), stored) : stored === String(pin);
    if (!ok) return res.status(401).json({ success: false, error: 'PIN hatalı.' });

    // Eski düz metin PIN'leri ilk başarılı girişte hash'e çevir
    if (!isHashed) {
      const pinHash = await bcrypt.hash(String(pin), 10);
      await db.execute({ sql: 'UPDATE users SET pin = ? WHERE id = ?', args: [pinHash, user.id] });
    }
    res.json({
      success: true,
      user: formatUser(user),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/set-income-password
router.post('/set-income-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    if (user.income_expense_password && !(await checkSecret(user.income_expense_password, currentPassword))) {
      return res.status(401).json({ success: false, error: 'Mevcut şifre hatalı' });
    }
    await db.execute({
      sql: 'UPDATE users SET income_expense_password = ? WHERE id = ?',
      args: [newPassword ? await bcrypt.hash(String(newPassword), 10) : null, userId]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/verify-income-password
router.post('/verify-income-password', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    if (!(await checkSecret(user.income_expense_password, password))) {
      return res.status(401).json({ success: false, error: 'Şifre hatalı' });
    }
    // Eski düz metin şifreyi ilk doğru girişte hash'e çevir
    if (!String(user.income_expense_password).startsWith('$2')) {
      await db.execute({ sql: 'UPDATE users SET income_expense_password = ? WHERE id = ?', args: [await bcrypt.hash(String(password), 10), user.id] });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/reset-income-password
router.post('/reset-income-password', async (req, res) => {
  try {
    // Yalnızca oturum sahibinin kendi gelir-gider şifresi sıfırlanabilir (istekteki e-posta dikkate alınmaz)
    await db.execute({
      sql: 'UPDATE users SET income_expense_password = NULL WHERE id = ?',
      args: [req.authUserId]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', async (req, res) => {
  try {
    const { userId, currentPassword, newPassword } = req.body;
    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Eksik parametre' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Yeni şifre en az 6 karakter olmalıdır' });
    }

    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    let isMatch = false;
    if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
      isMatch = await bcrypt.compare(currentPassword, user.password);
    } else {
      isMatch = (user.password === currentPassword);
    }

    if (!isMatch) return res.status(401).json({ success: false, error: 'Mevcut şifre hatalı' });

    const hashedNew = await bcrypt.hash(newPassword, 10);
    await db.execute({ sql: 'UPDATE users SET password = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', args: [hashedNew, userId] });
    invalidateUser(userId);
    const fresh = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    res.json({ success: true, token: signToken(fresh.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Şifre güncellenirken hata oluştu' });
  }
});

// POST /api/auth/pairing-code
router.post('/pairing-code', async (req, res) => {
  try {
    const { userId } = req.body;
    const code = genCode(); // tahmin edilemez 6 haneli eşleştirme kodu
    await db.execute({ sql: 'UPDATE users SET pairing_code = ? WHERE id = ?', args: [code, userId] });
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/pairing-status/:userId
router.get('/pairing-status/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT telegram_chat_id FROM users WHERE id = ?',
      args: [req.params.userId]
    });
    const user = result.rows[0];
    if (user && user.telegram_chat_id) {
      return res.json({ success: true, chatId: user.telegram_chat_id });
    }
    res.json({ success: false });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/customer-type
router.put('/customer-type', async (req, res) => {
  try {
    const { userId, customerType } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });
    const validTypes = [CUSTOMER_TYPE.INDIVIDUAL, CUSTOMER_TYPE.CORPORATE];
    if (!validTypes.includes(customerType)) {
      return res.status(400).json({ success: false, error: 'Geçersiz müşteri tipi' });
    }
    await db.execute({
      sql: 'UPDATE users SET customer_type = ? WHERE id = ?',
      args: [customerType, userId]
    });
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    res.json({ success: true, user: formatUser(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/profile — Profil resmi (avatar) ve görünen isim güncelleme
router.put('/profile', async (req, res) => {
  try {
    const { userId, avatar, displayName } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const checkUser = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = checkUser.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const newAvatar = avatar !== undefined ? avatar : (user.avatar || '');
    const newDisplayName = displayName !== undefined ? displayName.trim() : (user.display_name || '');

    await db.execute({
      sql: 'UPDATE users SET avatar = ?, display_name = ? WHERE id = ?',
      args: [newAvatar, newDisplayName, userId]
    });

    const updatedResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    res.json({ success: true, user: formatUser(updatedResult.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── E-posta ile Doğrulama Kodu Gönderici ──────────────────────
async function sendResetEmail(email, code) {
  const resendKey = process.env.RESEND_API_KEY;

  // ── Resend (birincil yöntem) ──────────────────────────────────
  if (resendKey) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(resendKey);

      const { data, error } = await resend.emails.send({
        from: 'PayPulse <noreply@yehsqn.online>',
        to: [email],
        subject: '🔐 PayPulse - Şifre Sıfırlama Kodu',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 16px; border: 1px solid #334155;">
            <h2 style="color: #38bdf8; text-align: center; margin-top: 0;">PayPulse</h2>
            <p style="font-size: 15px; color: #cbd5e1; text-align: center;">Hesabınızın şifresini yenilemek için doğrulama kodunuz:</p>
            <div style="background: #1e293b; padding: 18px; border-radius: 12px; text-align: center; margin: 24px 0; border: 1px dashed #38bdf8;">
              <span style="font-size: 34px; font-weight: bold; letter-spacing: 8px; color: #38bdf8;">${code}</span>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; line-height: 1.5;">
              Bu kod <b>10 dakika</b> süreyle geçerlidir.<br/>Eğer bu işlemi siz talep etmediyseniz lütfen bu e-postayı dikkate almayın.
            </p>
          </div>
        `,
      });

      if (error) {
        console.error('[AUTH] Resend e-posta hatası:', error);
        return false;
      }

      console.log(`[AUTH] Şifre sıfırlama kodu ${email} adresine Resend ile gönderildi. ID: ${data?.id}`);
      return true;
    } catch (err) {
      console.error('[AUTH] Resend SDK hatası:', err.message);
      return false;
    }
  }

  // ── Nodemailer / SMTP (yedek yöntem) ─────────────────────────
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

  if (smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      await transporter.sendMail({
        from: `"PayPulse Ödeme Takip" <${smtpUser}>`,
        to: email,
        subject: '🔐 PayPulse - Şifre Sıfırlama Kodu',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 16px; border: 1px solid #334155;">
            <h2 style="color: #38bdf8; text-align: center; margin-top: 0;">PayPulse</h2>
            <p style="font-size: 15px; color: #cbd5e1; text-align: center;">Hesabınızın şifresini yenilemek için doğrulama kodunuz:</p>
            <div style="background: #1e293b; padding: 18px; border-radius: 12px; text-align: center; margin: 24px 0; border: 1px dashed #38bdf8;">
              <span style="font-size: 34px; font-weight: bold; letter-spacing: 8px; color: #38bdf8;">${code}</span>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; line-height: 1.5;">
              Bu kod <b>10 dakika</b> süreyle geçerlidir.<br/>Eğer bu işlemi siz talep etmediyseniz lütfen bu e-postayı dikkate almayın.
            </p>
          </div>
        `,
      });
      console.log(`[AUTH] Şifre sıfırlama kodu ${email} adresine SMTP ile gönderildi.`);
      return true;
    } catch (err) {
      console.error('[AUTH] SMTP e-posta hatası:', err.message);
      return false;
    }
  }

  // ── Yapılandırma yok — sadece log ────────────────────────────
  console.log(`--------------------------------------------------`);
  console.log(`[PASSWORD RESET - E-POSTA KONFİGÜRASYONU EKSİK]`);
  console.log(`Hedef E-Posta : ${email}`);
  console.log(`Doğrulama Kodu: ${code}`);
  console.log(`Not: .env dosyasına RESEND_API_KEY veya SMTP_USER/SMTP_PASS ekleyiniz.`);
  console.log(`--------------------------------------------------`);
  return false;
}


// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'E-posta adresi gerekli' });

    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, email, telegram_chat_id FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    const user = result.rows[0];

    if (!user) {
      // Hesabın varlığını ele vermemek için aynı yanıt
      return res.json({ success: true, emailSent: true, message: 'Bu e-postaya kayıtlı bir hesap varsa doğrulama kodu gönderildi.' });
    }

    // 6 haneli kod üret ve 10 dk geçerlilik ver
    const code = genCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.execute({
      sql: 'UPDATE users SET reset_password_code = ?, reset_password_expires_at = ? WHERE id = ?',
      args: [code, expiresAt, user.id]
    });

    // E-posta gönderimi
    const emailSent = await sendResetEmail(user.email, code);

    // Eğer bağlı bir Telegram varsa oraya da opsiyonel bildirim gönder (kullanıcı kolaylığı)
    try {
      const b = getBot();
      if (b && user.telegram_chat_id) {
        await b.sendMessage(
          user.telegram_chat_id,
          `🔐 <b>PayPulse Şifre Sıfırlama</b>\n\nDoğrulama kodunuz: <code>${code}</code>\n\nKodunuz e-posta adresinize de gönderildi (10 dk geçerlidir).`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (tgErr) {
      // Telegram hatası e-posta akışını etkilemesin
    }

    if (!emailSent) {
      return res.status(500).json({ success: false, error: 'E-posta gönderilemedi. Sunucu loglarını kontrol edin.' });
    }

    res.json({
      success: true,
      emailSent,
      message: 'Doğrulama kodu e-posta adresinize gönderildi.'
    });
  } catch (err) {
    console.error('Forgot Password Error:', err.message);
    res.status(500).json({ success: false, error: 'İşlem başarısız: ' + err.message });
  }
});

// POST /api/auth/verify-reset-code
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'E-posta ve kod gerekli' });

    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, reset_password_code, reset_password_expires_at FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ success: false, error: 'Girdiğiniz doğrulama kodu hatalı.' });
    }

    if (!user.reset_password_code || user.reset_password_code !== code.trim()) {
      return res.status(400).json({ success: false, error: 'Girdiğiniz doğrulama kodu hatalı.' });
    }

    if (new Date() > new Date(user.reset_password_expires_at)) {
      return res.status(400).json({ success: false, error: 'Doğrulama kodunun süresi dolmuş. Lütfen yeni kod isteyin.' });
    }

    res.json({ success: true, message: 'Kod doğrulandı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ success: false, error: 'Tüm alanları doldurun.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, reset_password_code, reset_password_expires_at FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ success: false, error: 'Girdiğiniz doğrulama kodu hatalı.' });
    }

    if (!user.reset_password_code || user.reset_password_code !== code.trim()) {
      return res.status(400).json({ success: false, error: 'Geçersiz veya süresi dolmuş kod.' });
    }

    if (new Date() > new Date(user.reset_password_expires_at)) {
      return res.status(400).json({ success: false, error: 'Kodun süresi dolmuş.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password = ?, reset_password_code = NULL, reset_password_expires_at = NULL, email_verified = 1, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?',
      args: [hashedPassword, user.id]
    });
    invalidateUser(user.id);

    res.json({ success: true, message: 'Şifreniz başarıyla yenilendi! Yeni şifrenizle giriş yapabilirsiniz.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Şifre sıfırlanamadı: ' + err.message });
  }
});

// POST /api/auth/verify-email — kayıttan sonra gelen 6 haneli kod
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ success: false, error: 'E-posta ve kod gerekli' });
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email).toLowerCase().trim()] });
    const user = r.rows[0];
    if (!user || !user.email_verify_code || user.email_verify_code !== String(code).trim()) {
      return res.status(400).json({ success: false, error: 'Doğrulama kodu hatalı.' });
    }
    if (new Date() > new Date(user.email_verify_expires_at)) {
      return res.status(400).json({ success: false, error: 'Kodun süresi dolmuş. Yeni kod iste.' });
    }
    await db.execute({ sql: 'UPDATE users SET email_verified = 1, email_verify_code = NULL, email_verify_expires_at = NULL WHERE id = ?', args: [user.id] });
    invalidateUser(user.id);
    const fresh = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [user.id] });
    sendSession(res, fresh.rows[0]);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Doğrulama yapılamadı.' });
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ success: false, error: 'E-posta gerekli' });
    const r = await db.execute({ sql: 'SELECT id, email, email_verified FROM users WHERE email = ?', args: [email] });
    const user = r.rows[0];
    let emailSent = true;
    if (user && Number(user.email_verified) === 0) emailSent = await issueVerificationCode(user.id, user.email);
    res.json({ success: true, emailSent, message: 'Doğrulama kodu e-posta adresine gönderildi.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kod gönderilemedi.' });
  }
});

// POST /api/auth/delete-account — hesabı ve tüm verileri kalıcı olarak siler
router.post('/delete-account', async (req, res) => {
  try {
    const userId = req.authUserId;
    const { password, confirmText } = req.body || {};
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] });
    const user = r.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Hesap bulunamadı' });

    const isGoogleOnly = !user.password || String(user.password).startsWith('google_oauth_');
    if (isGoogleOnly) {
      if (String(confirmText || '').trim().toUpperCase() !== 'SİL' && String(confirmText || '').trim().toUpperCase() !== 'SIL') {
        return res.status(400).json({ success: false, error: 'Onaylamak için "SİL" yaz.' });
      }
    } else {
      const ok = String(user.password).startsWith('$2')
        ? await bcrypt.compare(String(password || ''), user.password)
        : user.password === password;
      if (!ok) return res.status(401).json({ success: false, error: 'Şifre hatalı' });
    }

    await db.batch([
      { sql: 'DELETE FROM payments WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM settings WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM daily_incomes WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM notifications WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM individual_profiles WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM corporate_profiles WHERE user_id = ?', args: [userId] },
      { sql: 'UPDATE feedbacks SET user_id = NULL, user_email = NULL WHERE user_id = ?', args: [userId] },
      { sql: 'UPDATE app_errors SET user_id = NULL WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM users WHERE id = ?', args: [userId] },
    ], 'write');
    invalidateUser(userId);
    console.log(`[AUTH] Hesap silindi: ${userId}`);
    res.json({ success: true, message: 'Hesabın ve tüm verilerin kalıcı olarak silindi.' });
  } catch (err) {
    console.error('[AUTH] Hesap silme hatası:', err.message);
    res.status(500).json({ success: false, error: 'Hesap silinemedi. Lütfen tekrar dene.' });
  }
});

// POST /api/auth/telegram/unlink
router.post('/telegram/unlink', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    await db.execute({
      sql: 'UPDATE users SET telegram_chat_id = NULL, pairing_code = NULL WHERE id = ?',
      args: [userId]
    });

    res.json({ success: true, message: 'Telegram bağlantısı başarıyla kaldırıldı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
