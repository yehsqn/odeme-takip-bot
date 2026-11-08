const { db } = require('./db/turso');

// Ödeme hatırlatmaları telefonda yerel bildirimle gelir; burada yalnızca sunucudan doğan olaylar var.
// Metin Google üzerinden geçtiği için tutar, mesaj içeriği ve kişi adı gönderilmez.
const PUSH_TEXTS = {
  WEEKLY_SUMMARY: (p) => ({ title: p.title, body: 'Ödemelerini görmek için dokun.' }),
  APP_UPDATE: (p) => ({ title: p.title, body: 'Yenilikleri görmek için dokun.' }),
  REFERRAL_REWARD: (p) => ({ title: p.title, body: 'Ayrıntılar için dokun.' }),
  CITY_CHEER: (p) => ({ title: p.title, body: 'Ayrıntılar için dokun.' }),
  CHAT: () => ({ title: '💬 Yeni mesajın var', body: 'Okumak için dokun.' }),
  FRIEND_REQUEST: () => ({ title: '👥 Yeni arkadaşlık isteği', body: 'Görmek için dokun.' }),
  TEST: () => ({ title: '🔔 PayPulse test bildirimi', body: 'Uygulama kapalıyken bildirimler çalışıyor.' }),
};
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const state = { messaging: undefined, error: null };

/**
 * FIREBASE_SERVICE_ACCOUNT: hizmet hesabı JSON'u (düz ya da base64). Render'a yapıştırırken
 * private_key içindeki satır sonları gerçek satıra dönüşmüş olabilir; bunlar düzeltilir.
 */
function parseServiceAccount(raw) {
  let s = String(raw).trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"') && !s.startsWith('"{'))) s = s.slice(1, -1).trim();
  if (!s.startsWith('{')) {
    const decoded = Buffer.from(s, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) s = decoded;
  }
  // Tırnak içindeki ham satır sonlarını \n kaçışına çevir (JSON yapısındaki satır sonlarına dokunma)
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') continue;
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  const obj = JSON.parse(out);
  if (typeof obj.private_key === 'string') obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  return obj;
}

function getMessaging() {
  if (state.messaging !== undefined) return state.messaging;
  state.messaging = null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw || !String(raw).trim()) {
    state.error = 'missing';
    console.error('[PUSH] FIREBASE_SERVICE_ACCOUNT ortam değişkeni bulunamadı (adı birebir böyle olmalı).');
    return null;
  }
  let account;
  try {
    account = parseServiceAccount(raw);
  } catch (err) {
    state.error = 'json';
    // Hata metni JSON'dan parça içerebilir (anahtar loga düşmesin): yalnızca konum ve uzunluk yazılır
    const pos = /position (\d+)/.exec(String(err.message))?.[1];
    console.error(`[PUSH] FIREBASE_SERVICE_ACCOUNT JSON olarak okunamadı (uzunluk ${String(raw).length}${pos ? `, hata konumu ${pos}` : ''}). Firebase'den indirilen dosyanın tamamını yapıştır.`);
    return null;
  }
  if (!account.private_key || !account.client_email || !account.project_id) {
    state.error = 'fields';
    console.error('[PUSH] Hizmet hesabı JSON içinde private_key / client_email / project_id eksik.');
    return null;
  }
  try {
    // firebase-admin v12+ modüler API (eski admin.credential / admin.messaging() v14'te yok)
    const { initializeApp, getApps, cert } = require('firebase-admin/app');
    const { getMessaging: firebaseMessaging } = require('firebase-admin/messaging');
    const app = getApps()[0] || initializeApp({ credential: cert(account) });
    state.messaging = firebaseMessaging(app);
    console.log(`[PUSH] Firebase hazır (proje: ${account.project_id})`);
  } catch (err) {
    state.error = 'key';
    console.error('[PUSH] Firebase başlatılamadı:', err.message);
  }
  return state.messaging;
}

/** Uygulaması kapalı kullanıcının telefonuna bildirim düşürür. Firebase ayarlı değilse hiçbir şey yapmaz. */
async function sendPush(userId, payload) {
  const text = PUSH_TEXTS[payload.type]?.(payload);
  const messaging = text && getMessaging();
  if (!messaging) return { sent: 0, failed: 0 };
  const tokens = (await db.execute({ sql: 'SELECT token FROM device_tokens WHERE user_id = ?', args: [userId] })).rows.map(r => r.token);
  if (!tokens.length) return { sent: 0, failed: 0 };
  const result = await messaging.sendEachForMulticast({
    tokens,
    notification: text,
    android: { priority: 'high', notification: { channelId: 'payments' } },
    apns: { payload: { aps: { sound: 'default' } } },
  });
  const dead = tokens.filter((_, i) => DEAD_TOKEN.has(result.responses[i]?.error?.code));
  for (const token of dead) await db.execute({ sql: 'DELETE FROM device_tokens WHERE token = ?', args: [token] });
  return { sent: result.successCount, failed: result.failureCount, errors: result.responses.map(r => r.error?.code).filter(Boolean) };
}

const pushConfigured = () => !!getMessaging();
/** Firebase neden başlamadı: 'missing' | 'json' | 'fields' | 'key' | null (gizli bilgi içermez) */
const pushError = () => (getMessaging() ? null : state.error);

module.exports = { sendPush, pushConfigured, pushError, parseServiceAccount, _state: state };
