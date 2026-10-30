const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { OAuth2Client } = require('google-auth-library');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { CUSTOMER_TYPE, PAYMENT_PERMISSIONS, PAYMENT_METHOD_LABELS } = require('../constants/customerTypes');
const { unsubscribeSig, signToken, ensureSelfParam, invalidateUser, revokeSession, liftExpiredBan, banMessage } = require('../middleware/session');
const { sendMail } = require('../mailer');

// Yol parametresindeki kullanıcı kimliği oturum sahibi olmalı (/user/:id, /premium/:id)
router.param('id', ensureSelfParam);
router.param('userId', ensureSelfParam);

/** Hash'li (bcrypt) veya eski düz metin sırrı doğrular */
const checkSecret = async (stored, plain) => {
  if (!stored || plain == null) return false;
  const v = String(stored);
  return v.startsWith('$2') ? bcrypt.compare(String(plain), v) : v === String(plain);
};

/** Google ile açılmış hesabın yer tutucu "şifresi" (google_oauth_<zaman>) — şifre olarak kabul edilmez */
const isGooglePlaceholder = (stored) => !stored || String(stored).startsWith('google_oauth_');

/** Hesap şifresini doğrular; Google yer tutucusu tahmin edilerek giriş yapılamaz */
const checkPassword = async (stored, plain) => {
  if (isGooglePlaceholder(stored) || typeof plain !== 'string' || !plain) return false;
  return checkSecret(stored, plain);
};

const RESET_MAX_ATTEMPTS = 5;
/** Hatalı sıfırlama kodu denemesini sayar; sınır aşılınca kod geçersiz olur (6 haneli kod kaba kuvvetle bulunamasın) */
async function recordResetFailure(user) {
  const attempts = (Number(user.reset_password_attempts) || 0) + 1;
  if (attempts >= RESET_MAX_ATTEMPTS) {
    await db.execute({ sql: 'UPDATE users SET reset_password_code = NULL, reset_password_expires_at = NULL, reset_password_attempts = 0 WHERE id = ?', args: [user.id] });
    return true;
  }
  await db.execute({ sql: 'UPDATE users SET reset_password_attempts = ? WHERE id = ?', args: [attempts, user.id] });
  return false;
}


// ── Hesap bazlı deneme sınırı (PIN ve gelir-gider şifresi) ─────────
// 5 hatalı denemede 5 dk kilit; 10 hatada oturum kapatılır, şifreyle yeniden giriş gerekir.
// IP sınırına ek olarak: saldırgan IP değiştirse de hesap kilitlenir.
const ATTEMPT_COLS = {
  pin: { count: 'pin_fail_count', until: 'pin_locked_until', label: 'PIN' },
  income: { count: 'income_fail_count', until: 'income_locked_until', label: 'Şifre' },
};
const LOCK_AFTER = 5, LOCK_MINUTES = 5, LOGOUT_AFTER = 10;

/** Kilitliyse yanıtı gönderir ve true döner */
function rejectIfLocked(res, user, kind) {
  const c = ATTEMPT_COLS[kind];
  const until = user[c.until] ? Date.parse(user[c.until]) : 0;
  if (until && until > Date.now()) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    res.status(429).json({ success: false, locked: true, retryAfter: secs, error: `Çok fazla hatalı deneme. ${Math.ceil(secs / 60)} dakika sonra tekrar dene.` });
    return true;
  }
  return false;
}

async function recordFailure(res, user, kind) {
  const c = ATTEMPT_COLS[kind];
  const count = (Number(user[c.count]) || 0) + 1;
  if (count >= LOGOUT_AFTER) {
    await db.execute({ sql: `UPDATE users SET ${c.count} = 0, ${c.until} = NULL, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?`, args: [user.id] });
    invalidateUser(user.id);
    return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: `Çok fazla hatalı ${c.label}. Güvenliğin için oturum kapatıldı, şifrenle yeniden giriş yap.` });
  }
  const lock = count % LOCK_AFTER === 0 ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
  await db.execute({ sql: `UPDATE users SET ${c.count} = ?, ${c.until} = ? WHERE id = ?`, args: [count, lock, user.id] });
  if (lock) return res.status(429).json({ success: false, locked: true, retryAfter: LOCK_MINUTES * 60, error: `Çok fazla hatalı deneme. ${LOCK_MINUTES} dakika sonra tekrar dene.` });
  const left = LOCK_AFTER - (count % LOCK_AFTER);
  return res.status(401).json({ success: false, attemptsLeft: left, error: `${c.label} hatalı. ${left} deneme hakkın kaldı.` });
}

async function resetFailures(user, kind) {
  const c = ATTEMPT_COLS[kind];
  if (Number(user[c.count]) || user[c.until]) {
    await db.execute({ sql: `UPDATE users SET ${c.count} = 0, ${c.until} = NULL WHERE id = ?`, args: [user.id] });
  }
}

const genCode = () => String(crypto.randomInt(100000, 1000000)); // tahmin edilemez 6 haneli kod

// Bağlantı adresi sabit: istek Host başlığından türetilmez (saldırgan e-postadaki bağlantıyı kendi alanına yönlendiremesin)
const API_BASE_URL = (process.env.API_BASE_URL || 'https://api.yehsqn.com').replace(/\/+$/, '');

