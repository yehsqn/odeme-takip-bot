/**
 * Oturum anahtarı (imzalı token) ve kimlik doğrulama ara katmanı.
 *
 * Token: base64url(payload).base64url(HMAC-SHA256)
 *   payload = { uid, tv, iat, exp }  — tv: users.token_version (şifre değişince/hesap silinince artar)
 *
 * Gizli anahtar: SESSION_SECRET ortam değişkeni; yoksa veritabanı token'ından türetilir
 * (sunucuya özel ve gizli kalır, ek ayar gerektirmez).
 */
const crypto = require('crypto');
const { db } = require('../db/turso');

const SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('paypulse-session:' + (process.env.TURSO_AUTH_TOKEN || process.env.TURSO_DATABASE_URL || 'local-dev')).digest('hex');

const TOKEN_TTL_SEC = 60 * 60 * 24 * 60; // 60 gün

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const sign = (data) => b64url(crypto.createHmac('sha256', SECRET).update(data).digest());

function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ uid: user.id, tv: Number(user.token_version) || 0, iat: now, exp: now + TOKEN_TTL_SEC }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(fromB64url(payload).toString('utf8'));
    if (!data.uid || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

// Kullanıcı başına kısa önbellek (her istekte DB'ye gitmemek için)
const userCache = new Map();
const CACHE_MS = 60 * 1000;

async function loadAuthUser(uid) {
  const hit = userCache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const r = await db.execute({ sql: 'SELECT id, email, role, token_version FROM users WHERE id = ?', args: [uid] });
  const user = r.rows[0] || null;
  userCache.set(uid, { user, at: Date.now() });
  return user;
}

/** Şifre değişimi, hesap silme vb. sonrası önbelleği temizler */
function invalidateUser(uid) {
  userCache.delete(uid);
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'yehsqn@gmail.com';
const isAdmin = (u) => !!u && (u.role === 'admin' || u.email === ADMIN_EMAIL);

const tokenFromReq = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** Token geçerliyse kullanıcıyı döner, değilse null */
async function authenticate(token) {
  const data = verifyToken(token);
  if (!data) return null;
  const user = await loadAuthUser(data.uid);
  if (!user) return null; // hesap silinmiş
  if ((Number(user.token_version) || 0) !== (Number(data.tv) || 0)) return null; // şifre değişti / tüm oturumlar kapatıldı
  return user;
}

// Oturum gerektirmeyen uçlar (giriş, kayıt, şifre sıfırlama, herkese açık kurlar, ödeme webhook'u)
const PUBLIC = [
  /^\/api\/auth\/(login|register|google|forgot-password|verify-reset-code|reset-password|verify-email|resend-verification)\/?$/,
  /^\/api\/exchange(\/|$)/,
  /^\/api\/subscription\/webhook\/?$/,
  /^\/api\/errors\/?$/,
];
// Oturum varsa kullanılır ama zorunlu değil (anonim geri bildirim)
const OPTIONAL = [/^\/api\/feedback\/?$/];

/**
 * /api altındaki her isteği doğrular:
 * - Geçerli token yoksa 401
 * - body/query içindeki userId / adminUserId, token sahibinden farklıysa 403
 */
async function requireAuth(req, res, next) {
  const path = req.path.startsWith('/api') ? req.path : req.baseUrl + req.path;
  if (req.method === 'OPTIONS' || PUBLIC.some(r => r.test(path))) return next();

  try {
    const user = await authenticate(tokenFromReq(req));
    if (!user) {
      if (OPTIONAL.some(r => r.test(path)) && req.method === 'POST') return next();
      return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', error: 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.' });
    }
    req.authUser = user;
    req.authUserId = user.id;

    for (const src of [req.body, req.query]) {
      if (!src || typeof src !== 'object') continue;
      for (const key of ['userId', 'adminUserId']) {
        if (src[key] !== undefined && src[key] !== null && src[key] !== '' && String(src[key]) !== user.id) {
          return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Bu işlem için yetkiniz yok.' });
        }
      }
    }
    // userId gönderilmemişse token sahibinin kimliği kullanılır
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.userId === undefined) {
      req.body.userId = user.id;
    }
    next();
  } catch (err) {
    console.error('[AUTH] Doğrulama hatası:', err.message);
    res.status(500).json({ success: false, error: 'Kimlik doğrulanamadı.' });
  }
}

/** router.param('userId', ensureSelfParam) — yol parametresindeki kullanıcı kimliği token sahibi olmalı */
function ensureSelfParam(req, res, next, value) {
  if (!req.authUserId || String(value) !== req.authUserId) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Bu işlem için yetkiniz yok.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.authUser)) return res.status(403).json({ success: false, error: 'Yetkisiz işlem. Sadece admin yapabilir.' });
  next();
}

module.exports = { signToken, verifyToken, authenticate, requireAuth, ensureSelfParam, requireAdmin, invalidateUser, isAdmin };
