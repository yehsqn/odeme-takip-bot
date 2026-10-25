const express = require('express');
const router = express.Router();
const axios = require('axios');
const { db } = require('../db/turso');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'];

async function requestGemini(body) {
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await axios.post(url, body, { timeout: 25000 });
      return { response, model };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      console.warn(`[AI] Model ${model} failed (${status || err.message}), trying next...`);
      if (status === 404 || status === 503 || status === 429) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

// Cache per user (10 min)
const analysisCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

// --- Financial context builder ---
function buildFinancialContext(payments, dailyIncomes, settings) {
  const now = new Date();
  const monthlyTotals = {};
  const bankTotals = {};
  const categoryTotals = {};

  const safePayments = Array.isArray(payments) ? payments : [];

  for (const payment of safePayments) {
    const installments = Array.isArray(payment.installmentPlan) && payment.installmentPlan.length > 0
      ? payment.installmentPlan
      : [{
        amount: Number(payment.amount || payment.originalAmount || 0),
        date: payment.date || payment.dueDate || new Date().toISOString(),
        isPaid: Boolean(payment.isPaid)
      }];

    for (const inst of installments) {
      const instDate = inst.date || inst.dueDate || payment.date || new Date().toISOString();
      const due = new Date(instDate);
      if (!isNaN(due.getTime())) {
        const key = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}`;
        monthlyTotals[key] = (monthlyTotals[key] || 0) + (Number(inst.amount) || 0);
      }
      const bankName = payment.bank || payment.title || 'Diğer';
      bankTotals[bankName] = (bankTotals[bankName] || 0) + (Number(inst.amount) || 0);
      const cat = payment.category || 'Diğer';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + (Number(inst.amount) || 0);
    }
  }



  const incomeMap = {};
  for (const [date, data] of Object.entries(dailyIncomes || {})) {
    const d = new Date(date);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    
    // Calculate total income (cash + cc + salary + insurance)
    const totalIncome = (Number(data.cash) || 0) + (Number(data.cc) || 0) + (Number(data.salary) || 0) + (Number(data.insurance) || 0);
    incomeMap[key] = (incomeMap[key] || 0) + totalIncome;

    // 'other' is used for manual expenses. Add it to monthly debts!
    const manualExpense = Number(data.other) || 0;
    monthlyTotals[key] = (monthlyTotals[key] || 0) + manualExpense;
  }

  const projections = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    projections.push({ month: key, totalDebt: Math.round(monthlyTotals[key] || 0) });
  }

  const monthlyIncomes = Object.values(incomeMap);
  const avgMonthlyIncome = monthlyIncomes.length
    ? Math.round(monthlyIncomes.reduce((a, b) => a + b, 0) / monthlyIncomes.length)
    : 0;

  let totalRemainingDebt = 0;
  for (const payment of safePayments) {
    const installments = Array.isArray(payment.installmentPlan) && payment.installmentPlan.length > 0
      ? payment.installmentPlan
      : [{
        amount: Number(payment.amount || payment.originalAmount || 0),
        isPaid: Boolean(payment.isPaid)
      }];

    for (const inst of installments) {
      if (!inst.isPaid) {
        totalRemainingDebt += (Number(inst.amount) || 0);
      }
    }
  }
  totalRemainingDebt = Math.round(totalRemainingDebt);

  // Manuel giderleri (dailyIncomes.other) de toplam borça ekle
  let totalManualExpenses = 0;
  for (const data of Object.values(dailyIncomes || {})) {
    totalManualExpenses += (Number(data.other) || 0);
  }
  totalRemainingDebt = Math.round(totalRemainingDebt + totalManualExpenses);

  const banks = settings?.banks || [];

  let debtToIncomeRatio = 0;
  if (avgMonthlyIncome > 0) {
    debtToIncomeRatio = (projections[0]?.totalDebt || 0) / avgMonthlyIncome;
  } else if ((projections[0]?.totalDebt || 0) > 0) {
    debtToIncomeRatio = (projections[0]?.totalDebt || 0); // Effectively setting denominator to 1
  }
  const debtToIncomeRatioPercentage = Math.round(debtToIncomeRatio * 100);

  return {
    totalActivePayments: safePayments.length,
    totalMonthlyDebt: projections[0]?.totalDebt || 0,
    totalRemainingDebt,
    avgMonthlyIncome,
    debtToIncomeRatio,
    debtToIncomeRatioPercentage,
    projections,
    recentPayments: safePayments.slice(0, 15).map(p => ({
      title: p.title || 'Ödeme',
      amount: Number(p.amount || p.originalAmount || 0),
      bank: p.bank || 'Diğer',
      category: p.category || 'Diğer',
      date: p.date,
      installments: p.installments || 1,
      isPaid: Boolean(p.isPaid)
    })),
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
    ? `\n## Current Exchange Rates:\n- USD/TRY: ${rates.USD || '?'} TL\n- EUR/TRY: ${rates.EUR || '?'} TL\n- Gram Altin/TRY: ${rates.GA || '?'} TL\n- Ceyrek Altin/TRY: ${rates.C || '?'} TL\n`
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

IMPORTANT RULES FOR CALCULATIONS:
- DO NOT perform your own percentage math for Debt-to-Income.
- ALWAYS use the provided \`debtToIncomeRatioPercentage\` (${context.debtToIncomeRatioPercentage}%).
- For example, if debtToIncomeRatioPercentage is 25000, explicitly say "Aylık borcunuz gelirinizin %25000'i kadardır" (or "Your monthly debt is 25000% of your income"). Do NOT invent numbers like 73%.

IMPORTANT: Respond ONLY with valid JSON. Do not include any explanation, markdown, or text outside the JSON object.`;
}

// --- Local fallback analysis ---
function buildLocalAnalysis(context, userId, language = 'tr') {
  const isEn = language === 'en';
  const { totalMonthlyDebt, totalRemainingDebt, avgMonthlyIncome, projections, bankBreakdown, categoryBreakdown, banks } = context;

  const monthlyDebt = totalMonthlyDebt > 0 ? totalMonthlyDebt : Math.round((totalRemainingDebt || 0) / 12);

  // Dinamik ve sürekli risk skoru hesaplaması
  let ratio = 0;
  let riskScore = 20;

  if (avgMonthlyIncome > 0) {
    ratio = monthlyDebt / avgMonthlyIncome;
    if (ratio < 0.25) riskScore = Math.round(12 + ratio * 45);
    else if (ratio < 0.5) riskScore = Math.round(24 + ratio * 55);
    else if (ratio < 0.8) riskScore = Math.round(36 + ratio * 50);
    else riskScore = Math.min(95, Math.round(62 + Math.min(ratio, 2) * 16));
  } else {
    // Gelir bilgisi henüz girilmemişse: her yeni ödeme ve borç artışı skoru gerçek zamanlı değiştirir
    const debtFactor = Math.min(45, (monthlyDebt / 800) * 1.1);
    const totalFactor = Math.min(25, (totalRemainingDebt / 3500) * 0.6);
    const countFactor = Math.min(15, (context.totalActivePayments || 0) * 1.5);
    riskScore = Math.min(95, Math.max(10, Math.round(12 + debtFactor + totalFactor + countFactor)));
    ratio = Math.min(1.5, (monthlyDebt / 15000) * 0.5 + (totalRemainingDebt / 80000) * 0.5);
  }

  let riskLevel, riskReason;
  if (riskScore < 35) {
    riskLevel = isEn ? 'low' : 'düşük';
    riskReason = isEn ? 'Your monthly debt/income ratio is low and stable.' : 'Aylık borç dengeniz stabil ve kontrol edilebilir seviyede.';
  } else if (riskScore < 55) {
    riskLevel = isEn ? 'medium' : 'orta';
    riskReason = isEn ? 'Reasonable debt volume, but upcoming payments require attention.' : 'Aylık borç/gelir dengeniz makul, ancak taksit yoğunluğu dikkat gerektiriyor.';
  } else if (riskScore < 75) {
    riskLevel = isEn ? 'high' : 'yüksek';
    riskReason = isEn ? 'Monthly debts take up a high portion of your capacity.' : 'Aylık borçlarınız gelirinizin veya ödeme kapasitenizin büyük kısmını kaplıyor.';
  } else {
    riskLevel = isEn ? 'critical' : 'kritik';
    riskReason = isEn ? 'Critical debt load detected — strategic repayment needed.' : 'Borç yükünüz kritik seviyede — acil tasarruf ve yapılandırma planı önerilir.';
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

// Handler for GET /api/ai/analyze and POST /api/ai/analyze
async function handleAnalyze(req, res) {
  try {
    const userId = req.query.userId || req.body?.userId;
    const force = req.query.force || req.body?.force;
    const lang = req.query.lang || req.body?.lang;
    const providedPayments = req.body?.payments;
    const providedSettings = req.body?.settings;
    const providedIncomes = req.body?.dailyIncomes;

    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const language = lang || 'tr';
    const forceRefresh = force === true || force === 'true';
    const cacheKey = `${userId}_${language}`;

    let payments = [];
    let settings = {};
    let dailyIncomes = {};

    if (Array.isArray(providedPayments)) {
      payments = providedPayments;
      settings = providedSettings || {};
      dailyIncomes = providedIncomes || {};
    } else {
      // Fetch user data from Turso
      const [paymentsResult, settingsResult, incomesResult] = await Promise.all([
        db.execute({ sql: 'SELECT * FROM payments WHERE user_id = ?', args: [userId] }),
        db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
        db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
      ]);

      payments = paymentsResult.rows.map(formatPayment);
      settings = settingsResult.rows[0] ? {
        banks: JSON.parse(settingsResult.rows[0].banks || '[]'),
        cutOffDay: settingsResult.rows[0].cut_off_day,
      } : {};

      incomesResult.rows.forEach(d => {
        dailyIncomes[d.date] = {
          cash: d.cash || 0, cc: d.cc || 0, salary: d.salary || 0,
          insurance: d.insurance || 0, other: d.other_income || 0,
          expenses: JSON.parse(d.expenses || '[]')
        };
      });
    }

    // Build context
    const context = buildFinancialContext(payments, dailyIncomes, settings);

    // Fingerprint based on active payments and debt
    const fingerprint = `${context.totalActivePayments}_${context.totalRemainingDebt}_${context.totalMonthlyDebt}_${payments[0]?.id || ''}`;

    // Check cache: only hit cache if forceRefresh is false AND the data fingerprint matches
    if (!forceRefresh) {
      const cached = analysisCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt && cached.fingerprint === fingerprint) {
        console.log(`[AI] Cache hit for ${userId} [${language}]`);
        return res.json({ success: true, ...cached.result });
      }
    }
    analysisCache.delete(cacheKey);

    // Fetch exchange rates from GenelPara API for AI Context
    let rates = { USD: 38.35, EUR: 41.75, GA: 3100, C: 5050 };
    try {
      const [dovizRes, altinRes] = await Promise.all([
        axios.get('https://api.genelpara.com/json/?list=doviz&sembol=USD,EUR', { timeout: 3000 }),
        axios.get('https://api.genelpara.com/json/?list=altin&sembol=GA,C', { timeout: 3000 })
      ]);
      const d = dovizRes.data?.data || dovizRes.data;
      const a = altinRes.data?.data || altinRes.data;
      if (d && d.USD && d.EUR) {
        rates.USD = parseFloat(String(d.USD.satis).replace(',', '.'));
        rates.EUR = parseFloat(String(d.EUR.satis).replace(',', '.'));
      }
      if (a && a.GA && a.C) {
        rates.GA = parseFloat(String(a.GA.satis).replace(',', '.'));
        rates.C = parseFloat(String(a.C.satis).replace(',', '.'));
      }
    } catch (e) {
      // keep default fallback rates
    }

    // Try Gemini API
    if (!GEMINI_API_KEY) {
      console.warn('[AI] No GEMINI_API_KEY — using local analysis');
      const result = buildLocalAnalysis(context, userId, language);
      analysisCache.set(cacheKey, { result, fingerprint, expiresAt: Date.now() + CACHE_TTL_MS });
      return res.json({ success: true, ...result });
    }

    const prompt = buildPrompt(context, rates, language);

    try {
      const { response, model } = await requestGemini({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: 'application/json' }
      });

      const raw = (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
      if (!raw) throw new Error('Empty Gemini response');

      const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      const result = { ...JSON.parse(cleaned), context, source: 'gemini' };
      analysisCache.set(cacheKey, { result, fingerprint, expiresAt: Date.now() + CACHE_TTL_MS });
      console.log(`[AI] Gemini analysis cached for ${userId} [${language}]`);
      return res.json({ success: true, ...result });

    } catch (geminiErr) {
      console.warn('[AI] Gemini error — local fallback:', geminiErr.message);
      const result = buildLocalAnalysis(context, userId, language);
      analysisCache.set(cacheKey, { result, fingerprint, expiresAt: Date.now() + CACHE_TTL_MS });
      return res.json({ success: true, ...result });
    }

  } catch (err) {
    console.error('[AI] Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// --- AI Chat endpoint ---
async function handleChat(req, res) {
  try {
    const { userId, message, history, payments: providedPayments, settings: providedSettings, dailyIncomes: providedIncomes, lang } = req.body || {};
    const language = lang || 'tr';

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Mesaj boş olamaz.' });
    }

    let payments = Array.isArray(providedPayments) ? providedPayments : [];
    let settings = providedSettings || {};
    let dailyIncomes = providedIncomes || {};

    if ((!providedPayments || providedPayments.length === 0) && userId) {
      const [paymentsResult, settingsResult, incomesResult] = await Promise.all([
        db.execute({ sql: 'SELECT * FROM payments WHERE user_id = ?', args: [userId] }),
        db.execute({ sql: 'SELECT * FROM settings WHERE user_id = ?', args: [userId] }),
        db.execute({ sql: 'SELECT * FROM daily_incomes WHERE user_id = ?', args: [userId] }),
      ]);
      payments = paymentsResult.rows.map(formatPayment);
      settings = settingsResult.rows[0] ? {
        banks: JSON.parse(settingsResult.rows[0].banks || '[]'),
        cutOffDay: settingsResult.rows[0].cut_off_day,
      } : {};
      incomesResult.rows.forEach(d => {
        dailyIncomes[d.date] = {
          cash: d.cash || 0, cc: d.cc || 0, salary: d.salary || 0,
          insurance: d.insurance || 0, other: d.other_income || 0,
          expenses: JSON.parse(d.expenses || '[]')
        };
      });
    }

    const context = buildFinancialContext(payments, dailyIncomes, settings);

    if (GEMINI_API_KEY) {
      try {
        const systemPrompt = `Sen PayPulse uygulamasının içindeki samimi, zeki ve genel amaçlı bir yapay zeka asistanısın (ChatGPT/Gemini gibi). Aynı zamanda finans koçusun.
Selamlaşma, sohbet, genel kültür, kodlama, tavsiye gibi HER konuda doğal şekilde konuşabilirsin; sadece finansla sınırlı değilsin.
Kullanıcının finansal verilerini SADECE soru finansla ilgiliyse kullan; selam ve sohbette bunları zorla anlatma.
Kısa, doğal ve sıcak yanıtlar ver; gerekirse emoji kullan. Yanıt dili Türkçe (kullanıcı başka dilde yazarsa o dilde).

Kullanıcının güncel finansal profili (referans için):
- Toplam Kalan Borç: ${context.totalRemainingDebt.toLocaleString('tr-TR')} TL
- Bu Ay Ödenecek Tahmini Taksit: ${context.totalMonthlyDebt.toLocaleString('tr-TR')} TL
- Ortalama Aylık Gelir: ${context.avgMonthlyIncome.toLocaleString('tr-TR')} TL
- Aktif Ödeme/Borç Kaydı: ${context.totalActivePayments} adet
- Banka Borç Dağılımı: ${context.bankBreakdown.map(b => `${b.bank}: ${b.totalDebt.toLocaleString('tr-TR')} TL`).join(', ') || 'Belirtilmemiş'}
- En Çok Harcanan Kategoriler: ${context.categoryBreakdown.map(c => `${c.category}: ${c.totalSpent.toLocaleString('tr-TR')} TL`).join(', ') || 'Belirtilmemiş'}
- Yakın Ödemeler: ${context.recentPayments.slice(0, 6).map(p => `${p.title} (${p.amount.toLocaleString('tr-TR')} TL - ${p.bank})`).join(', ') || 'Yok'}

Finansal sorularda gerçek verilere atıfta bulun; diğer konularda normal bir yapay zeka gibi sohbet et.`;

        const formattedContents = [];
        if (Array.isArray(history) && history.length > 0) {
          history.slice(-6).forEach(h => {
            formattedContents.push({
              role: h.role === 'user' ? 'user' : 'model',
              parts: [{ text: h.text }]
            });
          });
        }
        formattedContents.push({
          role: 'user',
          parts: [{ text: message }]
        });

        const { response, model } = await requestGemini({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: formattedContents,
          generationConfig: { temperature: 0.8, maxOutputTokens: 2048 }
        });

        const reply = (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
        if (reply) {
          return res.json({ success: true, reply, source: 'gemini', model });
        }
      } catch (geminiErr) {
        console.warn('[AI CHAT] Gemini hatası, yerel yanıt motoruna geçiliyor:', geminiErr.response?.status, JSON.stringify(geminiErr.response?.data?.error?.message || geminiErr.message));
      }
    }

    // Local smart answer fallback
    let reply = '';
    const q = message.toLowerCase().trim();
    if (/^(selam|merhaba|mrb|slm|hey|hi|hello|günaydın|iyi akşamlar|iyi geceler|sa|selamun aleyküm)\b/.test(q)) {
      reply = 'Selam! 👋 Ben PayPulse asistanın. Borçların, taksitlerin ve bütçen hakkında konuşabiliriz; ya da sadece sohbet edebiliriz. Nasıl yardımcı olayım?';
    } else if (/nas[ıi]ls[ıi]n|naber|ne haber|nasılsın/.test(q)) {
      reply = 'İyiyim, teşekkürler! 😊 Sen nasılsın? Finansal durumunla ilgili bir şey sormak ister misin?';
    } else if (/te[sş]ekk[uü]r|sa[gğ] ol|eyvallah/.test(q)) {
      reply = 'Rica ederim! 🙌 Başka bir şey sormak istersen buradayım.';
    } else if (/kimsin|sen kimsin|adın ne|ne yapabilirsin/.test(q)) {
      reply = 'Ben PayPulse yapay zeka asistanıyım. Borç/taksit durumunu analiz eder, tasarruf önerileri verir ve sorularını yanıtlarım. 🤖';
    } else if (q.includes('borc') || q.includes('borç') || q.includes('ne kadar') || q.includes('kalan')) {
      reply = `📊 **Mevcut Borç Durumunuz:**\n\n` +
        `• **Toplam Kalan Borç:** ${context.totalRemainingDebt.toLocaleString('tr-TR')} TL\n` +
        `• **Bu Ay Ödenecek:** ${context.totalMonthlyDebt.toLocaleString('tr-TR')} TL\n` +
        `• **Aktif Taksit Sayısı:** ${context.totalActivePayments} adet\n\n` +
        `💡 Yaklaşan taksitlerinizi zamanında kapatmanız faiz ve gecikme risklerini önler.`;
    } else if (q.includes('kart') || q.includes('banka')) {
      const topBank = context.bankBreakdown[0];
      reply = `💳 **Kart ve Banka Dağılımınız:**\n\n` +
        (topBank ? `En yüksek ödeme hacminiz **${topBank.bank}** üzerinde (${topBank.totalDebt.toLocaleString('tr-TR')} TL).\n\n` : '') +
        `💡 *Strateji Tavsiyesi:* Yeni bir harcama yaparken hesap kesim tarihi yeni geçmiş olan kartınızı tercih ederek 30-40 güne varan ek vade avantajı sağlayabilirsiniz.`;
    } else if (q.includes('tasarruf') || q.includes('öneri') || q.includes('tavsiye')) {
      reply = `🎯 **Akıllı Tasarruf Tavsiyeleriniz:**\n\n` +
        `1. **Yüksek Faizli Borçları Önceliklendirin:** Gecikmeye girmesi muhtemel veya faiz oranı yüksek taksitleri önce kapatın.\n` +
        `2. **Aylık Sabit Birikim:** Gelirinizin en az %10'unu harcama yapmadan önce tasarruf hesabına aktarın.\n` +
        `3. **Kategori Analizi:** En çok harcama yaptığınız kategorileri gözden geçirip isteğe bağlı harcamaları sınırlayın.`;
    } else {
      reply = `Finansal verilerinizi inceledim. Toplam **${context.totalRemainingDebt.toLocaleString('tr-TR')} TL** kalan borcunuz ve bu ay **${context.totalMonthlyDebt.toLocaleString('tr-TR')} TL** taksit ödemeniz bulunuyor. Size taksitleriniz, kart stratejiniz veya bütçe planlamanız hakkında detaylı bilgi verebilirim.`;
    }

    return res.json({ success: true, reply, source: 'smart_local' });
  } catch (err) {
    console.error('[AI CHAT Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

router.get('/analyze', handleAnalyze);
router.post('/analyze', handleAnalyze);
router.post('/chat', handleChat);

// ── Sesle / kamerayla ödeme ekleme ─────────────────────────────────────────
// Girdi: { text? , audio?: dataURL (webm/ogg/mp4/wav), image?: dataURL (jpeg/png/webp) }
// Çıktı: { success, payment: { type, billCategory, title, amount, currency, date, installments, bank } }
const BILL_CATEGORY_IDS = ['Elektrik Faturası', 'Su Faturası', 'Doğalgaz Faturası', 'İnternet Faturası', 'Telefon Faturası', 'Kira', 'Aidat', 'Abonelik', 'Kredi Taksiti', 'Sigorta', 'Eğitim', 'Vergi', 'Yatırım', 'Diğer'];

const dataUrlToInline = (dataUrl, allowed) => {
  const m = typeof dataUrl === 'string' && dataUrl.match(/^data:([a-z]+\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (!allowed.some(a => mime.startsWith(a))) return null;
  if (m[2].length > 14 * 1024 * 1024) return null; // ~10MB
  return { inlineData: { mimeType: mime, data: m[2] } };
};

// ── Kart ekstresinden toplu içe aktarma ────────────────────────────────────
// Girdi: { file: dataURL (application/pdf | image/*) }
// Çıktı: { success, bank, statementDate, transactions: [{ date, title, amount, installmentNo, installmentTotal }] }
router.post('/parse-statement', async (req, res) => {
  try {
    const { file, banks } = req.body || {};
    if (!GEMINI_API_KEY) return res.status(503).json({ success: false, error: 'Yapay zekâ servisi şu an kullanılamıyor.' });
    const part = dataUrlToInline(file, ['application/pdf', 'image/']);
    if (!part) return res.status(400).json({ success: false, error: 'Ekstre dosyası okunamadı (PDF veya fotoğraf, en fazla 10MB).' });

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' });
    const bankList = Array.isArray(banks) && banks.length ? banks.slice(0, 30).join(', ') : '';
    const instruction = `Bu bir Türk bankası kredi kartı hesap ekstresi. İçindeki HARCAMA satırlarını çıkar.
- Ödemeleri, iadeleri, faiz/ücret iadelerini, "önceki dönem borcu" ve "ödeme yapıldı" satırlarını ALMA.
- Faiz, gecikme faizi, kart aidatı, BSMV/KKDF gibi ücretleri title'da açıkça belirterek al.
- amount: o satırda bu dönem tahakkuk eden tutar (TL, ondalık, binlik ayırıcı yok).
- Taksitli satırlarda ("3/6 TAKSİT", "Taksit 2/9" vb.) installmentNo ve installmentTotal doldur; taksitsizse ikisi de 1.
- date: işlem tarihi YYYY-MM-DD (yıl yoksa ekstre tarihine göre tahmin et; bugün ${today}).
- title: işyeri adını sadeleştir (ör. "MIGROS TICARET A.S. ISTANBUL" → "Migros").
- bank: ekstrenin ait olduğu banka${bankList ? ` (şunlardan biri: ${bankList})` : ''}.`;

    const { response, model } = await requestGemini({
      contents: [{ role: 'user', parts: [{ text: instruction }, part] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            bank: { type: 'STRING' },
            statementDate: { type: 'STRING' },
            transactions: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  date: { type: 'STRING' },
                  title: { type: 'STRING' },
                  amount: { type: 'NUMBER' },
                  installmentNo: { type: 'INTEGER' },
                  installmentTotal: { type: 'INTEGER' },
                },
                required: ['date', 'title', 'amount'],
              },
            },
          },
          required: ['transactions'],
        },
      },
    });

    const raw = (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
    let p;
    try { p = JSON.parse(raw); } catch { return res.status(502).json({ success: false, error: 'Ekstre okunamadı, lütfen tekrar deneyin.' }); }

    const transactions = (Array.isArray(p.transactions) ? p.transactions : [])
      .map(t => {
        const total = Math.min(36, Math.max(1, parseInt(t.installmentTotal) || 1));
        const no = Math.min(total, Math.max(1, parseInt(t.installmentNo) || 1));
        return {
          date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : today,
          title: String(t.title || '').slice(0, 80),
          amount: Math.round(Math.abs(Number(t.amount) || 0) * 100) / 100,
          installmentNo: no,
          installmentTotal: total,
        };
      })
      .filter(t => t.amount > 0 && t.title)
      .slice(0, 200);

    res.json({ success: true, bank: String(p.bank || '').slice(0, 40), statementDate: p.statementDate || '', transactions, model });
  } catch (err) {
    console.error('[AI PARSE STATEMENT]', err.response?.status, err.response?.data?.error?.message || err.message);
    res.status(500).json({ success: false, error: 'Ekstre işlenemedi. Lütfen tekrar deneyin.' });
  }
});

router.post('/parse-payment', async (req, res) => {
  try {
    const { text, audio, image, banks } = req.body || {};
    if (!GEMINI_API_KEY) return res.status(503).json({ success: false, error: 'Yapay zekâ servisi şu an kullanılamıyor.' });

    const parts = [];
    const audioPart = audio ? dataUrlToInline(audio, ['audio/']) : null;
    const imagePart = image ? dataUrlToInline(image, ['image/']) : null;
    if (audio && !audioPart) return res.status(400).json({ success: false, error: 'Ses kaydı okunamadı.' });
    if (image && !imagePart) return res.status(400).json({ success: false, error: 'Fotoğraf okunamadı.' });
    if (!audioPart && !imagePart && !(text || '').trim()) return res.status(400).json({ success: false, error: 'Ses, fotoğraf veya metin gerekli.' });

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }); // YYYY-MM-DD
    const bankList = Array.isArray(banks) && banks.length ? banks.slice(0, 30).join(', ') : 'Akbank, Garanti BBVA, İş Bankası, Yapı Kredi, Ziraat Bankası, Halkbank, Vakıfbank, QNB Finansbank, Diğer';

    const instruction = `Sen PayPulse ödeme takip uygulamasının ödeme ekleme asistanısın. Kullanıcının ${audioPart ? 'ses kaydından' : imagePart ? 'fatura/fiş/ekstre fotoğrafından' : 'yazdığı metinden'} TEK bir ödeme kaydı çıkar.
Bugünün tarihi: ${today} (Türkiye). "Yarın", "ayın 23'ü", "haftaya cuma" gibi ifadeleri bu tarihe göre YYYY-MM-DD'ye çevir. Tarih yoksa bugünü kullan. Faturada "son ödeme tarihi" varsa onu kullan.
type: kredi kartı harcaması/taksit ise "credit_card"; fatura, kira, aidat, abonelik, kredi, sigorta, vergi, okul vb. ise "bill".
billCategory: type "bill" ise şu listeden en uygun olanı: ${BILL_CATEGORY_IDS.join(', ')}. Değilse boş bırak.
bank: type "credit_card" ise şu bankalardan biri (bilinmiyorsa ilki): ${bankList}.
amount: sayı (TL ise kuruşlu ondalık, binlik ayırıcı yok). currency: TRY, USD veya EUR.
installments: kredi kartında taksit sayısı (yoksa 1); "bill" için kaç ay tekrarlanacağı (söylenmediyse 1).
title: kısa açıklama (ör. "Enerjisa Elektrik", "Ev Kirası", "Migros alışverişi").
transcript: ses kaydıysa kullanıcının söylediği cümle; değilse kısa özet.
Emin olamadığın alanlar için confidence "low" ver.`;

    parts.push({ text: instruction });
    if (audioPart) parts.push(audioPart);
    if (imagePart) parts.push(imagePart);
    if ((text || '').trim()) parts.push({ text: `Kullanıcının metni: ${String(text).slice(0, 1000)}` });

    const { response, model } = await requestGemini({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING', enum: ['credit_card', 'bill'] },
            billCategory: { type: 'STRING' },
            title: { type: 'STRING' },
            amount: { type: 'NUMBER' },
            currency: { type: 'STRING', enum: ['TRY', 'USD', 'EUR'] },
            date: { type: 'STRING' },
            installments: { type: 'INTEGER' },
            bank: { type: 'STRING' },
            transcript: { type: 'STRING' },
            confidence: { type: 'STRING', enum: ['high', 'low'] },
          },
          required: ['type', 'title', 'amount', 'date'],
        },
      },
    });

    const raw = (response.data?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join('');
    let p;
    try { p = JSON.parse(raw); } catch { return res.status(502).json({ success: false, error: 'Yapay zekâ yanıtı anlaşılamadı, lütfen tekrar deneyin.' }); }

    const payment = {
      type: p.type === 'bill' ? 'bill' : 'credit_card',
      billCategory: BILL_CATEGORY_IDS.includes(p.billCategory) ? p.billCategory : (p.type === 'bill' ? 'Diğer' : ''),
      title: String(p.title || '').slice(0, 80),
      amount: Math.max(0, Math.round(Number(p.amount || 0) * 100) / 100),
      currency: ['TRY', 'USD', 'EUR'].includes(p.currency) ? p.currency : 'TRY',
      date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : today,
      installments: Math.min(36, Math.max(1, parseInt(p.installments) || 1)),
      bank: String(p.bank || '').slice(0, 40),
      transcript: String(p.transcript || '').slice(0, 300),
      confidence: p.confidence === 'low' ? 'low' : 'high',
    };
    res.json({ success: true, payment, model });
  } catch (err) {
    console.error('[AI PARSE PAYMENT]', err.response?.status, err.response?.data?.error?.message || err.message);
    res.status(500).json({ success: false, error: 'Ödeme bilgisi çıkarılamadı. Lütfen tekrar deneyin.' });
  }
});

// Ay sonu AI finans raporu (Premium, sunucuda hesaplanan verilerle)
router.post('/monthly-report', require('./aiMonthlyReport')(requestGemini, () => !!GEMINI_API_KEY));

module.exports = router;
