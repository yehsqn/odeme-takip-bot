const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../db/turso');
const { sendToUser } = require('../websocket');
const { isPremiumActive } = require('./subscription');

const REWARD_DAYS = 7;
const MAX_REWARDS = 6; // davet eden kişi başına
const MIN_PAYMENTS = 3; // sahte hesapla ödül toplamayı zorlaştırır
const REDEEM_WINDOW_DAYS = 14;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const newCode = () => Array.from(crypto.randomBytes(8), b => ALPHABET[b % ALPHABET.length]).join('');

async function codeFor(userId) {
  const found = await db.execute({ sql: 'SELECT code FROM referral_codes WHERE user_id = ?', args: [userId] });
  if (found.rows[0]) return found.rows[0].code;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const r = await db.execute({ sql: 'INSERT OR IGNORE INTO referral_codes (user_id, code) VALUES (?, ?)', args: [userId, code] });
    if (r.rowsAffected > 0) return code;
  }
  throw new Error('Davet kodu üretilemedi');
}

/** PRO günü ekler. Ücretli abonelik RevenueCat'e bağlı olduğundan süresine dokunulmaz. */
async function addBonusDays(userId) {
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] })).rows[0];
  if (!u || u.subscription_type === 'lifetime' || u.role === 'admin') return false;
  if (isPremiumActive(u) && ['monthly', 'yearly'].includes(u.subscription_type)) return false;
  const current = u.subscription_expiry ? new Date(u.subscription_expiry).getTime() : 0;
  const expiry = new Date(Math.max(current, Date.now()) + REWARD_DAYS * 86400000).toISOString();
  await db.execute({
    sql: `UPDATE users SET subscription_type = 'referral', subscription_plan = 'referral', subscription_status = 'active',
            subscription_expiry = ?, premium_expires_at = ?, is_premium = 1, ai_analysis_tokens = 999,
            subscription_source = 'referral' WHERE id = ?`,
    args: [expiry, expiry, userId],
  });
  return true;
}

// GET /api/referral — Davet kodu ve durum
router.get('/', async (req, res) => {
  try {
    const userId = req.authUserId;
    const [code, invited, redeemed] = await Promise.all([
      codeFor(userId),
      db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM referrals WHERE inviter_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT 1 FROM referrals WHERE invitee_id = ?', args: [userId] }),
    ]);
    res.json({
      success: true, code, invited: Number(invited.rows[0]?.cnt || 0),
      redeemed: redeemed.rows.length > 0, rewardDays: REWARD_DAYS, maxRewards: MAX_REWARDS, minPayments: MIN_PAYMENTS,
    });
  } catch (err) {
    console.error('[REFERRAL] Durum hatası:', err.message);
    res.status(500).json({ success: false, error: 'Davet bilgisi alınamadı.' });
  }
});

// POST /api/referral/redeem — Yeni kullanıcı davet kodunu girer, iki taraf da PRO günü kazanır
router.post('/redeem', async (req, res) => {
  try {
    const userId = req.authUserId;
    const code = String(req.body?.code || '').trim().toUpperCase();
    const fail = (error) => res.status(400).json({ success: false, error });
    if (!/^[A-Z2-9]{8}$/.test(code)) return fail('Davet kodu geçersiz.');

    const owner = (await db.execute({ sql: 'SELECT user_id FROM referral_codes WHERE code = ?', args: [code] })).rows[0];
    if (!owner) return fail('Davet kodu geçersiz.');
    if (owner.user_id === userId) return fail('Kendi davet kodunu kullanamazsın.');

    const me = (await db.execute({ sql: 'SELECT email_verified, created_at, is_banned FROM users WHERE id = ?', args: [userId] })).rows[0];
    if (!me || Number(me.is_banned) === 1) return fail('Davet kodu kullanılamıyor.');
    if (Number(me.email_verified) === 0) return fail('Önce e-posta adresini doğrulamalısın.');
    if (!me.created_at || Date.now() - new Date(String(me.created_at).replace(' ', 'T') + (String(me.created_at).includes('T') ? '' : 'Z')).getTime() > REDEEM_WINDOW_DAYS * 86400000) {
      return fail(`Davet kodu kayıttan sonraki ${REDEEM_WINDOW_DAYS} gün içinde girilebilir.`);
    }
    const payments = Number((await db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM payments WHERE user_id = ?', args: [userId] })).rows[0]?.cnt || 0);
    if (payments < MIN_PAYMENTS) return fail(`Davet kodunu girmek için önce ${MIN_PAYMENTS} ödeme eklemelisin.`);

    const used = Number((await db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM referrals WHERE inviter_id = ?', args: [owner.user_id] })).rows[0]?.cnt || 0);
    if (used >= MAX_REWARDS) return fail('Bu davet kodunun kullanım sınırı doldu.');

    const ins = await db.execute({ sql: 'INSERT OR IGNORE INTO referrals (invitee_id, inviter_id) VALUES (?, ?)', args: [userId, owner.user_id] });
    if (ins.rowsAffected === 0) return fail('Daha önce davet kodu kullandın.');

    const [mine, theirs] = [await addBonusDays(userId), await addBonusDays(owner.user_id)];
    sendToUser(owner.user_id, {
      type: 'REFERRAL_REWARD',
      title: '🎁 Davetin kabul edildi',
      body: theirs ? `Bir arkadaşın katıldı, ${REWARD_DAYS} gün PRO kazandın.` : 'Bir arkadaşın davetinle katıldı. Teşekkürler!',
    }).catch(() => {});
    res.json({ success: true, rewarded: mine, rewardDays: REWARD_DAYS });
  } catch (err) {
    console.error('[REFERRAL] Kod hatası:', err.message);
    res.status(500).json({ success: false, error: 'Davet kodu kullanılamadı.' });
  }
});

module.exports = router;
