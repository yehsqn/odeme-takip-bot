const { WebSocketServer } = require('ws');
const { db } = require('./db/turso');
const crypto = require('crypto');

// userId → WebSocket bağlantısı haritası
const clients = new Map();

/**
 * Bir kullanıcıya anlık bildirim gönderir.
 * Kullanıcı çevrimdışıysa bildirimi veritabanına kaydeder.
 *
 * @param {string} userId
 * @param {{ type: string, title: string, body: string, paymentId?: string }} payload
 */
async function sendToUser(userId, payload) {
  const ws = clients.get(userId);
  const notifId = crypto.randomBytes(12).toString('hex');

  // Veritabanına her durumda kaydet (offline kuyruk + geçmiş)
  try {
    await db.execute({
      sql: `INSERT INTO notifications (id, user_id, type, title, body, payment_id, is_read)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        notifId,
        userId,
        payload.type,
        payload.title,
        payload.body,
        payload.paymentId || null,
        0, // okunmadı
      ],
    });
  } catch (err) {
    console.error('[WS] Bildirim DB kayıt hatası:', err.message);
  }

  // Kullanıcı çevrimiçiyse WebSocket üzerinden anlık gönder
  if (ws && ws.readyState === 1 /* OPEN */) {
    try {
      ws.send(
        JSON.stringify({
          type: 'NOTIFICATION',
          notification: {
            id: notifId,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            paymentId: payload.paymentId || null,
            isRead: false,
            createdAt: new Date().toISOString(),
          },
        })
      );
      console.log(`[WS] Anlık bildirim gönderildi → ${userId}`);
    } catch (err) {
      console.error('[WS] Gönderim hatası:', err.message);
    }
  } else {
    console.log(`[WS] Kullanıcı çevrimdışı, bildirim DB'ye kaydedildi → ${userId}`);
  }
}

/**
 * WebSocket sunucusunu HTTP sunucusuna bağlar.
 * @param {import('http').Server} httpServer
 */
function initWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let authenticatedUserId = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Kimlik doğrulama: { type: 'AUTH', userId }
        if (msg.type === 'AUTH' && msg.userId) {
          authenticatedUserId = msg.userId;
          clients.set(msg.userId, ws);
          console.log(`[WS] Kullanıcı bağlandı: ${msg.userId} (toplam: ${clients.size})`);

          // Giriş sonrası okunmamış bildirimleri say ve bildir
          try {
            const result = await db.execute({
              sql: `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
              args: [msg.userId],
            });
            const unreadCount = result.rows[0]?.cnt || 0;
            ws.send(JSON.stringify({ type: 'UNREAD_COUNT', count: Number(unreadCount) }));
          } catch (err) {
            console.error('[WS] Okunmamış sayım hatası:', err.message);
          }

          ws.send(JSON.stringify({ type: 'AUTH_OK', userId: msg.userId }));
        }

        // Ping-pong (bağlantı canlılığı)
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'PONG' }));
        }
      } catch (err) {
        console.error('[WS] Mesaj parse hatası:', err.message);
      }
    });

    ws.on('close', () => {
      if (authenticatedUserId) {
        clients.delete(authenticatedUserId);
        console.log(`[WS] Kullanıcı ayrıldı: ${authenticatedUserId} (kalan: ${clients.size})`);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Bağlantı hatası:', err.message);
    });
  });

  console.log('[WS] WebSocket sunucusu /ws yolunda hazır');
  return wss;
}

module.exports = { sendToUser, initWebSocket, clients };
