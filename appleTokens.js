const crypto = require('crypto');

/**
 * Apple ile Giriş jetonları (App Store 5.1.1(v)): hesap silinince Apple jetonu iptal edilir.
 * Girişte gelen yetki kodu Apple'da yenileme jetonuna çevrilir ve şifreli saklanır; silmede /auth/revoke çağrılır.
 * Gerekli ortam değişkenleri: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 içeriği). Yoksa özellik sessizce kapalıdır.
 * Jetonlar ve anahtarlar loglanmaz.
 */
const appleBase = () => process.env.APPLE_AUTH_BASE_URL || 'https://appleid.apple.com';
const clientId = () => (process.env.APPLE_AUDIENCES || 'online.usepaypulse.app').split(',')[0].trim();

const privateKey = () => String(process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const isConfigured = () => !!(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && privateKey());

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** Apple'ın istediği istemci sırrı: .p8 anahtarıyla ES256 imzalı kısa ömürlü JWT */
function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'ES256', kid: process.env.APPLE_KEY_ID });
  const body = b64url({ iss: process.env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: clientId() });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

async function applePost(path, params) {
  const form = new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params });
  const r = await fetch(`${appleBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    let code = '';
    try { code = JSON.parse(text).error || ''; } catch { /* Apple gövdesi JSON değilse kod boş kalır */ }
    throw new Error(`Apple ${path} ${r.status}${code ? ' ' + code : ''}`);
  }
  return text ? JSON.parse(text) : {};
}

// Saklanan jeton AES-256-GCM ile şifrelenir (anahtar APPLE_TOKEN_KEY ya da SESSION_SECRET'tan türetilir)
const encKey = () => crypto.createHash('sha256').update(String(process.env.APPLE_TOKEN_KEY || process.env.SESSION_SECRET || 'paypulse-apple')).digest();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
function decrypt(stored) {
  const [v, iv, tag, data] = String(stored || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('jeton biçimi geçersiz');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Yetki kodunu yenileme jetonuna çevirip kullanıcıya şifreli kaydeder. Hata girişi engellemez. */
async function storeRefreshTokenFromCode(db, appleSub, authorizationCode) {
  if (!authorizationCode || !appleSub || !isConfigured()) return false;
  try {
    const t = await applePost('/auth/token', { grant_type: 'authorization_code', code: String(authorizationCode) });
    if (!t.refresh_token) return false;
    await db.execute({ sql: 'UPDATE users SET apple_refresh_token = ? WHERE apple_id = ?', args: [encrypt(t.refresh_token), String(appleSub)] });
    return true;
  } catch (err) {
    console.warn('[Apple] yetki kodu çevrilemedi:', err.message);
    return false;
  }
}

/** Hesap silmeden önce çağrılır: kayıtlı Apple jetonunu iptal eder. Hata silmeyi engellemez. */
async function revokeForUser(db, userId) {
  if (!isConfigured()) return false;
  try {
    const r = await db.execute({ sql: 'SELECT apple_refresh_token FROM users WHERE id = ?', args: [userId] });
    const stored = r.rows[0]?.apple_refresh_token;
    if (!stored) return false;
    await applePost('/auth/revoke', { token: decrypt(stored), token_type_hint: 'refresh_token' });
    return true;
  } catch (err) {
    console.warn('[Apple] jeton iptal edilemedi:', err.message);
    return false;
  }
}

module.exports = { isConfigured, storeRefreshTokenFromCode, revokeForUser, _test: { clientSecret, encrypt, decrypt } };
