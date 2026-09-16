const express = require('express');
const router = express.Router();
const axios = require('axios');
const { db } = require('../db/turso');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';

// Cache per user (10 min)
const analysisCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// --- Financial context builder ---
function buildFinancialContext(payments, dailyIncomes, settings) {
  const now = new Date();
  const monthlyTotals = {};
  const bankTotals = {};
  const categoryTotals = {};

  for (const payment of payments) {
    const installments = payment.installmentPlan || [];
    for (const inst of installments) {
      if (!inst.date && !inst.dueDate) continue;
      const due = new Date(inst.date || inst.dueDate);
      const key = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}`;
      monthlyTotals[key] = (monthlyTotals[key] || 0) + (inst.amount || 0);
      bankTotals[payment.bank || payment.title || 'Diğer'] =
        (bankTotals[payment.bank || payment.title || 'Diğer'] || 0) + (inst.amount || 0);
      const cat = payment.category || 'Diğer';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (inst.amount || 0);
    }
  }

  const projections = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    projections.push({ month: key, totalDebt: Math.round(monthlyTotals[key] || 0) });
  }

  const incomeMap = {};
  for (const [date, data] of Object.entries(dailyIncomes || {})) {
    const d = new Date(date);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const total = (data.cash || 0) + (data.cc || 0) + (data.salary || 0) +
      (data.insurance || 0) + (data.other || 0);
    incomeMap[key] = (incomeMap[key] || 0) + total;
  }

  const monthlyIncomes = Object.values(incomeMap);
  const avgMonthlyIncome = monthlyIncomes.length
    ? Math.round(monthlyIncomes.reduce((a, b) => a + b, 0) / monthlyIncomes.length)
    : 0;

  let totalRemainingDebt = 0;
  for (const payment of payments) {
    for (const inst of (payment.installmentPlan || [])) {
      if (!inst.isPaid) totalRemainingDebt += inst.amount || 0;
    }
  }
  totalRemainingDebt = Math.round(totalRemainingDebt);

  const banks = settings?.banks || [];

  return {
    totalActivePayments: payments.length,
    totalMonthlyDebt: projections[0]?.totalDebt || 0,
    totalRemainingDebt,
    avgMonthlyIncome,
    projections,
    bankBreakdown: Object.entries(bankTotals)
      .map(([bank, total]) => ({ bank, totalDebt: Math.round(total) }))
      .sort((a, b) => b.totalDebt - a.totalDebt)
      .slice(0, 5),
    categoryBreakdown: Object.entries(categoryTotals)
      .map(([category, total]) => ({ category, totalSpent: Math.round(total) }))
      .sort((a, b) => b.totalSpent - a.totalSpent),
    banks: banks.map(b => ({
      name: b.bankName || b.name,
      statementDay: b.statementDay,
      dueDay: b.dueDay
    }))
  };
}

// --- Prompt builder ---
function buildPrompt(context, rates, language = 'tr') {
  const isEn = language === 'en';

  const rateInfo = rates
    ? `\n## Current Exchange Rates:\n- USD/TRY: ${rates.USD || '?'} TL\n- EUR/TRY: ${rates.EUR || '?'} TL\n`
    : '';

  const langInstruction = isEn
    ? 'Your response MUST be strictly in English.'
    : 'Yanıtın mutlaka Türkçe olmalıdır.';

  return `System Role: You are a professional "AI Financial Coach" for a high-end fintech application. Your goal is to analyze the user's payment data and provide strategic, actionable financial insights.

Task: Analyze the provided JSON data and generate a comprehensive financial report strictly in ${isEn ? 'English' : 'Turkish'}. ${langInstruction}

Response Format (Strict JSON):
You must return the analysis in a valid JSON format with the following keys:

- summary: A 2-sentence executive summary of the overall financial health.
- riskScore: A number between 0-100 (0: safe, 100: critical debt).
- riskLevel: One of ["low", "medium", "high", "critical"].
- riskReason: Why this score was given.
- alerts: An array of objects with {type: "warning/danger/info/success", title: "string", message: "string", icon: "💳/📈/⚠️/💰/🎯/✅"}.
- cardStrategy: An object with {recommendation: "string", bank: "string", savingDays: number} suggesting which bank card to use for the next purchase based on statement dates.
- monthlyProjections: An array of {month: "string", totalDebt: number, riskFlag: boolean} for the next 6 months.
- categoryInsights: An array of {category: "string", totalSpent: number, assessment: "normal/high/very high", tip: "string"}.
- savingsTips: A list of 3-5 specific tips to reduce debt.

Financial Logic Rules:
1. Overdue Status: If a payment's dueDate has passed and isPaid is false, flag it as a critical priority.
2. Statement Cycle: Suggest using the card whose statement date has just passed to maximize the grace period.
3. Debt Density: Check if the debt in any single month exceeds 40% of the total 6-month debt.

User Data to Analyze:
${JSON.stringify(context, null, 2)}
${rateInfo}
IMPORTANT: Respond ONLY with valid JSON. Do not include any explanation, markdown, or text outside the JSON object.`;
}

// --- Local fallback analysis ---
function buildLocalAnalysis(context, userId, language = 'tr') {
  const isEn = language === 'en';
  const { totalMonthlyDebt, totalRemainingDebt, avgMonthlyIncome, projections, bankBreakdown, categoryBreakdown, banks } = context;

  const monthlyDebt = totalMonthlyDebt > 0 ? totalMonthlyDebt : Math.round((totalRemainingDebt || 0) / 12);
  const ratio = avgMonthlyIncome > 0 ? monthlyDebt / avgMonthlyIncome : (monthlyDebt > 0 ? 0.6 : 0);
  let riskScore, riskLevel, riskReason;

  if (ratio < 0.3) {
    riskScore = Math.round(ratio * 100);
    riskLevel = isEn ? 'low' : 'düşük';
    riskReason = isEn ? 'Your monthly debt/income ratio is low.' : 'Aylık borç/gelir oranınız düşük, sağlıklı görünüyor.';
  } else if (ratio < 0.5) {
    riskScore = Math.round(30 + ratio * 40);
    riskLevel = isEn ? 'medium' : 'orta';
    riskReason = isEn ? 'Reasonable ratio, but caution advised.' : 'Aylık borç/gelir oranınız makul, dikkatli olunmalı.';
  } else if (ratio < 0.8) {
    riskScore = Math.round(50 + ratio * 30);
    riskLevel = isEn ? 'high' : 'yüksek';
    riskReason = isEn ? 'Monthly debts exceed 50% of income.' : 'Aylık borçlarınız gelirinizin %50\'sini aşıyor.';
  } else {
    riskScore = Math.min(95, Math.round(75 + ratio * 15));
    riskLevel = isEn ? 'critical' : 'kritik';
    riskReason = isEn ? 'Debt load is critical — take action.' : 'Borç yükünüz kritik — acil önlem alınmalı.';
  }

  const alerts = [];
  if (ratio > 0.5) alerts.push({ type: 'danger', title: isEn ? 'High Debt Ratio' : 'Yüksek Borç Oranı', message: isEn ? `Monthly debt is ${Math.round(ratio * 100)}% of income.` : `Aylık borcunuz gelirinizin %${Math.round(ratio * 100)}'ini oluşturuyor.`, icon: '⚠️' });
  if (projections.some(p => p.totalDebt > totalMonthlyDebt * 1.2)) alerts.push({ type: 'warning', title: isEn ? 'High Installment Month' : 'Yüksek Taksit Ayı', message: isEn ? 'Some months have above-normal payments.' : 'Önümüzdeki aylarda yüksek ödeme aylarınız var.', icon: '📈' });
  if (bankBreakdown.length > 2) alerts.push({ type: 'info', title: isEn ? 'Multiple Banks' : 'Çok Banka', message: isEn ? `Paying ${bankBreakdown.length} banks — consider consolidation.` : `${bankBreakdown.length} farklı bankaya ödeme yapıyorsunuz.`, icon: '💳' });
  if (alerts.length === 0) alerts.push({ type: 'success', title: isEn ? 'General Status Good' : 'Genel Durum İyi', message: isEn ? 'Financial outlook looks healthy.' : 'Finansal tablonuz sağlıklı görünüyor.', icon: '✅' });

  let cardStrategy = { recommendation: isEn ? 'Use the card with the latest statement date.' : 'Son kesim tarihli kartı kullanın.', bank: bankBreakdown[0]?.bank || '-', savingDays: 20 };
  if (banks && banks.length > 0) {
    const sorted = [...banks].sort((a, b) => (b.dueDay || 0) - (a.dueDay || 0));
    const best = sorted[0];
    if (best) {
      const saving = best.dueDay ? best.dueDay - (best.statementDay || 1) : 20;
      cardStrategy = { recommendation: isEn ? `${best.name || 'Best card'} — extends payment period.` : `${best.name || 'En avantajlı kart'} — ödeme sürenizi uzatır.`, bank: best.name || '-', savingDays: Math.max(saving, 1) };
    }
  }

  const categoryInsights = (categoryBreakdown || []).slice(0, 5).map(c => {
    const monthlyAvg = c.totalSpent / Math.max(projections.length, 1);
    const assessment = monthlyAvg > avgMonthlyIncome * 0.3 ? (isEn ? 'very high' : 'çok yüksek') : monthlyAvg > avgMonthlyIncome * 0.15 ? (isEn ? 'high' : 'yüksek') : 'normal';
    return { category: c.category, totalSpent: c.totalSpent, assessment, tip: assessment !== 'normal' ? (isEn ? `${c.category} spending is high.` : `${c.category} harcamalarınız yüksek.`) : (isEn ? `${c.category} spending is reasonable.` : `${c.category} harcamalarınız makul.`) };
  });

  const savingsTips = isEn ? [
    'Close high-interest debts first.',
    'Save at least 10% of monthly income.',
    bankBreakdown.length > 1 ? `Focus extra payments on "${bankBreakdown[0]?.bank}".` : 'Prefer lump sum over more installments.'
  ] : [
    'Yüksek faizli borçları önce kapatın.',
    'Her ay gelirinizin en az %10\'unu ayırın.',
    bankBreakdown.length > 1 ? `"${bankBreakdown[0]?.bank}" için ekstra ödeme yapın.` : 'Taksit yerine toplu ödeme tercih edin.'
  ];

  return {
    riskScore, riskLevel, riskReason,
    monthlyProjections: projections.map(p => ({ month: p.month, totalDebt: p.totalDebt, riskFlag: p.totalDebt > (monthlyDebt || 1) * 1.1 })),
    alerts, cardStrategy, categoryInsights, savingsTips,
    summary: totalRemainingDebt > 0
      ? (isEn ? `Total remaining debt: ${totalRemainingDebt.toLocaleString('en-US')} TL. ${riskReason}` : `Toplam kalan borç: ${totalRemainingDebt.toLocaleString('tr-TR')} TL. ${riskReason}`)
      : (isEn ? 'No payment records found.' : 'Ödeme kaydı bulunamadı.'),
    context, source: 'local'
  };
}

// --- Helper: format payment row to frontend format ---
function formatPayment(row) {
  return {
    _id: row.id,
    id: row.payment_id || row.id,
    title: row.title,
    amount: row.amount,
    bank: row.bank,
    category: row.category,
    type: row.type,
    installmentPlan: JSON.parse(row.installment_plan || '[]'),
    currency: row.currency || 'TRY',
  };
}

// GET /api/ai/analyze?userId=xxx&force=false&lang=tr
router.get('/analyze', async (req, res) => {
  try {
    const { userId, force, lang } = req.query;
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const language = lang || 'tr';
    const forceRefresh = force === 'true';
    const cacheKey = `${userId}_${language}`;

    // Check cache
    if (!forceRefresh) {
      const cached = analysisCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        console.log(`[AI] Cache hit for ${userId} [${language}]`);
        return res.json({ success: true, ...cached.result });
      }
    } else {
      analysisCache.delete(cacheKey);
    }

    // Fetch user data from Turso
    const [paymentsResult, settingsResult, incomesResult] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM payments WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
      db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
    ]);

    const payments = paymentsResult.rows.map(formatPayment);
    const settings = settingsResult.rows[0] ? {
      banks: JSON.parse(settingsResult.rows[0].banks || '[]'),
      cutOffDay: settingsResult.rows[0].cut_off_day,
    } : {};

    // Build dailyIncomes object
    const dailyIncomes = {};
    incomesResult.rows.forEach(d => {
      dailyIncomes[d.date] = {
        cash: d.cash || 0, cc: d.cc || 0, salary: d.salary || 0,
        insurance: d.insurance || 0, other: d.other_income || 0,
        expenses: JSON.parse(d.expenses || '[]')
      };
    });

    // Fetch exchange rates
    let rates = null;
    try {
      const rateRes = await axios.get('https://api.genelpara.com/embed/para-birimleri.json', { timeout: 5000 });
      const rd = rateRes.data;
      rates = { USD: parseFloat(rd?.USD?.satis) || 0, EUR: parseFloat(rd?.EUR?.satis) || 0 };
    } catch (e) {
      console.warn('[AI] Could not fetch rates:', e.message);
    }

    // Build context
    const context = buildFinancialContext(payments, dailyIncomes, settings);

    // Try Gemini API
    if (!GEMINI_API_KEY) {
      console.warn('[AI] No GEMINI_API_KEY — using local analysis');
      const result = buildLocalAnalysis(context, userId, language);
      analysisCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return res.json({ success: true, ...result });
    }

    const prompt = buildPrompt(context, rates, language);

    try {
      const response = await axios.post(
        `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: 'application/json' }
        },
        { timeout: 30000 }
      );

      const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Empty Gemini response');

      const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      const result = { ...JSON.parse(cleaned), context, source: 'gemini' };
      analysisCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      console.log(`[AI] Gemini analysis cached for ${userId} [${language}]`);
      return res.json({ success: true, ...result });

    } catch (geminiErr) {
      console.warn('[AI] Gemini error — local fallback:', geminiErr.message);
      const result = buildLocalAnalysis(context, userId, language);
      analysisCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return res.json({ success: true, ...result });
    }

  } catch (err) {
    console.error('[AI] Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