async function sendVerificationEmail(email, code) {
  const verifyLink = `${API_BASE_URL}/api/auth/verify-link?email=${encodeURIComponent(email)}&code=${code}`;
  // Sade işlem e-postası: Gmail'de "Birincil" sekmeye düşmesi için süslemesiz
  return sendMail({
    to: email,
    subject: `PayPulse doğrulama kodun: ${code}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">
      <p>Merhaba,</p>
      <p>PayPulse hesabını doğrulamak için bu kodu uygulamaya gir:</p>
      <p style="font-size:26px;font-weight:bold;letter-spacing:4px;margin:16px 0">${code}</p>
      <p>Ya da bu bağlantıya tıkla: <a href="${verifyLink}">Hesabımı doğrula</a></p>
      <p>Kod 30 dakika geçerlidir. Bu kaydı sen yapmadıysan bu e-postayı yok sayabilirsin.</p>
      <p>PayPulse</p>
    </div>`,
    text: `Merhaba,\n\nPayPulse hesabını doğrulamak için bu kodu uygulamaya gir: ${code}\n\nYa da bu bağlantıyı aç: ${verifyLink}\n\nKod 30 dakika geçerlidir. Bu kaydı sen yapmadıysan bu e-postayı yok sayabilirsin.\n\nPayPulse`,
  });
}

/** Doğrulama kodu üretir, kaydeder ve e-postayla gönderir (deneme sayacı sıfırlanır) */
async function issueVerificationCode(userId, email) {
  const code = genCode();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await db.execute({ sql: 'UPDATE users SET email_verify_code = ?, email_verify_expires_at = ?, email_verify_attempts = 0 WHERE id = ?', args: [code, expiresAt, userId] });
  return sendVerificationEmail(email, code);
}

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

/** Cihaz ve tarayıcı tespiti */
async function createSessionRow(req, userId) {
  const sid = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const ua = req?.headers ? (req.headers['user-agent'] || '') : '';
  const ip = req?.headers ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '') : '';

  let os = 'Bilinmeyen Cihaz';
  let browser = 'Tarayıcı';
  let deviceName = 'Web Oturumu';

  if (/android/i.test(ua)) {
    os = 'Android';
    deviceName = 'Android Cihaz';
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = 'iOS';
    deviceName = /ipad/i.test(ua) ? 'iPad' : 'iPhone';
  } else if (/windows/i.test(ua)) {
    os = 'Windows';
    deviceName = 'Windows PC';
  } else if (/macintosh|mac os x/i.test(ua)) {
    os = 'macOS';
    deviceName = 'Mac Bilgisayar';
  } else if (/linux/i.test(ua)) {
    os = 'Linux';
    deviceName = 'Linux Cihaz';
  }

  if (/capacitor/i.test(ua) || req?.headers?.['x-platform'] === 'capacitor') {
    browser = 'PayPulse Mobil';
    deviceName = `${os} Uygulaması`;
  } else if (/electron/i.test(ua)) {
    browser = 'PayPulse Masaüstü';
    deviceName = 'Masaüstü Uygulaması';
  } else if (/edg/i.test(ua)) {
    browser = 'Microsoft Edge';
  } else if (/chrome|crios/i.test(ua)) {
    browser = 'Google Chrome';
  } else if (/firefox|fxios/i.test(ua)) {
    browser = 'Mozilla Firefox';
  } else if (/safari/i.test(ua)) {
    browser = 'Apple Safari';
  }

  try {
    await db.execute({
      sql: `INSERT INTO user_sessions (id, user_id, device_name, os, browser, ip, last_active_at, created_at, is_revoked)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)`,
      args: [sid, userId, deviceName, os, browser, ip]
    });
  } catch (err) {
    console.error('[AUTH] Session insert error:', err.message);
    return null; // kayıt yoksa anahtar oturum kimliği taşımasın (aksi halde geçersiz sayılır)
  }

  return sid;
}

/** Kullanıcı bilgisi + oturum anahtarı ile yanıt */
async function sendSession(res, row, extra = {}, req = null) {
  let sid = null;
  if (req) {
    sid = await createSessionRow(req, row.id);
  }
  res.json({ success: true, user: formatUser(row), token: signToken(row, sid), sessionId: sid, ...extra });
}

// KVKK aydınlatma metni sürümü: metin değişince artırılır, kullanıcılardan yeniden onay istenir
const KVKK_VERSION = '2026-10-28';
const nowIso = () => new Date().toISOString();

/** Kayıt / ilk girişte verilen KVKK onayı ve isteğe bağlı duyuru e-postası izni */
async function saveConsents(userId, { kvkkAccepted, abroadConsent, emailUpdates }) {
  const at = nowIso();
  if (kvkkAccepted === true) {
    await db.execute({ sql: 'UPDATE users SET kvkk_accepted_at = ?, kvkk_version = ? WHERE id = ?', args: [at, KVKK_VERSION, userId] });
  }
  if (abroadConsent === true) {
    await db.execute({ sql: 'UPDATE users SET abroad_consent_at = ? WHERE id = ?', args: [at, userId] });
  }
  if (typeof emailUpdates === 'boolean') {
    await db.execute({ sql: 'UPDATE users SET email_updates_consent = ?, email_consent_at = ? WHERE id = ?', args: [emailUpdates ? 1 : 0, at, userId] });
  }
}

