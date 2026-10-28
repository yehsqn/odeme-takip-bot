const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');
const axios = require('axios');
const { ensureSelfParam, requireAdmin } = require('../middleware/session');
const { sendWsEvent } = require('../websocket');

router.param('userId', ensureSelfParam);

// RevenueCat'te tanımlı Premium yetki (entitlement) adları
const ENTITLEMENTS = (process.env.REVENUECAT_ENTITLEMENTS || 'pro,pro_access').split(',').map(x => x.trim()).filter(Boolean);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'yehsqn@gmail.com';

// Helper: Check if premium is active
function isPremiumActive(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.email === ADMIN_EMAIL) return true;
  if (user.subscription_type === 'lifetime') return true;
  // Süresi dolan abonelik, is_premium bayrağı kalmış olsa da Premium sayılmaz
  if (user.subscription_expiry && new Date(user.subscription_expiry) < new Date()) return false;
  if (Number(user.is_premium) === 1) return true;
  if (user.subscription_type === 'free') return false;
  return user.subscription_status === 'active';
}

// ── RevenueCat yardımcıları ─────────────────────────────────────────────
// Ürün kimliğinden plan: odeme_takip_yearly → yearly; süresiz (ömür boyu) satın alma → lifetime
const planFromProduct = (productId, expiryIso) => {
  if (!expiryIso) return 'lifetime';
  return /annual|year|yil/i.test(String(productId || '')) ? 'yearly' : 'monthly';
};

// Anonim RevenueCat kimlikleri ($RCAnonymousID:...) bizim kullanıcılarımız değildir
const isOurUserId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);

/** Aktif aboneliği kullanıcıya işler */
async function grantPremium(userId, plan, expiryIso) {
  await db.execute({
    sql: `UPDATE users SET subscription_type = ?, subscription_status = 'active', subscription_expiry = ?,
            subscription_plan = ?, is_premium = 1, premium_expires_at = ?, ai_analysis_tokens = 999,
            subscription_source = 'revenuecat' WHERE id = ?`,
    args: [plan, expiryIso, plan, expiryIso, userId],
  });
}

/**
 * Süresi dolan / iade edilen aboneliği kaldırır. Yalnızca RevenueCat'ten gelen Premium düşer:
 * ömür boyu, deneme ve admin tarafından verilmiş Premium'a dokunulmaz.
 */
async function revokePremium(userId, endedIso) {
  const ended = endedIso || new Date().toISOString();
  await db.execute({
    sql: `UPDATE users SET subscription_status = 'expired', is_premium = 0, ai_analysis_tokens = 0,
            subscription_expiry = ?, premium_expires_at = ?
          WHERE id = ? AND subscription_type IN ('monthly', 'yearly')
            AND COALESCE(subscription_source, 'revenuecat') = 'revenuecat'`,
    args: [ended, ended, userId],
  });
}

/**
 * Kullanıcının RevenueCat'teki güncel yetkisini okuyup veritabanına işler (tek doğruluk kaynağı).
 * REVENUECAT_SECRET_KEY yoksa null döner.
 */
