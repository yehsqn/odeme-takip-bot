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

const state = { messaging: undefined };

function getMessaging() {
  if (state.messaging !== undefined) return state.messaging;
  state.messaging = null;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    state.messaging = admin.messaging();
  } catch (err) {
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

module.exports = { sendPush, pushConfigured, _state: state };
