const { db } = require('../db/turso');

const FREE_PAYMENTS = 5;

// Ücretsiz plan yapay zekâ hakları; PRO ve deneme kullanıcılarında sınır yok
const AI_LIMITS = {
  analyze: { max: 1, period: 'all', error: 'Ücretsiz AI analiz hakkını kullandın.' },
  chat: { max: 3, period: 'day', error: 'Bugünkü ücretsiz AI mesaj hakkın doldu.' },
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

/** Hakkı varsa bir hak düşer ve true döner. Sayaç hatasında kullanıcı engellenmez. */
async function consumeAiQuota(userId, feature) {
  const limit = AI_LIMITS[feature];
  try {
    if (await userIsPremium(userId)) return true;
    const r = await db.execute({
      sql: `INSERT INTO ai_usage (user_id, feature, period, count) VALUES (?, ?, ?, 1)
            ON CONFLICT (user_id, feature, period) DO UPDATE SET count = count + 1 WHERE count < ?`,
      args: [userId, feature, periodKey(limit.period), limit.max],
    });
    return r.rowsAffected > 0;
  } catch (err) {
    console.error('[AI] Kullanım sayacı hatası:', err.message);
    return true;
  }
}

const aiLimitReached = (res, feature) =>
  res.status(403).json({ success: false, premiumRequired: true, code: 'AI_LIMIT', feature, error: AI_LIMITS[feature].error });

module.exports = { FREE_PAYMENTS, AI_LIMITS, userIsPremium, consumeAiQuota, aiLimitReached };
