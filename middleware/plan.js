const { db } = require('../db/turso');

const FREE_PAYMENTS = 5;

// Ücretsiz plan yapay zekâ hakları. premiumMax tanımlı özellikte PRO ve deneme kullanıcılarına
// günlük adil kullanım sınırı uygulanır; diğerlerinde PRO sınırsızdır.
const AI_LIMITS = {
  analyze: { max: 1, period: 'all', error: 'Ücretsiz AI analiz hakkını kullandın.' },
  chat: {
    max: 5, period: 'all', error: "Ücretsiz 5 soru hakkını kullandın. Sınırsız sohbet için Premium'a geçebilirsin.",
    premiumMax: 100, premiumError: 'Bugünkü 100 mesajlık adil kullanım sınırına ulaştın. Yarın yeniden sorabilirsin.',
  },
  parse: { max: 5, period: 'day', error: 'Bugünkü ücretsiz AI ile ödeme ekleme hakkın doldu.' },
  statement: { max: 2, period: 'month', error: 'Bu ayki ücretsiz ekstre okuma hakkın doldu.' },
};

const periodKey = (period) => {
  if (period === 'all') return 'all';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  return period === 'month' ? day.slice(0, 7) : day;
};

async function userIsPremium(userId) {
  const { isPremiumActive } = require('../routes/subscription');
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] })).rows[0];
  return isPremiumActive(u);
}

const noRefund = async () => {};

// PRO sayacı ücretsiz sayaçtan ayrı tutulur; abonelik bitince ücretsiz hak kaldığı yerden devam eder
function counterFor(feature, premium) {
  const limit = AI_LIMITS[feature];
  return premium
    ? { key: `${feature}:premium`, period: periodKey('day'), max: limit.premiumMax }
    : { key: feature, period: periodKey(limit.period), max: limit.max };
}

/**
 * Hakkı varsa bir hak düşer: { ok, premium, remaining, refund }. remaining PRO'da null.
 * Sayma tek komutla yapılır; aynı anda gelen istekler sınırı aşamaz. Sayaç hatasında kullanıcı engellenmez.
 */
async function consumeAiQuota(userId, feature) {
  const limit = AI_LIMITS[feature];
  let premium = false;
  try {
    premium = await userIsPremium(userId);
    if (premium && !limit.premiumMax) return { ok: true, premium, remaining: null, refund: noRefund };
    const { key, period, max } = counterFor(feature, premium);
    const r = await db.execute({
      sql: `INSERT INTO ai_usage (user_id, feature, period, count) VALUES (?, ?, ?, 1)
            ON CONFLICT (user_id, feature, period) DO UPDATE SET count = count + 1 WHERE count < ?
            RETURNING count`,
      args: [userId, key, period, max],
    });
    if (!r.rows.length) return { ok: false, premium, remaining: 0, refund: noRefund };
    let refunded = false;
    const refund = async () => {
      if (refunded) return;
      refunded = true;
      await db.execute({
        sql: 'UPDATE ai_usage SET count = count - 1 WHERE user_id = ? AND feature = ? AND period = ? AND count > 0',
        args: [userId, key, period],
      }).catch(err => console.error('[AI] Hak iadesi yapılamadı:', err.message));
    };
    return { ok: true, premium, remaining: premium ? null : Math.max(0, max - Number(r.rows[0].count)), refund };
  } catch (err) {
    console.error('[AI] Kullanım sayacı hatası:', err.message);
    return { ok: true, premium, remaining: null, refund: noRefund };
  }
}

/** Kalan hak: { premium, max, used, remaining }; PRO'da günlük adil kullanım sayacı döner. */
async function getAiQuota(userId, feature) {
  const premium = await userIsPremium(userId);
  const { key, period, max } = counterFor(feature, premium);
  if (max == null) return { premium, max: null, used: 0, remaining: null };
  const row = (await db.execute({
    sql: 'SELECT count FROM ai_usage WHERE user_id = ? AND feature = ? AND period = ?',
    args: [userId, key, period],
  })).rows[0];
  const used = Number(row?.count || 0);
  return { premium, max, used, remaining: Math.max(0, max - used) };
}

// PRO kullanıcının adil kullanım sınırında satın alma ekranı açılmaz
const aiLimitReached = (res, feature, quota) =>
  quota?.premium
    ? res.status(429).json({ success: false, code: 'AI_DAILY_LIMIT', feature, remaining: 0, error: AI_LIMITS[feature].premiumError })
    : res.status(403).json({ success: false, premiumRequired: true, code: 'AI_LIMIT', feature, remaining: 0, error: AI_LIMITS[feature].error });

module.exports = { FREE_PAYMENTS, AI_LIMITS, userIsPremium, consumeAiQuota, getAiQuota, aiLimitReached };
