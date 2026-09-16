const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'yehsqn@gmail.com';

// Helper: Check if premium is active
function isPremiumActive(user) {
  if (!user) return false;
  if (user.role === 'admin' || user.email === ADMIN_EMAIL) return true;
  if (user.subscription_type === 'lifetime' || user.is_premium === 1) return true;
  if (user.subscription_type === 'free') return false;
  if (user.subscription_status !== 'active') return false;
  if (user.subscription_expiry && new Date(user.subscription_expiry) < new Date()) return false;
  return true;
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

    res.json({
      success: true,
      subscription: {
        type: user.subscription_type || 'free',
        status: user.subscription_status || 'active',
        expiry: user.subscription_expiry,
        isPremiumActive: isActive,
        aiAnalysisTokens: isActive ? 999 : (user.ai_analysis_tokens ?? 1),
        aiTokensResetAt: user.ai_tokens_reset_at
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/subscription/activate
router.post('/activate', async (req, res) => {
  try {
    const { userId, plan, durationMonths } = req.body;
    if (!userId || !plan) return res.status(400).json({ success: false, error: 'userId ve plan gerekli' });

    const validPlans = ['monthly', 'yearly'];
    if (!validPlans.includes(plan)) return res.status(400).json({ success: false, error: 'Geçersiz plan' });

    const now = new Date();
    const expiry = new Date(now);
    if (plan === 'monthly') {
      expiry.setMonth(expiry.getMonth() + (durationMonths || 1));
    } else {
      expiry.setFullYear(expiry.getFullYear() + 1);
    }

    await db.execute({
      sql: `UPDATE users SET subscription_type = ?, subscription_status = 'active', subscription_expiry = ?,
            subscription_plan = ?, is_premium = 1, premium_expires_at = ?, ai_analysis_tokens = 999
            WHERE id = ?`,
      args: [plan, expiry.toISOString(), plan, expiry.toISOString(), userId]
    });

    res.json({
      success: true,
      subscription: {
        type: plan,
        status: 'active',
        expiry: expiry,
        isPremiumActive: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
router.post('/admin/grant-premium', async (req, res) => {
  try {
    const { adminUserId, targetEmail, plan, durationMonths } = req.body;
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
    } else {
      expiry.setMonth(expiry.getMonth() + (durationMonths || 1));
    }

    await db.execute({
      sql: `UPDATE users SET
              subscription_type = ?,
              subscription_status = 'active',
              subscription_expiry = ?,
              is_premium = 1,
              premium_expires_at = ?,
              ai_analysis_tokens = 999
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
router.post('/admin/revoke-premium', async (req, res) => {
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
router.get('/admin/users', async (req, res) => {
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
    
    // İmza doğrulaması (secret ayarlandıysa)
    if (secret) {
      const signature = req.headers['x-revenuecat-signature'];
      if (!signature) {
        console.warn('[WEBHOOK] İmza başlığı eksik, istek reddedildi.');
        return res.status(401).json({ error: 'Missing signature' });
      }
      
      const crypto = require('crypto');
      const rawBody = JSON.stringify(req.body);
      const expected = crypto
        .createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');
      
      if (signature !== expected) {
        console.warn('[WEBHOOK] Geçersiz imza, istek reddedildi.');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const event = req.body;
    const eventType = event?.event?.type;
    const appUserId = event?.event?.app_user_id;
    
    console.log('[WEBHOOK] RevenueCat olayı:', eventType, '| Kullanıcı:', appUserId);

    // Aktif abonelik olayları
    if (appUserId && [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'PRODUCT_CHANGE',
      'UNCANCELLATION',
    ].includes(eventType)) {
      const periodType = event?.event?.period_type;
      const plan = periodType === 'ANNUAL' || periodType === 'NON_RECURRING' ? 'yearly' : 'monthly';
      
      try {
        await db.execute({
          sql: `UPDATE users SET
                  subscription_type = ?,
                  subscription_status = 'active',
                  is_premium = 1,
                  ai_analysis_tokens = 999
                WHERE id = ?`,
          args: [plan, appUserId]
        });
        console.log(`[WEBHOOK] ✅ Kullanıcı ${appUserId} premium aktifleştirildi (${plan})`);
      } catch (dbErr) {
        console.error('[WEBHOOK] DB hatası:', dbErr.message);
      }
    }

    // İptal / süresi dolan olaylar
    if (appUserId && [
      'CANCELLATION',
      'EXPIRATION',
      'SUBSCRIBER_ALIAS',
    ].includes(eventType)) {
      try {
        await db.execute({
          sql: `UPDATE users SET
                  subscription_status = 'expired',
                  is_premium = 0,
                  ai_analysis_tokens = 0
                WHERE id = ?`,
          args: [appUserId]
        });
        console.log(`[WEBHOOK] ⚠️ Kullanıcı ${appUserId} premium kaldırıldı (${eventType})`);
      } catch (dbErr) {
        console.error('[WEBHOOK] DB hatası:', dbErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[WEBHOOK] İşlem hatası:', err.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