// Helper: row → user response
function formatUser(row) {
  if (!row) return null;
  const now = new Date();
  const hasExpiry = !!row.subscription_expiry;
  const expiryDate = hasExpiry ? new Date(row.subscription_expiry) : null;
  const isExpired = expiryDate ? expiryDate <= now : false;
  const isActive = Boolean(row.is_premium && (!expiryDate || !isExpired));
  const subType = row.subscription_type || row.subscription_plan || 'free';
  const isTrial = subType === 'trial';
  const trialExpired = !isActive && (isTrial || (hasExpiry && isExpired));
  const canStartTrial = !isActive && !hasExpiry && subType !== 'trial';
  const customerType = String(row.customer_type || CUSTOMER_TYPE.INDIVIDUAL).toUpperCase();
  const friendCode = row.friend_code || null; // rastgele kod /api/social/me ile atanır
  return {
    id: row.id,
    email: row.email,
    emailBackupEnabled: row.email_backup_enabled !== 0,
    hasPin: !!row.pin,
    hasIncomePassword: !!row.income_expense_password,
    isPremium: !!isActive,
    isTrial: !!(isActive && isTrial),
    trialExpired: !!trialExpired,
    canStartTrial: !!canStartTrial,
    language: row.language || 'tr',
    subscriptionType: isActive ? subType : (trialExpired ? 'expired_trial' : 'free'),
    subscriptionStatus: isActive ? (row.subscription_status || 'active') : (trialExpired ? 'expired' : 'free'),
    subscriptionExpiry: row.subscription_expiry || null,
    aiAnalysisTokens: isActive ? 999 : (row.ai_analysis_tokens ?? 1),
    displayName: row.display_name || '',
    createdAt: row.created_at || null,
    avatar: row.avatar || '',
    friendCode,
    // KVKK: güncel aydınlatma metni onaylanmış ve yurt dışı aktarım rızası verilmiş mi
    consentRequired: !(row.kvkk_accepted_at && row.kvkk_version === KVKK_VERSION && row.abroad_consent_at),
    emailUpdatesConsent: Number(row.email_updates_consent) === 1,
    isBanned: Number(row.is_banned) === 1 && !(row.banned_until && Date.parse(row.banned_until) <= Date.now()),
    banReason: row.ban_reason || null,
    bannedUntil: row.banned_until || null,
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

    // Bcrypt hash veya eski düz metin şifre (Google yer tutucusu asla kabul edilmez)
    const isPasswordValid = await checkPassword(user.password, password);
    if (isPasswordValid && !String(user.password).startsWith('$2')) {
      // Legacy düz metin şifreyi otomatik bcrypt'e yükselt (re-hash)
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

    if (!isPasswordValid) return res.status(401).json({ success: false, error: 'E-posta veya şifre hatalı' });

    if (Number(user.is_banned) === 1 && !(await liftExpiredBan(user))) {
      return res.status(403).json({
        success: false,
        code: 'USER_BANNED',
        isBanned: true,
        banReason: banMessage(user),
        bannedUntil: user.banned_until || null,
        error: 'Hesabınız askıya alınmıştır.'
      });
    }

    if (Number(user.email_verified) === 0) {
      const emailSent = await issueVerificationCode(user.id, user.email);
      return res.status(403).json({ success: false, needsVerification: true, email: user.email, emailSent, error: 'E-posta adresin henüz doğrulanmadı. Sana yeni bir kod gönderdik.' });
    }

    await sendSession(res, user, {}, req);
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
      kvkkAccepted,
      abroadConsent,
      emailUpdates,
    } = req.body;

    if (kvkkAccepted !== true || abroadConsent !== true) {
      return res.status(400).json({ success: false, error: 'Kayıt için aydınlatma metnini okuduğunu onaylaman ve yurt dışı aktarım iznini vermen gerekir.' });
    }
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

    // Kullanıcı oluştur (Yeni kayıtlara otomatik 3 günlük PRO Deneme tanımla)
    const trialExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `INSERT INTO users (id, email, password, customer_type, display_name, email_verified, is_premium, subscription_type, subscription_plan, subscription_status, subscription_expiry, premium_expires_at, ai_analysis_tokens)
            VALUES (?, ?, ?, ?, ?, 0, 1, 'trial', 'trial', 'active', ?, ?, 999)`,
      args: [id, email.toLowerCase().trim(), hashedPassword, customerType, displayName, trialExpiry, trialExpiry]
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

    await saveConsents(id, { kvkkAccepted, abroadConsent, emailUpdates: emailUpdates === true });

    // Yeni oluşturulan kullanıcıyı getir ve formatla
    const emailSent = await issueVerificationCode(id, email.toLowerCase().trim());
    res.json({ success: true, needsVerification: true, email: email.toLowerCase().trim(), emailSent });
  } catch (err) {
    console.error('[AUTH] Kayıt hatası:', err.message);
    res.status(500).json({ success: false, error: 'Kayıt sırasında bir hata oluştu.' });
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
    const { credential, accessToken, kvkkAccepted, abroadConsent, emailUpdates } = req.body;
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

        // Ayrıntılar yalnızca sunucu loguna; istemciye izin verilen istemci kimlikleri sızdırılmaz
        return res.status(401).json({
          success: false,
          error: 'Google kimlik doğrulama hatası (Audience Uyuşmazlığı)'
        });
      }
      // Doğrulanmamış Google e-postası başkasının hesabına bağlanamasın
      if (!payload?.email || payload.email_verified === false || payload.email_verified === 'false') {
        return res.status(401).json({ success: false, error: 'Google e-postası doğrulanmamış.' });
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
      const trialExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO users (id, email, password, google_id, display_name, avatar, customer_type, is_premium, subscription_type, subscription_plan, subscription_status, subscription_expiry, premium_expires_at, ai_analysis_tokens)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'trial', 'trial', 'active', ?, ?, 999)`,
        args: [id, email, 'google_oauth_' + crypto.randomBytes(16).toString('hex'), payload.sub, payload.name || '', payload.picture || '', CUSTOMER_TYPE.INDIVIDUAL, trialExpiry, trialExpiry]
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

      if (kvkkAccepted === true && abroadConsent === true) {
        await saveConsents(id, { kvkkAccepted, abroadConsent, emailUpdates: emailUpdates === true });
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

    if (Number(user.is_banned) === 1 && !(await liftExpiredBan(user))) {
      return res.status(403).json({
        success: false,
        code: 'USER_BANNED',
        isBanned: true,
        banReason: banMessage(user),
        bannedUntil: user.banned_until || null,
        error: 'Hesabınız askıya alınmıştır.'
      });
    }

    if (Number(user.email_verified) === 0) {
      // E-postası hiç doğrulanmamış hesap: şifresini bu e-postanın sahibi olmayan biri koymuş olabilir
      // (önceden kayıt olup sahibinin Google ile girmesini bekleme saldırısı). Gerçek sahip Google ile
      // kanıtladığı için o şifre ve açık oturumlar geçersiz kılınır; isterse "şifremi unuttum" ile yeni şifre koyar.
      await db.execute({
        sql: `UPDATE users SET email_verified = 1, email_verify_code = NULL,
                password = CASE WHEN password LIKE 'google_oauth_%' THEN password ELSE ? END,
                token_version = COALESCE(token_version, 0) + 1
              WHERE id = ?`,
        args: ['google_oauth_' + crypto.randomBytes(16).toString('hex'), user.id]
      });
      invalidateUser(user.id);
      user = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [user.id] })).rows[0];
    }
    const formatted = formatUser(user);
    formatted.displayName = formatted.displayName || payload.name || '';
    formatted.avatar = formatted.avatar || payload.picture || '';

    const sid = await createSessionRow(req, user.id);
    res.json({ success: true, user: formatted, token: signToken(user, sid), sessionId: sid });
  } catch (err) {
    console.error('Google Auth Error:', err.message);
    res.status(401).json({ success: false, error: 'Google ile giriş doğrulanamadı. Lütfen tekrar deneyin.' });
  }
});

// POST /api/auth/consent — KVKK aydınlatma onayı + yurt dışı aktarım rızası (Google ile girenler, metin güncellenince)
router.post('/consent', async (req, res) => {
  try {
    const { kvkkAccepted, abroadConsent, emailUpdates } = req.body || {};
    if (kvkkAccepted !== true || abroadConsent !== true) {
      return res.status(400).json({ success: false, error: 'Devam etmek için aydınlatma metnini onaylaman gerekir.' });
    }
    await saveConsents(req.authUserId, { kvkkAccepted, abroadConsent, emailUpdates: typeof emailUpdates === 'boolean' ? emailUpdates : undefined });
    const row = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.authUserId] })).rows[0];
    res.json({ success: true, user: formatUser(row) });
  } catch (err) {
    console.error('[AUTH] Onay kaydı hatası:', err.message);
    res.status(500).json({ success: false, error: 'Onay kaydedilemedi.' });
  }
});

// PUT /api/auth/email-preferences — duyuru e-postası iznini ver / geri al (İYS)
router.put('/email-preferences', async (req, res) => {
  try {
    if (typeof req.body?.emailUpdates !== 'boolean') return res.status(400).json({ success: false, error: 'Geçersiz tercih' });
    await saveConsents(req.authUserId, { emailUpdates: req.body.emailUpdates });
    res.json({ success: true, emailUpdatesConsent: req.body.emailUpdates });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Tercih kaydedilemedi.' });
  }
});

// PUT /api/auth/email-backup — gece e-posta yedeğini aç / kapat
router.put('/email-backup', async (req, res) => {
  try {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Geçersiz tercih' });
    await db.execute({ sql: 'UPDATE users SET email_backup_enabled = ? WHERE id = ?', args: [req.body.enabled ? 1 : 0, req.authUserId] });
    res.json({ success: true, emailBackupEnabled: req.body.enabled });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Tercih kaydedilemedi.' });
  }
});

// GET|POST /api/auth/unsubscribe?u=<id>&s=<imza> — e-postadaki abonelikten çıkma bağlantısı (POST: Gmail tek tık)
router.all('/unsubscribe', async (req, res) => {
  const page = (msg) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPulse</title><body style="font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="max-width:420px;padding:28px;border:1px solid #334155;border-radius:16px;text-align:center"><h2 style="color:#38bdf8;margin-top:0">PayPulse</h2><p>${msg}</p></div></body>`);
  try {
    const uid = String(req.query.u || '');
    const sig = String(req.query.s || '');
    const expected = unsubscribeSig(uid);
    if (!/^[a-f0-9]{24}$/.test(uid) || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(400) && page('Bağlantı geçersiz. Tercihini uygulamada Ayarlar → Bildirimler bölümünden değiştirebilirsin.');
    }
    if (req.query.type === 'backup') {
      await db.execute({ sql: 'UPDATE users SET email_backup_enabled = 0 WHERE id = ?', args: [uid] });
      return page('Yedek e-postaları kapatıldı. Dilersen uygulamada Ayarlar → Bildirimler bölümünden yeniden açabilirsin.');
    }
    await saveConsents(uid, { emailUpdates: false });
    page('Duyuru e-postalarından çıkarıldın. Artık sürüm ve duyuru e-postası almayacaksın.');
  } catch {
    res.status(500);
    page('Bir hata oluştu, lütfen daha sonra tekrar dene.');
  }
});

