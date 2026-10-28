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

function signToken(user, sid = null) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    uid: user.id,
    tv: Number(user.token_version) || 0,
    sid: sid || undefined,
    iat: now,
    exp: now + TOKEN_TTL_SEC
  }));
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

// İptal edilen oturumlar için önbellek
const revokedSessionCache = new Set();
// Son etkinlik güncelleme throttle (oturum başına en fazla 2 dakikada bir DB'ye yazar)
const sessionTouchMap = new Map();

// Geçerli oturumlar 30 sn önbellekte (her istekte veritabanına gitmemek için);
// bu süreçte iptal edilen oturum revokeSession ile anında düşer.
const activeSessionCache = new Map();
async function checkSessionRevoked(sid) {
  if (!sid) return false;
  if (revokedSessionCache.has(sid)) return true;
  const okAt = activeSessionCache.get(sid);
  if (okAt && Date.now() - okAt < 30 * 1000) return false;
  try {
    const r = await db.execute({ sql: 'SELECT is_revoked FROM user_sessions WHERE id = ?', args: [sid] });
    // Kaydı olmayan oturum kimliği geçersizdir (silinmiş / uydurma)
    if (!r.rows.length || Number(r.rows[0].is_revoked) === 1) {
      revokedSessionCache.add(sid);
      return true;
    }
    activeSessionCache.set(sid, Date.now());
  } catch {
    // Tablo henüz yoksa devam et
  }
  return false;
}

function touchSessionThrottled(sid) {
  if (!sid) return;
  const now = Date.now();
  const last = sessionTouchMap.get(sid) || 0;
  if (now - last > 120 * 1000) { // 2 dakika
    sessionTouchMap.set(sid, now);
    db.execute({
      sql: `UPDATE user_sessions SET last_active_at = datetime('now') WHERE id = ? AND is_revoked = 0`,
      args: [sid]
    }).catch(() => {});
  }
}

function revokeSession(sid) {
  if (!sid) return;
  revokedSessionCache.add(sid);
  activeSessionCache.delete(sid);
}

function clearRevokedSessionCache() {
  revokedSessionCache.clear();
}

async function loadAuthUser(uid) {
  const hit = userCache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const r = await db.execute({ sql: 'SELECT id, email, role, token_version, is_banned, ban_reason, banned_until FROM users WHERE id = ?', args: [uid] });
  const user = r.rows[0] || null;
  if (user) await liftExpiredBan(user);
  userCache.set(uid, { user, at: Date.now() });
  return user;
}

/** Süreli ban dolduysa kaldırır (user nesnesini de günceller). true → ban kalktı */
async function liftExpiredBan(user) {
  if (!user || Number(user.is_banned) !== 1 || !user.banned_until) return false;
  const until = Date.parse(user.banned_until);
  if (!until || until > Date.now()) return false;
  try {
    await db.execute({
      sql: 'UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL, banned_until = NULL WHERE id = ?',
      args: [user.id],
    });
  } catch { /* bir sonraki istekte yeniden denenir */ }
  user.is_banned = 0;
  user.ban_reason = null;
  user.banned_until = null;
  return true;
}

/** Ban mesajı: süreliyse bitiş tarihini ekler */
function banMessage(user) {
  const reason = user.ban_reason || 'Hesabınız kurallara aykırı davranış nedeniyle askıya alınmıştır.';
  if (!user.banned_until) return reason;
  const d = new Date(user.banned_until);
  return isNaN(d) ? reason : `${reason} (Ban bitişi: ${d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })})`;
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
  if (data.sid && (await checkSessionRevoked(data.sid))) return null;
  const user = await loadAuthUser(data.uid);
  if (!user) return null; // hesap silinmiş
  if ((Number(user.token_version) || 0) !== (Number(data.tv) || 0)) return null; // şifre değişti / tüm oturumlar kapatıldı
  if (data.sid) touchSessionThrottled(data.sid);
  return { ...user, sid: data.sid || null };
}

// Oturum gerektirmeyen uçlar (giriş, kayıt, şifre sıfırlama, herkese açık kurlar, ödeme webhook'u)
const PUBLIC = [
  /^\/api\/auth\/(login|register|google|forgot-password|verify-reset-code|reset-password|verify-email|verify-link|resend-verification|unsubscribe)\/?$/,
  /^\/api\/exchange(\/|$)/,
  /^\/api\/subscription\/webhook\/?$/,
  /^\/api\/errors\/?$/,
];
// Oturum varsa kullanılır ama zorunlu değil (anonim geri bildirim)
const OPTIONAL = [/^\/api\/feedback\/?$/];

/**
 * /api altındaki her isteği doğrular:
 * - Geçerli token yoksa 401
 * - Kullanıcı banlıysa 403 USER_BANNED
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

    if (Number(user.is_banned) === 1) {
      return res.status(403).json({
        success: false,
        code: 'USER_BANNED',
        isBanned: true,
        banReason: banMessage(user),
        bannedUntil: user.banned_until || null,
        error: 'Hesabınız askıya alınmıştır.'
      });
    }

    req.authUser = user;
    req.authUserId = user.id;
    req.authSessionId = user.sid || null;

    for (const src of [req.body, req.query]) {
      if (!src || typeof src !== 'object') continue;
      for (const key of ['userId', 'adminUserId']) {
        if (src[key] !== undefined && src[key] !== null && src[key] !== '' && String(src[key]) !== user.id) {
          return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Bu işlem için yetkiniz yok.' });
        }
      }
    }
    // userId gönderilmemiş / boş / null ise token sahibinin kimliği kullanılır
    // (boş değer "tüm kullanıcılar" anlamına gelecek uçlara sızmasın)
    const isBlank = (v) => v === undefined || v === null || v === '';
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && isBlank(req.body.userId)) {
      req.body.userId = user.id;
    }
    if (req.query && 'userId' in req.query && isBlank(req.query.userId)) {
      req.query.userId = user.id;
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

/** E-postadaki abonelikten çıkma bağlantısı için kullanıcıya özel imza */
const unsubscribeSig = (uid) => sign('unsub:' + uid);

module.exports = { unsubscribeSig, signToken, verifyToken, authenticate, requireAuth, ensureSelfParam, requireAdmin, invalidateUser, isAdmin, revokeSession, liftExpiredBan, banMessage };
