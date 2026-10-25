/**
 * POST /api/ai/monthly-report { month?: 'yyyy-MM' } — Premium
 * Ay sonu finans raporu: harcama özeti, geçen aya göre fark, 3 somut tasarruf önerisi.
 *
 * - Rakamlar istemciden değil veritabanından hesaplanır.
 * - Yapay zekâya ödeme adları gönderilmez; yalnızca kategori toplamları ve sayılar.
 * - Rapor (kullanıcı, ay) için saklanır; 6 saatten önce yeniden üretilmez (kota koruması).
 */
const { db } = require('../db/turso');
const { isPremiumActive } = require('./subscription');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const REGEN_MS = 6 * 3600 * 1000;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const tl = (n) => `${Math.round(n).toLocaleString('tr-TR')} TL`;

function prevMonthKey(d = new Date()) {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
}
const shiftMonth = (key, k) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthOf = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const categoryOf = (row) => {
  if (row.type === 'bill') return row.category || 'Fatura';
  if (row.type === 'check') return 'Çek';
  if (row.type === 'promissory_note') return 'Senet';
  return 'Kredi kartı';
};

async function buildStats(userId, month) {
  const [pay, inc] = await Promise.all([
    db.execute({ sql: 'SELECT type, category, installment_plan FROM payments WHERE user_id = ?', args: [userId] }),
    db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
  ]);
  const prev = shiftMonth(month, -1);
  const now = new Date();
  const s = { month, total: 0, paid: 0, overdueCount: 0, count: 0, prevTotal: 0, byCategory: {}, income: 0, prevIncome: 0, nextMonthLoad: 0 };
  pay.rows.forEach(row => {
    let plan = [];
    try { plan = JSON.parse(row.installment_plan || '[]'); } catch { plan = []; }
    plan.forEach(inst => {
      const mk = monthOf(inst.date);
      const amt = Number(inst.amount) || 0;
      if (mk === month) {
        s.total += amt; s.count++;
        if (inst.isPaid) s.paid += amt;
        else if (new Date(inst.date) < now) s.overdueCount++;
        const c = categoryOf(row);
        s.byCategory[c] = (s.byCategory[c] || 0) + amt;
      } else if (mk === prev) s.prevTotal += amt;
      else if (mk === shiftMonth(month, 1)) s.nextMonthLoad += amt;
    });
  });
  // Not: other_income sütununda elle girilen GİDER tutulur; gelire katılmaz
  const extraOf = (r) => { try { return JSON.parse(r.extra || '{}') || {}; } catch { return {}; } };
  const rowIncome = (r, salaryOrCc) => {
    const x = extraOf(r);
    return (Number(r.cash) || 0) + salaryOrCc + (Number(x.eft) || 0) + (Number(x.checkIncome) || 0);
  };
  const sumIncome = (key) => {
    const [y, m] = key.split('-');
    const override = inc.rows.find(r => r.date === `income_${y}_${m}`);
    const daily = inc.rows.filter(r => String(r.date).startsWith(`${key}-`))
      .reduce((t, r) => t + rowIncome(r, (Number(r.cc) || 0) + (Number(r.salary) || 0)), 0);
    if (!override) return daily;
    return rowIncome(override, Number(override.salary) || Number(override.cc) || 0) || daily;
  };
  s.income = sumIncome(month);
  s.prevIncome = sumIncome(prev);
  s.byCategory = Object.fromEntries(Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [clip(k, 40), Math.round(v)]));
  ['total', 'paid', 'prevTotal', 'income', 'prevIncome', 'nextMonthLoad'].forEach(k => { s[k] = Math.round(s[k]); });
  return s;
}