// POST /api/auth/set-pin
router.post('/set-pin', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });
    // pin boş/null → PIN kaldırılır; aksi halde en az 4, en fazla 32 karakter (harf/rakam/şifre) olmalı
    if (pin && (String(pin).length < 4 || String(pin).length > 32)) {
      return res.status(400).json({ success: false, error: 'PIN / Şifre en az 4, en fazla 32 karakter olmalıdır.' });
    }
    // Mevcut PIN varsa değiştirmek/kaldırmak için o PIN gerekir (kilitsiz bırakılan telefonda
    // başkası PIN'i değiştirip biyometriğe kendi parmak izini bağlayamasın). Deneme sınırı geçerli.
    const cur = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] })).rows[0];
    if (!cur) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    if (cur.pin) {
      if (rejectIfLocked(res, cur, 'pin')) return;
      if (!(await checkSecret(cur.pin, req.body.currentPin))) return recordFailure(res, cur, 'pin');
      await resetFailures(cur, 'pin');
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
    if (!user || !user.pin) return res.status(401).json({ success: false, error: 'PIN hatalı.' });
    if (rejectIfLocked(res, user, 'pin')) return;
    if (!pin || String(pin).length < 4 || String(pin).length > 32) return recordFailure(res, user, 'pin');

    const stored = String(user.pin);
    const isHashed = stored.startsWith('$2');
    const ok = isHashed ? await bcrypt.compare(String(pin), stored) : stored === String(pin);
    if (!ok) return recordFailure(res, user, 'pin');
    await resetFailures(user, 'pin');

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
    if (user.income_expense_password) {
      if (rejectIfLocked(res, user, 'income')) return;
      if (!(await checkSecret(user.income_expense_password, currentPassword))) return recordFailure(res, user, 'income');
      await resetFailures(user, 'income');
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
    if (rejectIfLocked(res, user, 'income')) return;
    if (!(await checkSecret(user.income_expense_password, password))) return recordFailure(res, user, 'income');
    await resetFailures(user, 'income');
    // Eski düz metin şifreyi ilk doğru girişte hash'e çevir
    if (!String(user.income_expense_password).startsWith('$2')) {
      await db.execute({ sql: 'UPDATE users SET income_expense_password = ? WHERE id = ?', args: [await bcrypt.hash(String(password), 10), user.id] });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Doğrulamasız gelir-gider şifresi sıfırlama ucu güvenlik nedeniyle kaldırıldı.

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

    const isMatch = await checkPassword(user.password, currentPassword);
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

    // Avatar yalnızca resim data URL'si veya https adresi olabilir (en fazla ~700 KB); ad en fazla 60 karakter
    if (avatar !== undefined && avatar !== '' && (typeof avatar !== 'string' || avatar.length > 700000
        || !/^(data:image\/(jpeg|png|webp|gif|svg\+xml)[;,]|https:\/\/)/i.test(avatar))) {
      return res.status(400).json({ success: false, error: 'Geçersiz profil resmi.' });
    }
    if (displayName !== undefined && typeof displayName !== 'string') {
      return res.status(400).json({ success: false, error: 'Geçersiz görünen ad.' });
    }
    const newAvatar = avatar !== undefined ? avatar : (user.avatar || '');
    const newDisplayName = displayName !== undefined ? displayName.trim().slice(0, 60) : (user.display_name || '');

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
  // Sade işlem e-postası: Gmail'de "Birincil" sekmeye düşmesi için süslemesiz
  return sendMail({
    to: email,
    subject: `PayPulse şifre sıfırlama kodun: ${code}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222">
      <p>Merhaba,</p>
      <p>PayPulse şifreni yenilemek için bu kodu uygulamaya gir:</p>
      <p style="font-size:26px;font-weight:bold;letter-spacing:4px;margin:16px 0">${code}</p>
      <p>Kod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.</p>
      <p>PayPulse</p>
    </div>`,
    text: `Merhaba,\n\nPayPulse şifreni yenilemek için bu kodu uygulamaya gir: ${code}\n\nKod 10 dakika geçerlidir. Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin; şifren değişmez.\n\nPayPulse`,
  });
}


// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'E-posta adresi gerekli' });

    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, email FROM users WHERE email = ?',
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
      sql: 'UPDATE users SET reset_password_code = ?, reset_password_expires_at = ?, reset_password_attempts = 0 WHERE id = ?',
      args: [code, expiresAt, user.id]
    });

    // E-posta gönderimi
    const emailSent = await sendResetEmail(user.email, code);

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
    res.status(500).json({ success: false, error: 'İşlem başarısız. Lütfen tekrar deneyin.' });
  }
});