async function applyRevenueCat(userId) {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) return null;
  const r = await axios.get(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${key}` }, timeout: 10000,
  });
  const ents = r.data?.subscriber?.entitlements || {};
  const now = Date.now();
  const all = ENTITLEMENTS.map(id => ents[id]).filter(Boolean);
  const active = all.find(e => !e.expires_date || new Date(e.expires_date).getTime() > now);
  if (active) {
    const expiry = active.expires_date ? new Date(active.expires_date).toISOString() : null;
    const plan = planFromProduct(active.product_identifier, expiry);
    await grantPremium(userId, plan, expiry);
    return { isPremium: true, plan, expiry };
  }
  if (all.length) {
    const lastEnd = all.map(e => new Date(e.expires_date).toISOString()).sort().pop();
    await revokePremium(userId, lastEnd);
  }
  return { isPremium: false };
}

// GET /api/subscription/status/:userId
router.get('/status/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT subscription_type, subscription_status, subscription_expiry, ai_analysis_tokens, ai_tokens_reset_at, is_premium FROM users WHERE id = ?',
      args: [req.params.userId]
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const isActive = isPremiumActive(user);

    // Auto-expire if needed
    if (user.subscription_status === 'active' && user.subscription_expiry && new Date(user.subscription_expiry) < new Date()) {
      await db.execute({
        sql: 'UPDATE users SET subscription_status = ?, is_premium = 0, subscription_type = ? WHERE id = ?',
        args: ['expired', 'free', req.params.userId]
      });
    }

    // Weekly AI token reset for free users
    const now = new Date();
    if (!isActive) {
      const resetAt = user.ai_tokens_reset_at ? new Date(user.ai_tokens_reset_at) : null;
      if (!resetAt || (now - resetAt) > 7 * 24 * 60 * 60 * 1000) {
        await db.execute({
          sql: 'UPDATE users SET ai_analysis_tokens = 1, ai_tokens_reset_at = ? WHERE id = ?',
          args: [now.toISOString(), req.params.userId]
        });
        user.ai_analysis_tokens = 1;
        user.ai_tokens_reset_at = now.toISOString();
      }
    }

    const hasExpiry = !!user.subscription_expiry;
    const isExpired = hasExpiry && new Date(user.subscription_expiry) < new Date();
    const isTrial = (user.subscription_type === 'trial') && isActive;
    const trialExpired = !isActive && (user.subscription_type === 'trial' || (hasExpiry && isExpired));
    const canStartTrial = !isActive && !hasExpiry && user.subscription_type !== 'trial';

    res.json({
      success: true,
      subscription: {
        type: user.subscription_type || 'free',
        status: user.subscription_status || 'active',
        expiry: user.subscription_expiry,
        isPremiumActive: isActive,
        isTrial,
        trialExpired,
        canStartTrial,
        aiAnalysisTokens: isActive ? 999 : (user.ai_analysis_tokens ?? 1),
        aiTokensResetAt: user.ai_tokens_reset_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/start-trial — Kullanıcının tek seferlik 3 günlük PRO Deneme hakkını başlatır
router.post('/start-trial', async (req, res) => {
  try {
    const userId = req.authUserId || req.body?.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Oturum gerekli.' });

    const result = await db.execute({
      sql: 'SELECT id, email, role, subscription_type, subscription_status, subscription_expiry, is_premium FROM users WHERE id = ?',
      args: [userId]
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı.' });

    if (isPremiumActive(user)) {
      return res.json({ success: true, alreadyActive: true, message: 'PRO üyeliğiniz zaten aktif.' });
    }

    if (user.subscription_expiry || user.subscription_type === 'trial') {
      return res.status(400).json({
        success: false,
        error: 'Ücretsiz 3 günlük PRO deneme hakkınızı daha önce kullandınız.'
      });
    }

    const trialExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await db.execute({
      sql: `UPDATE users SET
              subscription_type = 'trial',
              subscription_plan = 'trial',
              subscription_status = 'active',
              subscription_expiry = ?,
              premium_expires_at = ?,
              is_premium = 1,
              ai_analysis_tokens = 999
            WHERE id = ?`,
      args: [trialExpiry, trialExpiry, userId]
    });

    res.json({
      success: true,
      isPremium: true,
      isTrial: true,
      expiry: trialExpiry,
      message: '🎁 3 Günlük Ücretsiz PayPulse PRO Denemeniz Başladı!'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/sync — satın alma / geri yükleme sonrası Premium'u RevenueCat'ten DOĞRULAYARAK verir.
// (Eski /activate ucu hiçbir doğrulama yapmadan Premium verdiği için kaldırıldı.)
// Gerekli: REVENUECAT_SECRET_KEY (RevenueCat → Project settings → API keys → Secret key)
router.post('/sync', async (req, res) => {
  try {
    const userId = req.authUserId;
    const result = await applyRevenueCat(userId);
    if (!result) {
      return res.status(503).json({ success: false, pending: true, error: 'Abonelik doğrulaması sunucuda yapılandırılmamış; satın alman webhook ile işlenecek.' });
    }
    if (!result.isPremium) return res.json({ success: true, isPremium: false });
    const { plan, expiry } = result;
    res.json({ success: true, isPremium: true, subscription: { type: plan, status: 'active', expiry, isPremiumActive: true } });
  } catch (err) {
    console.error('[SUBSCRIPTION SYNC]', err.response?.status, err.message);
    res.status(502).json({ success: false, error: 'Abonelik doğrulanamadı. Biraz sonra tekrar dene.' });
  }
});

// GET /api/subscription/web-checkout?package=$rc_annual — Masaüstü / web için RevenueCat Web Billing ödeme bağlantısı
// REVENUECAT_WEB_PURCHASE_URL: RevenueCat → Web → Web Purchase Links → üretim bağlantısı (https://pay.rev.cat/<token>)
const PACKAGE_IDS = new Set(['$rc_monthly', '$rc_annual']);
router.get('/web-checkout', async (req, res) => {
  try {
    const base = String(process.env.REVENUECAT_WEB_PURCHASE_URL || '').replace(/\/+$/, '');
    if (!/^https:\/\/pay\.rev\.cat\/[A-Za-z0-9_-]+$/.test(base)) {
      return res.status(503).json({ success: false, notConfigured: true, error: 'Bilgisayardan ödeme henüz açılmadı. Premium\'u Android uygulamasından alabilirsin.' });
    }
    const u = (await db.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [req.authUserId] })).rows[0];
    const params = new URLSearchParams();
    if (u?.email) params.set('email', u.email);
    const pkg = String(req.query.package || '');
    if (PACKAGE_IDS.has(pkg)) params.set('package_id', pkg);
    res.json({ success: true, url: `${base}/${encodeURIComponent(req.authUserId)}?${params}` });
  } catch (err) {
    console.error('[SUBSCRIPTION] web-checkout:', err.message);
    res.status(500).json({ success: false, error: 'Ödeme bağlantısı oluşturulamadı.' });
  }
});

// POST /api/subscription/cancel
router.post('/cancel', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    await db.execute({
      sql: "UPDATE users SET subscription_status = 'canceled' WHERE id = ?",
      args: [userId]
    });

    res.json({ success: true, message: 'Abonelik iptal edildi. Süre sonuna kadar kullanılabilir.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/consume-ai-token
router.post('/consume-ai-token', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const result = await db.execute({
      sql: 'SELECT email, role, subscription_type, subscription_status, subscription_expiry, ai_analysis_tokens FROM users WHERE id = ?',
      args: [userId]
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    // Admin veya premium: sınırsız
    const isActive = isPremiumActive(user);
    if (isActive) {
      return res.json({ success: true, remaining: 999 });
    }

    // Ücretsiz kullanıcı: sadece 1 kez kullanım hakkı (reset YOK)
    const tokens = user.ai_analysis_tokens ?? 1; // Yeni kayıt için default 1

    if (tokens <= 0) {
      return res.json({
        success: false,
        error: 'AI Koç özelliğini kullanmak için Premium üyelik gereklidir.',
        remaining: 0
      });
    }

    // Tek kullanım hakkını tüket
    await db.execute({
      sql: 'UPDATE users SET ai_analysis_tokens = 0 WHERE id = ?',
      args: [userId]
    });

    res.json({ success: true, remaining: 0, firstUse: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/admin/grant-premium — Admin'in başka kullanıcıya premium vermesi
router.post('/admin/grant-premium', requireAdmin, async (req, res) => {
  try {
    const { adminUserId, targetEmail, plan, durationMonths, durationDays } = req.body;
    if (!adminUserId || !targetEmail) {
      return res.status(400).json({ success: false, error: 'adminUserId ve targetEmail gerekli' });
    }

    // Admin kontrolü
    const adminResult = await db.execute({
      sql: 'SELECT email, role FROM users WHERE id = ?',
      args: [adminUserId]
    });
    const admin = adminResult.rows[0];
    if (!admin || (admin.email !== ADMIN_EMAIL && admin.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'Yetkisiz işlem. Sadece admin yapabilir.' });
    }

    // Hedef kullanıcıyı bul
    const targetResult = await db.execute({
      sql: 'SELECT id, email FROM users WHERE email = ?',
      args: [targetEmail]
    });
    const target = targetResult.rows[0];
    if (!target) {
      return res.status(404).json({ success: false, error: `${targetEmail} e-posta adresli kullanıcı bulunamadı` });
    }

    // Premium süresini hesapla
    const now = new Date();
    const expiry = new Date(now);
    const selectedPlan = plan || 'monthly';
    if (selectedPlan === 'lifetime') {
      // Ömür boyu: 100 yıl
      expiry.setFullYear(expiry.getFullYear() + 100);
    } else if (selectedPlan === 'yearly') {
      expiry.setFullYear(expiry.getFullYear() + 1);
    } else if (durationDays && Number(durationDays) > 0) {
      expiry.setDate(expiry.getDate() + Number(durationDays));
    } else {
      expiry.setMonth(expiry.getMonth() + (Number(durationMonths) || 1));
    }

    await db.execute({
      sql: `UPDATE users SET
              subscription_type = ?,
              subscription_status = 'active',
              subscription_expiry = ?,
              is_premium = 1,
              premium_expires_at = ?,
              ai_analysis_tokens = 999,
              subscription_source = 'admin'
            WHERE id = ?`,
      args: [selectedPlan, expiry.toISOString(), expiry.toISOString(), target.id]
    });

    res.json({
      success: true,
      message: `✅ ${targetEmail} kullanıcısına ${selectedPlan} premium verildi.`,
      expiry: expiry.toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/admin/revoke-premium — Admin'in premiumu kaldırması
router.post('/admin/revoke-premium', requireAdmin, async (req, res) => {
  try {
    const { adminUserId, targetEmail } = req.body;
    if (!adminUserId || !targetEmail) {
      return res.status(400).json({ success: false, error: 'adminUserId ve targetEmail gerekli' });
    }

    const adminResult = await db.execute({
      sql: 'SELECT email, role FROM users WHERE id = ?',
      args: [adminUserId]
    });
    const admin = adminResult.rows[0];
    if (!admin || (admin.email !== ADMIN_EMAIL && admin.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'Yetkisiz işlem.' });
    }

    const targetResult = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [targetEmail]
    });
    if (!targetResult.rows[0]) {
      return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
    }

    await db.execute({
      sql: `UPDATE users SET
              subscription_type = 'free',
              subscription_status = 'expired',
              is_premium = 0,
              subscription_expiry = NULL,
              premium_expires_at = NULL,
              ai_analysis_tokens = 0
            WHERE id = ?`,
      args: [targetResult.rows[0].id]
    });

    res.json({ success: true, message: `${targetEmail} kullanıcısının premium üyeliği iptal edildi.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/subscription/admin/users — Admin için kayıtlı kullanıcıları ve abonelik durumlarını listeleme
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const { adminUserId } = req.query;
    if (!adminUserId) {
      return res.status(400).json({ success: false, error: 'adminUserId gerekli' });
    }

    const adminResult = await db.execute({
      sql: 'SELECT email, role FROM users WHERE id = ?',
      args: [adminUserId]
    });
    const admin = adminResult.rows[0];
    if (!admin || (admin.email !== ADMIN_EMAIL && admin.role !== 'admin')) {
      return res.status(403).json({ success: false, error: 'Yetkisiz işlem. Sadece admin görüntüleyebilir.' });
    }

    const usersResult = await db.execute({
      sql: `SELECT id, email, display_name, avatar, is_premium, subscription_type, subscription_status,
                   subscription_expiry, premium_expires_at, created_at, customer_type, role
            FROM users
            ORDER BY is_premium DESC, created_at DESC`,
      args: []
    });

    const users = (usersResult.rows || []).map(row => {
      const isActive = !!row.is_premium && (!row.subscription_expiry || new Date(row.subscription_expiry) > new Date());
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name || '',
        avatar: row.avatar || '',
        isPremium: !!isActive,
        subscriptionType: row.subscription_type || 'free',
        subscriptionStatus: row.subscription_status || 'active',
        subscriptionExpiry: row.subscription_expiry || null,
        createdAt: row.created_at || null,
        customerType: row.customer_type || 'INDIVIDUAL',
        role: row.role || 'user'
      };
    });

    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/webhook — RevenueCat RTDN (Real-Time Developer Notifications)