/** Yapay zekâ yoksa / hata verirse: kurallı, uydurmasız rapor */
function localReport(s) {
  const diff = s.prevTotal ? Math.round(((s.total - s.prevTotal) / s.prevTotal) * 100) : null;
  const top = Object.entries(s.byCategory)[0];
  const tips = [];
  if (top) tips.push(`En büyük kalem ${top[0]} (${tl(top[1])}). Bu kalemde %10 azaltma ayda yaklaşık ${tl(top[1] * 0.1)} kazandırır.`);
  if (s.overdueCount) tips.push(`${s.overdueCount} gecikmiş taksitin var; gecikme faizinden kaçınmak için önce bunları kapat.`);
  if (s.nextMonthLoad > s.total) tips.push(`Gelecek ay ödemelerin ${tl(s.nextMonthLoad)}, bu aydan fazla; şimdiden pay ayır.`);
  if (s.income && s.total / s.income > 0.5) tips.push(`Ödemeler gelirinin %${Math.round((s.total / s.income) * 100)}'i; yeni taksit almadan önce mevcutları azalt.`);
  while (tips.length < 3) tips.push('Her ay gelirinin en az %10\'unu ödemelerden önce birikime ayır.');
  return {
    summary: `${s.month} ayında ${s.count} ödeme, toplam ${tl(s.total)}; bunun ${tl(s.paid)} kadarı ödendi.${s.income ? ` Gelir: ${tl(s.income)}.` : ''}`,
    comparison: diff === null ? 'Geçen ay için karşılaştırılacak veri yok.' : `Geçen aya göre ödemeler %${Math.abs(diff)} ${diff >= 0 ? 'arttı' : 'azaldı'} (${tl(s.prevTotal)} → ${tl(s.total)}).`,
    tips: tips.slice(0, 3),
  };
}

module.exports = function makeMonthlyReportHandler(requestGemini, hasKey) {
  return async (req, res) => {
    try {
      const userId = req.authUserId;
      const user = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] })).rows[0];
      if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });
      if (!isPremiumActive(user)) return res.status(403).json({ success: false, premiumRequired: true, error: 'AI aylık rapor Premium özelliğidir.' });

      const month = MONTH_RE.test(String(req.body?.month || '')) ? req.body.month : prevMonthKey();
      const refresh = req.body?.refresh === true;

      const cached = (await db.execute({ sql: 'SELECT * FROM ai_reports WHERE user_id = ? AND month = ?', args: [userId, month] })).rows[0];
      if (cached && (!refresh || Date.now() - Date.parse(cached.created_at) < REGEN_MS)) {
        return res.json({ success: true, cached: true, month, ...JSON.parse(cached.data) });
      }

      const stats = await buildStats(userId, month);
      let report = null, source = 'local';
      if (stats.count && hasKey()) {
        const prompt = `Sen PayPulse uygulamasının Türkçe finans asistanısın. Aşağıdaki aylık özet verisine göre kısa bir rapor yaz.
Sadece verilen sayıları kullan, sayı uydurma. Samimi ama net ol. Yalnızca şu JSON'u döndür:
{"summary": "en fazla 3 cümle ay özeti", "comparison": "geçen aya göre fark, 1-2 cümle", "tips": ["somut tasarruf önerisi 1", "öneri 2", "öneri 3"]}
VERİ (TL): ${JSON.stringify(stats)}`;
        try {
          const { response } = await requestGemini({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 800, responseMimeType: 'application/json' },
          });
          const raw = (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
          const j = JSON.parse(raw.replace(/^```json\s*/, '').replace(/```$/, '').trim());
          const tips = Array.isArray(j.tips) ? j.tips.map(t => clip(t, 220)).filter(Boolean).slice(0, 3) : [];
          if (clip(j.summary, 10) && tips.length) {
            report = { summary: clip(j.summary, 500), comparison: clip(j.comparison, 300), tips };
            source = 'ai';
          }
        } catch (e) {
          console.warn('[AI] Aylık rapor yapay zekâ hatası, yerel rapora dönülüyor:', e.message);
        }
      }
      if (!report) report = localReport(stats);
      const data = { ...report, stats, source };
      await db.execute({
        sql: `INSERT INTO ai_reports (user_id, month, data, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, month) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
        args: [userId, month, JSON.stringify(data), new Date().toISOString()],
      });
      res.json({ success: true, cached: false, month, ...data });
    } catch (err) {
      console.error('[AI] Aylık rapor hatası:', err.message);
      res.status(500).json({ success: false, error: 'Rapor oluşturulamadı.' });
    }
  };
};
module.exports.localReport = localReport;