// POST /api/auth/verify-reset-code
router.post('/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'E-posta ve kod gerekli' });

    const normalizedEmail = String(email).toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, reset_password_code, reset_password_expires_at, reset_password_attempts FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    const user = result.rows[0];

    if (!user || !user.reset_password_code) {
      return res.status(400).json({ success: false, error: 'Girdiğiniz doğrulama kodu hatalı.' });
    }

    if (user.reset_password_code !== String(code).trim()) {
      if (await recordResetFailure(user)) {
        return res.status(400).json({ success: false, codeExpired: true, error: 'Çok fazla hatalı deneme. Lütfen yeni kod isteyin.' });
      }
      return res.status(400).json({ success: false, error: 'Girdiğiniz doğrulama kodu hatalı.' });
    }

    if (new Date() > new Date(user.reset_password_expires_at)) {
      return res.status(400).json({ success: false, error: 'Doğrulama kodunun süresi dolmuş. Lütfen yeni kod isteyin.' });
    }

    res.json({ success: true, message: 'Kod doğrulandı.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Kod doğrulanamadı.' });
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

    const normalizedEmail = String(email).toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT id, reset_password_code, reset_password_expires_at, reset_password_attempts FROM users WHERE email = ?',
      args: [normalizedEmail]
    });
    const user = result.rows[0];

    if (!user || !user.reset_password_code) {
      return res.status(400).json({ success: false, error: 'Geçersiz veya süresi dolmuş kod.' });
    }

    if (user.reset_password_code !== String(code).trim()) {
      const expired = await recordResetFailure(user);
      return res.status(400).json({ success: false, codeExpired: expired || undefined, error: expired ? 'Çok fazla hatalı deneme. Lütfen yeni kod isteyin.' : 'Geçersiz veya süresi dolmuş kod.' });
    }

    if (new Date() > new Date(user.reset_password_expires_at)) {
      return res.status(400).json({ success: false, error: 'Kodun süresi dolmuş.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.execute({
      sql: 'UPDATE users SET password = ?, reset_password_code = NULL, reset_password_expires_at = NULL, reset_password_attempts = 0, email_verified = 1, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?',
      args: [hashedPassword, user.id]
    });
    invalidateUser(user.id);

    res.json({ success: true, message: 'Şifreniz başarıyla yenilendi! Yeni şifrenizle giriş yapabilirsiniz.' });
  } catch (err) {
    console.error('[AUTH] Reset password error:', err.message);
    res.status(500).json({ success: false, error: 'Şifre sıfırlanamadı. Lütfen tekrar deneyin.' });
  }
});