// RevenueCat Dashboard → Integrations → Webhooks → Secret key → .env'e REVENUECAT_WEBHOOK_SECRET olarak ekle
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    // Gizli anahtar tanımlı değilse webhook kabul edilmez (aksi halde herkes sahte "satın alındı" gönderebilir)
    if (!secret) {
      console.warn('[WEBHOOK] REVENUECAT_WEBHOOK_SECRET tanımlı değil, istek reddedildi.');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    // RevenueCat panelindeki "Authorization header value" ile birebir aynı olmalı
    const auth = req.headers.authorization || '';
    const signature = req.headers['x-revenuecat-signature'];
    const hmacOk = signature && safeEqual(signature, crypto.createHmac('sha256', secret).update(JSON.stringify(req.body), 'utf8').digest('hex'));
    if (!(safeEqual(auth, secret) || safeEqual(auth, `Bearer ${secret}`) || hmacOk)) {
      console.warn('[WEBHOOK] Geçersiz yetki, istek reddedildi.');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ev = req.body?.event || {};
    const eventType = ev.type;
    // Olayın ilgilendirdiği tüm kimlikler (takma adlar ve hesap aktarımları dahil), yalnızca bizim kullanıcılarımız
    const ids = [...new Set([ev.app_user_id, ev.original_app_user_id, ...(ev.aliases || []),
      ...(ev.transferred_to || []), ...(ev.transferred_from || [])].filter(isOurUserId))];

    console.log('[WEBHOOK] RevenueCat olayı:', eventType, '| Kullanıcılar:', ids.join(',') || '-', '| Ortam:', ev.environment || '-');

    for (const userId of ids) {
      try {
        // Tercih: RevenueCat REST API'den güncel durumu oku (sıra dışı / tekrar gelen olaylara karşı en güvenilir yol)
        const applied = await applyRevenueCat(userId).catch((e) => {
          console.error('[WEBHOOK] RevenueCat REST hatası:', e.response?.status, e.message);
          return undefined;
        });
        if (applied !== null && applied !== undefined) {
          console.log(`[WEBHOOK] ${userId} → ${applied.isPremium ? `Premium (${applied.plan})` : 'Premium yok'}`);
        } else if (applied === null) {
          // REST anahtarı yoksa olayın kendisinden işle
          const expMs = Number(ev.expiration_at_ms);
          const expiryIso = expMs ? new Date(expMs).toISOString() : null;
          if (['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'].includes(eventType)
              && (!expiryIso || expMs > Date.now())) {
            const plan = planFromProduct(ev.new_product_id || ev.product_id, expiryIso);
            await grantPremium(userId, plan, expiryIso);
            console.log(`[WEBHOOK] ✅ ${userId} Premium (${plan})`);
          } else if (eventType === 'EXPIRATION') {
            await revokePremium(userId, expiryIso);
            console.log(`[WEBHOOK] ⚠️ ${userId} Premium sona erdi`);
          }
        } else {
          // REST geçici olarak başarısız: RevenueCat'in tekrar denemesi için hata dön
          return res.status(502).json({ success: false });
        }
        sendWsEvent(userId, { type: 'SUBSCRIPTION_UPDATED' });
      } catch (dbErr) {
        console.error('[WEBHOOK] DB hatası:', dbErr.message);
        return res.status(500).json({ success: false });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[WEBHOOK] İşlem hatası:', err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
module.exports.isPremiumActive = isPremiumActive;