// POST /api/auth/verify-email — kayıttan sonra gelen 6 haneli kod
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ success: false, error: 'E-posta ve kod gerekli' });
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email).toLowerCase().trim()] });
    const user = r.rows[0];
    if (!user || !user.email_verify_code) {
      return res.status(400).json({ success: false, error: 'Doğrulama kodu hatalı.' });
    }
    if (user.email_verify_code !== String(code).trim()) {
      const attempts = (Number(user.email_verify_attempts) || 0) + 1;
      if (attempts >= 5) {
        await db.execute({ sql: 'UPDATE users SET email_verify_code = NULL, email_verify_attempts = 0 WHERE id = ?', args: [user.id] });
        return res.status(400).json({ success: false, codeExpired: true, error: 'Çok fazla hatalı deneme. Yeni bir kod iste.' });
      }
      await db.execute({ sql: 'UPDATE users SET email_verify_attempts = ? WHERE id = ?', args: [attempts, user.id] });
      return res.status(400).json({ success: false, error: 'Doğrulama kodu hatalı.' });
    }
    if (new Date() > new Date(user.email_verify_expires_at)) {
      return res.status(400).json({ success: false, error: 'Kodun süresi dolmuş. Yeni kod iste.' });
    }
    await db.execute({ sql: 'UPDATE users SET email_verified = 1, email_verify_code = NULL, email_verify_expires_at = NULL WHERE id = ?', args: [user.id] });
    invalidateUser(user.id);
    const fresh = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [user.id] });
    await sendSession(res, fresh.rows[0], {}, req);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Doğrulama yapılamadı.' });
  }
});

// GET /api/auth/verify-link — e-postadaki tek tıkla şık doğrulama sayfası
router.get('/verify-link', async (req, res) => {
  try {
    const { email, code } = req.query || {};
    if (!email || !code) {
      return res.status(400).send(renderVerificationHtml({ success: false, error: 'E-posta veya doğrulama kodu eksik.' }));
    }

    const r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [String(email).toLowerCase().trim()] });
    const user = r.rows[0];

    if (!user) {
      return res.status(404).send(renderVerificationHtml({ success: false, error: 'Kayıtlı kullanıcı bulunamadı.' }));
    }

    if (Number(user.email_verified) === 1) {
      return res.send(renderVerificationHtml({ success: true, message: 'E-posta adresiniz zaten doğrulanmış durumda!' }));
    }

    if (!user.email_verify_code) {
      return res.status(400).send(renderVerificationHtml({ success: false, error: 'Doğrulama kodu hatalı veya geçersiz.' }));
    }
    if (user.email_verify_code !== String(code).trim()) {
      // verify-email ile aynı sayaç: 5 hatalı denemede kod geçersiz olur (6 haneli kod kaba kuvvetle bulunamasın)
      const attempts = (Number(user.email_verify_attempts) || 0) + 1;
      if (attempts >= 5) {
        await db.execute({ sql: 'UPDATE users SET email_verify_code = NULL, email_verify_attempts = 0 WHERE id = ?', args: [user.id] });
        return res.status(400).send(renderVerificationHtml({ success: false, error: 'Çok fazla hatalı deneme. Lütfen uygulamadan yeni bir kod isteyin.' }));
      }
      await db.execute({ sql: 'UPDATE users SET email_verify_attempts = ? WHERE id = ?', args: [attempts, user.id] });
      return res.status(400).send(renderVerificationHtml({ success: false, error: 'Doğrulama kodu hatalı veya geçersiz.' }));
    }

    if (new Date() > new Date(user.email_verify_expires_at)) {
      return res.status(400).send(renderVerificationHtml({ success: false, error: 'Doğrulama kodunun 30 dakikalık süresi dolmuş. Lütfen uygulamadan yeni bir kod isteyin.' }));
    }

    await db.execute({ sql: 'UPDATE users SET email_verified = 1, email_verify_code = NULL, email_verify_expires_at = NULL WHERE id = ?', args: [user.id] });
    invalidateUser(user.id);

    return res.send(renderVerificationHtml({
      success: true,
      message: 'Hesabınız başarıyla aktifleştirildi. Artık PayPulse\'ı tüm özellikleriyle güvenle kullanabilirsiniz.'
    }));
  } catch (err) {
    return res.status(500).send(renderVerificationHtml({ success: false, error: 'Doğrulama sırasında bir hata oluştu. Lütfen tekrar deneyin.' }));
  }
});

function renderVerificationHtml({ success, error, message }) {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayPulse — ${success ? 'E-posta Doğrulandı' : 'Doğrulama Hatası'}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
    body {
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      background:radial-gradient(ellipse at 50% -20%, #1e1b4b 0%, #070b1a 60%, #030712 100%);
      color:#f8fafc;
      padding:24px;
    }
    .card {
      width:100%;
      max-width:440px;
      background:rgba(15, 23, 42, 0.75);
      border:1px solid ${success ? 'rgba(99, 102, 241, 0.3)' : 'rgba(239, 68, 68, 0.3)'};
      backdrop-filter:blur(24px);
      -webkit-backdrop-filter:blur(24px);
      border-radius:28px;
      padding:44px 32px;
      text-align:center;
      box-shadow:0 30px 60px -15px rgba(0, 0, 0, 0.8), 0 0 50px ${success ? 'rgba(99, 102, 241, 0.15)' : 'rgba(239, 68, 68, 0.15)'};
      animation:pop 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes pop {
      0% { opacity:0; transform:scale(0.92) translateY(20px); }
      100% { opacity:1; transform:scale(1) translateY(0); }
    }
    .badge {
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:6px 14px;
      border-radius:999px;
      background:${success ? 'rgba(99, 102, 241, 0.15)' : 'rgba(239, 68, 68, 0.15)'};
      border:1px solid ${success ? 'rgba(99, 102, 241, 0.3)' : 'rgba(239, 68, 68, 0.3)'};
      font-size:12px;
      font-weight:700;
      color:${success ? '#818cf8' : '#f87171'};
      letter-spacing:0.04em;
      text-transform:uppercase;
      margin-bottom:24px;
    }
    .icon-wrap {
      width:84px;
      height:84px;
      margin:0 auto 24px;
      border-radius:24px;
      display:flex;
      align-items:center;
      justify-content:center;
      background:${success ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(6, 182, 212, 0.2) 100%)' : 'linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(244, 63, 94, 0.2) 100%)'};
      border:1px solid ${success ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'};
      box-shadow:0 0 35px ${success ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'};
    }
    .checkmark {
      width:44px;
      height:44px;
      stroke:${success ? '#10b981' : '#ef4444'};
      stroke-width:3;
      stroke-linecap:round;
      stroke-linejoin:round;
      fill:none;
      stroke-dasharray:100;
      stroke-dashoffset:100;
      animation:draw 0.8s ease forwards 0.2s;
    }
    @keyframes draw { to { stroke-dashoffset:0; } }
    h1 { font-size:24px; font-weight:800; letter-spacing:-0.02em; margin-bottom:12px; color:#ffffff; }
    p { font-size:14px; color:#94a3b8; line-height:1.6; margin-bottom:28px; }
    .btn {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      width:100%;
      padding:15px 24px;
      border-radius:18px;
      font-size:15px;
      font-weight:700;
      color:#ffffff;
      text-decoration:none;
      background:linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
      box-shadow:0 10px 25px -5px rgba(79, 70, 229, 0.4);
      transition:all 0.2s ease;
      cursor:pointer;
      border:none;
    }
    .btn:hover {
      transform:translateY(-2px);
      box-shadow:0 15px 30px -5px rgba(79, 70, 229, 0.6);
    }
    .footer-text {
      margin-top:20px;
      font-size:12px;
      color:#64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">✦ PAYPULSE GÜVENLİK</div>
    <div class="icon-wrap">
      ${success ? '<svg class="checkmark" viewBox="0 0 24 24"><path d="M20 6L9 17L4 12"></path></svg>' : '<svg class="checkmark" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>'}
    </div>
    <h1>${success ? 'E-postanız Doğrulandı!' : 'Doğrulama Başarısız'}</h1>
    <p>${success ? (message || 'Hesabınız başarıyla aktifleştirildi.') : (error || 'Bir sorun oluştu.')}</p>
    <a href="paypulse://open" class="btn" onclick="tryClose();">${success ? "PayPulse'ı Aç ve Sekmeyi Kapat" : 'Giriş Ekranına Dön'}</a>
    ${success ? `
    <div id="countWrap" style="font-size:12px;color:#94a3b8;margin-top:14px;line-height:1.5;">Bu sekme <b style="color:#818cf8;"><span id="vCount">2</span></b> saniye sonra otomatik kapanacak...</div>
    <script>
      function tryClose() {
        try { window.opener = null; } catch(e) {}
        try { window.open('', '_self', ''); window.close(); } catch(e) {}
        try { window.open(window.location.href, '_self'); window.close(); } catch(e) {}
        try { if (window.top) window.top.close(); } catch(e) {}
        try { window.close(); } catch(e) {}
      }
      try { window.location.href = 'paypulse://open'; } catch(e) {}
      tryClose();
      var vLeft = 2;
      var vEl = document.getElementById('vCount');
      var vTimer = setInterval(function() {
        vLeft--;
        if (vEl) vEl.textContent = vLeft;
        tryClose();
        if (vLeft <= 0) {
          clearInterval(vTimer);
          tryClose();
          setTimeout(function() {
            var cw = document.getElementById('countWrap');
            if (cw) {
              cw.innerHTML = 'Tarayıcı koruması nedeniyle sekme kapanmadıysa yukarıdaki butona tıklayın veya <kbd style="background:rgba(255,255,255,0.1);padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,0.2);">Ctrl + W</kbd> ile kapatın.';
            }
          }, 300);
        }
      }, 1000);
    </script>
    ` : ''}
    <div class="footer-text">Mobil veya masaüstü uygulama açılmazsa doğrudan uygulamaya dönüp giriş yapabilirsiniz.</div>
  </div>
</body>
</html>`;
}

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

    const isGoogleOnly = isGooglePlaceholder(user.password);
    if (isGoogleOnly) {
      if (String(confirmText || '').trim().toUpperCase() !== 'SİL' && String(confirmText || '').trim().toUpperCase() !== 'SIL') {
        return res.status(400).json({ success: false, error: 'Onaylamak için "SİL" yaz.' });
      }
    } else {
      const ok = await checkPassword(user.password, password);
      if (!ok) return res.status(401).json({ success: false, error: 'Şifre hatalı' });
    }

    await db.batch([
      { sql: 'DELETE FROM payments WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM settings WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM daily_incomes WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM notifications WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM individual_profiles WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM corporate_profiles WHERE user_id = ?', args: [userId] },
      // KVKK: hesapla birlikte kullanıcıya ait tüm kayıtlar silinir
      { sql: 'DELETE FROM wallet_transfers WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM wallets WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM portfolio_items WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM user_notes WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM ai_reports WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM game_profiles WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', args: [userId, userId] },
      { sql: 'DELETE FROM friendships WHERE requester_id = ? OR recipient_id = ?', args: [userId, userId] },
      { sql: 'DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?', args: [userId, userId] },
      { sql: 'DELETE FROM user_reports WHERE reporter_id = ? OR reported_user_id = ?', args: [userId, userId] },
      { sql: 'DELETE FROM user_sessions WHERE user_id = ?', args: [userId] },
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

// ── Oturum ve Cihaz Listesi (Uzaktan Çıkış) ───────────────────
// GET /api/auth/sessions
router.get('/sessions', async (req, res) => {
  try {
    const uid = req.authUserId;
    if (!uid) return res.status(401).json({ success: false, error: 'Oturum gerekli' });

    const r = await db.execute({
      sql: `SELECT id, device_name, os, browser, ip, last_active_at, created_at, is_revoked
            FROM user_sessions
            WHERE user_id = ? AND is_revoked = 0
            ORDER BY datetime(last_active_at) DESC`,
      args: [uid]
    });

    const sessions = r.rows.map(s => ({
      id: s.id,
      deviceName: s.device_name || 'Bilinmeyen Cihaz',
      os: s.os || 'Bilinmiyor',
      browser: s.browser || 'Tarayıcı',
      ip: s.ip || '—',
      lastActiveAt: s.last_active_at,
      createdAt: s.created_at,
      isCurrent: Boolean(req.authSessionId && s.id === req.authSessionId)
    }));

    res.json({
      success: true,
      sessions,
      currentSessionId: req.authSessionId || null
    });
  } catch (err) {
    console.error('[AUTH] Sessions error:', err.message);
    res.status(500).json({ success: false, error: 'Oturumlar listelenemedi' });
  }
});

// POST /api/auth/sessions/revoke/:sessionId
router.post('/sessions/revoke/:sessionId', async (req, res) => {
  try {
    const uid = req.authUserId;
    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).json({ success: false, error: 'Oturum kimliği gerekli' });

    await db.execute({
      sql: `UPDATE user_sessions SET is_revoked = 1 WHERE id = ? AND user_id = ?`,
      args: [sessionId, uid]
    });
    revokeSession(sessionId);

    res.json({ success: true, message: 'Cihaz oturumu başarıyla kapatıldı.' });
  } catch (err) {
    console.error('[AUTH] Revoke session error:', err.message);
    res.status(500).json({ success: false, error: 'Oturum kapatılamadı' });
  }
});

// POST /api/auth/sessions/revoke-others
router.post('/sessions/revoke-others', async (req, res) => {
  try {
    const uid = req.authUserId;
    const currentSid = req.authSessionId;

    if (currentSid) {
      await db.execute({
        sql: `UPDATE user_sessions SET is_revoked = 1 WHERE user_id = ? AND id != ?`,
        args: [uid, currentSid]
      });
    } else {
      await db.execute({
        sql: `UPDATE user_sessions SET is_revoked = 1 WHERE user_id = ?`,
        args: [uid]
      });
    }

    // Oturum kimliği taşımayan (eski) anahtarlar da geçersiz olsun
    await db.execute({ sql: 'UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?', args: [uid] });
    invalidateUser(uid);
    const fresh = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [uid] })).rows[0];
    res.json({ success: true, message: 'Diğer tüm cihaz oturumları kapatıldı.', user: formatUser(fresh), token: signToken(fresh, currentSid) });
  } catch (err) {
    console.error('[AUTH] Revoke others error:', err.message);
    res.status(500).json({ success: false, error: 'Oturumlar kapatılamadı' });
  }
});

module.exports = router;
