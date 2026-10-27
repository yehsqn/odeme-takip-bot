const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const axios = require('axios');
const crypto = require('crypto');

const genId = () => crypto.randomBytes(12).toString('hex');
const { isPremiumActive } = require('./subscription');

// ── Girdi doğrulama ────────────────────────────────────────────────
const CATEGORIES = new Set(['gold', 'stock', 'crypto']);
const MAX_ITEMS = 200;
const num = (v, max = 1e12) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n < max ? n : null; };

/** partial=true: yalnızca gönderilen alanlar; geçersiz alan için { error } döner */
function itemFields(body, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('category')) {
    if (!CATEGORIES.has(body.category)) return { error: 'Geçersiz kategori' };
    out.category = body.category;
  }
  if (!partial || has('symbol')) {
    const sym = String(body.symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) return { error: 'Geçersiz sembol' };
    out.symbol = sym;
  }
  if (!partial || has('amount')) {
    const a = num(body.amount);
    if (!a) return { error: 'Miktar sıfırdan büyük olmalı' };
    out.amount = a;
  }
  if (!partial || has('buyPrice')) {
    const p = num(body.buyPrice ?? 0);
    if (p === null) return { error: 'Geçersiz alış fiyatı' };
    out.buyPrice = p;
  }
  if (!partial || has('buyCurrency')) out.buyCurrency = body.buyCurrency === 'USD' ? 'USD' : 'TRY';
  if (!partial || has('buyDate')) out.buyDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.buyDate || '')) ? body.buyDate : new Date().toISOString().split('T')[0];
  if (!partial || has('notes')) out.notes = String(body.notes ?? '').trim().slice(0, 200);
  if (!partial || has('name')) out.name = String(body.name ?? '').trim().slice(0, 60);
  return out;
}

async function requirePremium(req, res) {
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.authUserId] })).rows[0];
  if (isPremiumActive(u)) return true;
  res.status(403).json({ success: false, premiumRequired: true, error: 'Portföy takibi Premium özelliğidir.' });
  return false;
}

// In-memory cache for market quotes
let marketQuotesCache = {
  data: {},
  usdTry: 38.5,
  lastUpdated: 0
};
const CACHE_TTL_MS = 60 * 1000; // 1 dakika

// Fallback / reference prices
const DEFAULT_PRICES = {
  // Altın (TRY)
  'GA': { name: 'Gram Altın', price: 3450, change: '+0.85', category: 'gold' },
  'C': { name: 'Çeyrek Altın', price: 5650, change: '+0.72', category: 'gold' },
  'Y': { name: 'Yarım Altın', price: 11300, change: '+0.72', category: 'gold' },
  'T': { name: 'Tam Altın', price: 22600, change: '+0.75', category: 'gold' },
  'ATA': { name: 'Ata Altın', price: 23200, change: '+0.90', category: 'gold' },
  'CMR': { name: 'Cumhuriyet Altını', price: 23050, change: '+0.80', category: 'gold' },
  '22': { name: '22 Ayar Bilezik (gr)', price: 3150, change: '+0.82', category: 'gold' },
  'GAG': { name: 'Gram Gümüş', price: 42.5, change: '+1.20', category: 'gold' },

  // Kripto (USD) - Güncel Referans
  'BTC': { name: 'Bitcoin', priceUSD: 80500, change: '+0.50', category: 'crypto' },
  'ETH': { name: 'Ethereum', priceUSD: 2350, change: '+0.75', category: 'crypto' },
  'SOL': { name: 'Solana', priceUSD: 101, change: '-0.65', category: 'crypto' },
  'AVAX': { name: 'Avalanche', priceUSD: 8.85, change: '-1.40', category: 'crypto' },
  'BNB': { name: 'BNB', priceUSD: 748, change: '+0.60', category: 'crypto' },
  'XRP': { name: 'Ripple', priceUSD: 1.32, change: '+1.65', category: 'crypto' },
  'DOGE': { name: 'Dogecoin', priceUSD: 0.078, change: '+0.65', category: 'crypto' },
  'USDT': { name: 'Tether (USDT)', priceUSD: 1.0, change: '+0.01', category: 'crypto' },

  // BIST Hisseleri (TRY)
  'THYAO': { name: 'Türk Hava Yolları', price: 253.0, change: '+1.45', category: 'stock' },
  'ASELS': { name: 'Aselsan', price: 340.75, change: '+2.10', category: 'stock' },
  'GARAN': { name: 'Garanti BBVA', price: 127.3, change: '+0.80', category: 'stock' },
  'EREGL': { name: 'Ereğli Demir Çelik', price: 31.46, change: '-0.35', category: 'stock' },
  'SISE': { name: 'Şişecam', price: 42.5, change: '+0.50', category: 'stock' },
  'TUPRS': { name: 'Tüpraş', price: 361.5, change: '+1.15', category: 'stock' },
  'KCHOL': { name: 'Koç Holding', price: 198.7, change: '+1.60', category: 'stock' },
  'BIMAS': { name: 'BİM Mağazalar', price: 363.0, change: '+0.40', category: 'stock' },
  'AKBNK': { name: 'Akbank', price: 64.3, change: '+1.05', category: 'stock' },
  'ISCTR': { name: 'İş Bankası (C)', price: 12.29, change: '+0.90', category: 'stock' },

  // US Global Stocks (USD)
  'AAPL': { name: 'Apple Inc.', priceUSD: 232.0, change: '+0.75', category: 'stock' },
  'NVDA': { name: 'Nvidia Corp.', priceUSD: 138.5, change: '+3.20', category: 'stock' },
  'MSFT': { name: 'Microsoft Corp.', priceUSD: 425.0, change: '+0.60', category: 'stock' },
  'TSLA': { name: 'Tesla Inc.', priceUSD: 260.0, change: '+2.80', category: 'stock' },
  'AMZN': { name: 'Amazon.com Inc.', priceUSD: 205.0, change: '+1.10', category: 'stock' },
};

async function fetchLiveMarketPrices() {
  const now = Date.now();
  if (marketQuotesCache.lastUpdated && now - marketQuotesCache.lastUpdated < CACHE_TTL_MS) {
    return marketQuotesCache;
  }

  const quotes = {};
  let usdTry = marketQuotesCache.usdTry || 38.5;

  // 1. GenelPara döviz ve altın çekimi
  try {
    const [dovizRes, altinRes] = await Promise.all([
      axios.get('https://api.genelpara.com/json/?list=doviz&sembol=USD,EUR', { timeout: 6000 }),
      axios.get('https://api.genelpara.com/json/?list=altin&sembol=all', { timeout: 6000 })
    ]);

    if (dovizRes.data?.data?.USD?.satis) {
      usdTry = parseFloat(String(dovizRes.data.data.USD.satis).replace(',', '.')) || usdTry;
    }

    if (altinRes.data?.data) {
      const gData = altinRes.data.data;
      const parseVal = (v) => parseFloat(String(v || 0).replace(',', '.')) || 0;

      const altinMap = {
        'GA': 'GA',
        'C': 'C',
        'Y': 'Y',
        'T': 'T',
        'ATA': 'ATA',
        'CMR': 'CMR',
        '22': '22',
        'GAG': 'GAG'
      };

      for (const [key, code] of Object.entries(altinMap)) {
        if (gData[key]) {
          const s = gData[key];
          quotes[code] = {
            symbol: code,
            name: DEFAULT_PRICES[code]?.name || code,
            priceTRY: parseVal(s.satis),
            priceUSD: parseVal(s.satis) / usdTry,
            change: s.degisim ? `${s.degisim > 0 ? '+' : ''}${s.degisim}` : '0',
            category: 'gold'
          };
        }
      }
    }
  } catch (err) {
    console.warn('[PORTFOLIO] Gold/Currencies fetch warning:', err.message);
  }

  // 2. Canlı Kripto Fiyatları (Binance 24hr + CoinGecko & GenelPara Yedekli)
  let cryptoSuccess = false;
  try {
    const cryptoSymbols = '["BTCUSDT","ETHUSDT","SOLUSDT","AVAXUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"]';
    const binanceRes = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(cryptoSymbols)}`, { timeout: 6000 });
    if (Array.isArray(binanceRes.data) && binanceRes.data.length > 0) {
      for (const item of binanceRes.data) {
        const coin = item.symbol.replace('USDT', '');
        const pUSD = parseFloat(item.lastPrice) || 0;
        const chg = parseFloat(item.priceChangePercent) || 0;
        quotes[coin] = {
          symbol: coin,
          name: DEFAULT_PRICES[coin]?.name || coin,
          priceUSD: pUSD,
          priceTRY: pUSD * usdTry,
          change: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`,
          category: 'crypto'
        };
      }
      cryptoSuccess = true;
    }
  } catch (err) {
    console.warn('[PORTFOLIO] Binance ticker warning, falling back to CoinGecko:', err.message);
  }

  // CoinGecko yedeği
  if (!cryptoSuccess) {
    try {
      const cgRes = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,binancecoin,avalanche-2,dogecoin,tether&vs_currencies=usd&include_24hr_change=true',
        { timeout: 6000 }
      );
      if (cgRes.data) {
        const map = {
          'BTC': cgRes.data.bitcoin,
          'ETH': cgRes.data.ethereum,
          'SOL': cgRes.data.solana,
          'XRP': cgRes.data.ripple,
          'BNB': cgRes.data.binancecoin,
          'AVAX': cgRes.data['avalanche-2'],
          'DOGE': cgRes.data.dogecoin,
        };
        for (const [coin, data] of Object.entries(map)) {
          if (data && data.usd) {
            const pUSD = Number(data.usd);
            const chg = Number(data.usd_24h_change) || 0;
            quotes[coin] = {
              symbol: coin,
              name: DEFAULT_PRICES[coin]?.name || coin,
              priceUSD: pUSD,
              priceTRY: pUSD * usdTry,
              change: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`,
              category: 'crypto'
            };
          }
        }
        cryptoSuccess = true;
      }
    } catch (cgErr) {
      console.warn('[PORTFOLIO] CoinGecko fallback warning:', cgErr.message);
    }
  }

  // USDT Sabiti
  quotes['USDT'] = {
    symbol: 'USDT',
    name: 'Tether (USDT)',
    priceUSD: 1.0,
    priceTRY: usdTry,
    change: '+0.01',
    category: 'crypto'
  };

  // 3. Canlı BIST ve Global Hisse Fiyatları (Yahoo Finance)
  try {
    const bistList = ['THYAO', 'ASELS', 'GARAN', 'EREGL', 'SISE', 'TUPRS', 'KCHOL', 'BIMAS', 'AKBNK', 'ISCTR'];
    const usList = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN'];

    await Promise.allSettled([
      ...bistList.map(async (sym) => {
        try {
          const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}.IS?interval=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
          });
          const meta = r.data?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            const p = Number(meta.regularMarketPrice);
            const prev = Number(meta.previousClose) || Number(meta.chartPreviousClose) || p;
            const pct = prev > 0 ? (((p - prev) / prev) * 100).toFixed(2) : '0.00';
            quotes[sym] = {
              symbol: sym,
              name: DEFAULT_PRICES[sym]?.name || sym,
              priceTRY: p,
              priceUSD: p / usdTry,
              change: `${Number(pct) >= 0 ? '+' : ''}${pct}`,
              category: 'stock'
            };
          }
        } catch {}
      }),
      ...usList.map(async (sym) => {
        try {
          const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000
          });
          const meta = r.data?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice) {
            const pUSD = Number(meta.regularMarketPrice);
            const prev = Number(meta.previousClose) || Number(meta.chartPreviousClose) || pUSD;
            const pct = prev > 0 ? (((pUSD - prev) / prev) * 100).toFixed(2) : '0.00';
            quotes[sym] = {
              symbol: sym,
              name: DEFAULT_PRICES[sym]?.name || sym,
              priceUSD: pUSD,
              priceTRY: pUSD * usdTry,
              change: `${Number(pct) >= 0 ? '+' : ''}${pct}`,
              category: 'stock'
            };
          }
        } catch {}
      })
    ]);
  } catch (err) {
    console.warn('[PORTFOLIO] Stocks live fetch warning:', err.message);
  }

  // 3. Eksik kalanlar için fallback fiyatları yerleştir
  for (const [symbol, info] of Object.entries(DEFAULT_PRICES)) {
    if (!quotes[symbol]) {
      const pTRY = info.price || (info.priceUSD ? info.priceUSD * usdTry : 0);
      const pUSD = info.priceUSD || (info.price ? info.price / usdTry : 0);
      quotes[symbol] = {
        symbol,
        name: info.name,
        priceTRY: pTRY,
        priceUSD: pUSD,
        change: info.change,
        category: info.category
      };
    }
  }

  marketQuotesCache = {
    data: quotes,
    usdTry,
    lastUpdated: now
  };

  return marketQuotesCache;
}

// GET /api/portfolio/market-prices — Canlı piyasa fiyatları haritası
router.get('/market-prices', async (req, res) => {
  try {
    const cache = await fetchLiveMarketPrices();
    res.json({
      success: true,
      quotes: cache.data,
      usdTry: cache.usdTry,
      lastUpdated: new Date(cache.lastUpdated).toISOString()
    });
  } catch (err) {
    console.error('[PORTFOLIO] Market prices error:', err.message);
    res.status(500).json({ success: false, error: 'Piyasa fiyatları alınamadı' });
  }
});

// GET /api/portfolio — Kullanıcının portföy varlıkları ve kâr/zarar hesaplamaları
router.get('/', async (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(401).json({ success: false, error: 'Oturum gerekli' });

    const market = await fetchLiveMarketPrices();
    const quotes = market.data;
    const usdTry = market.usdTry;

    const r = await db.execute({
      sql: `SELECT * FROM portfolio_items WHERE user_id = ? ORDER BY category ASC, created_at DESC`,
      args: [userId]
    });

    let totalValueTRY = 0;
    let totalCostTRY = 0;

    const items = r.rows.map(item => {
      const sym = item.symbol.toUpperCase();
      const quote = quotes[sym] || quotes[item.symbol] || null;

      const amount = Number(item.amount) || 0;
      const buyPrice = Number(item.buy_price) || 0;
      const buyCur = item.buy_currency || 'TRY';

      // Birim alış maliyeti (TRY)
      const unitCostTRY = buyCur === 'USD' ? buyPrice * usdTry : buyPrice;
      const totalItemCostTRY = unitCostTRY * amount;

      // Güncel birim fiyat (TRY)
      let currentUnitTRY = quote ? quote.priceTRY : (buyCur === 'USD' ? buyPrice * usdTry : buyPrice);
      const currentItemValueTRY = currentUnitTRY * amount;

      const profitTRY = currentItemValueTRY - totalItemCostTRY;
      const profitPercent = totalItemCostTRY > 0 ? (profitTRY / totalItemCostTRY) * 100 : 0;

      totalValueTRY += currentItemValueTRY;
      totalCostTRY += totalItemCostTRY;

      return {
        id: item.id,
        category: item.category,
        symbol: item.symbol,
        name: item.name || quote?.name || item.symbol,
        amount,
        buyPrice,
        buyCurrency: buyCur,
        buyDate: item.buy_date || '',
        notes: item.notes || '',
        unitCostTRY,
        totalCostTRY,
        currentUnitPriceTRY: currentUnitTRY,
        currentUnitPriceUSD: currentUnitTRY / usdTry,
        currentValueTRY: currentItemValueTRY,
        currentValueUSD: currentItemValueTRY / usdTry,
        profitTRY,
        profitUSD: profitTRY / usdTry,
        profitPercent,
        marketChange: quote?.change || '0.00%',
        createdAt: item.created_at
      };
    });

    const totalProfitTRY = totalValueTRY - totalCostTRY;
    const totalProfitPercent = totalCostTRY > 0 ? (totalProfitTRY / totalCostTRY) * 100 : 0;

    // Kategori kırılımları
    const summaryByCategory = {
      gold: { valueTRY: 0, costTRY: 0, count: 0 },
      stock: { valueTRY: 0, costTRY: 0, count: 0 },
      crypto: { valueTRY: 0, costTRY: 0, count: 0 },
    };

    for (const it of items) {
      const cat = summaryByCategory[it.category] ? it.category : 'stock';
      summaryByCategory[cat].valueTRY += it.currentValueTRY;
      summaryByCategory[cat].costTRY += it.totalCostTRY;
      summaryByCategory[cat].count += 1;
    }

    res.json({
      success: true,
      items,
      summary: {
        totalValueTRY,
        totalValueUSD: totalValueTRY / usdTry,
        totalCostTRY,
        totalCostUSD: totalCostTRY / usdTry,
        totalProfitTRY,
        totalProfitUSD: totalProfitTRY / usdTry,
        totalProfitPercent,
        usdTry,
        byCategory: summaryByCategory
      }
    });
  } catch (err) {
    console.error('[PORTFOLIO] List error:', err.message);
    res.status(500).json({ success: false, error: 'Portföy verileri getirilemedi' });
  }
});

// POST /api/portfolio — Yeni varlık ekle (Premium)
router.post('/', async (req, res) => {
  try {
    const userId = req.authUserId;
    if (!(await requirePremium(req, res))) return;
    const f = itemFields(req.body || {});
    if (f.error) return res.status(400).json({ success: false, error: f.error });

    const cnt = Number((await db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM portfolio_items WHERE user_id = ?', args: [userId] })).rows[0]?.cnt || 0);
    if (cnt >= MAX_ITEMS) return res.status(400).json({ success: false, error: `En fazla ${MAX_ITEMS} varlık ekleyebilirsiniz.` });

    const id = genId();
    await db.execute({
      sql: `INSERT INTO portfolio_items (id, user_id, category, symbol, name, amount, buy_price, buy_currency, buy_date, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [id, userId, f.category, f.symbol, f.name || f.symbol, f.amount, f.buyPrice, f.buyCurrency, f.buyDate, f.notes],
    });

    res.json({ success: true, message: 'Varlık portföye eklendi', id });
  } catch (err) {
    console.error('[PORTFOLIO] Add item error:', err.message);
    res.status(500).json({ success: false, error: 'Varlık eklenemedi' });
  }
});

// PUT /api/portfolio/:id — Varlık güncelle (Premium)
router.put('/:id', async (req, res) => {
  try {
    const userId = req.authUserId;
    if (!(await requirePremium(req, res))) return;
    const body = { ...(req.body || {}) };
    delete body.category; delete body.symbol; // kategori ve sembol sonradan değiştirilmez
    const f = itemFields(body, true);
    if (f.error) return res.status(400).json({ success: false, error: f.error });

    const cols = { amount: 'amount', buyPrice: 'buy_price', buyCurrency: 'buy_currency', buyDate: 'buy_date', notes: 'notes', name: 'name' };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(cols)) if (f[k] !== undefined) { sets.push(`${col} = ?`); args.push(f[k]); }
    if (sets.length) {
      await db.execute({
        sql: `UPDATE portfolio_items SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        args: [...args, String(req.params.id), userId],
      });
    }

    res.json({ success: true, message: 'Portföy varlığı güncellendi' });
  } catch (err) {
    console.error('[PORTFOLIO] Update item error:', err.message);
    res.status(500).json({ success: false, error: 'Varlık güncellenemedi' });
  }
});

// DELETE /api/portfolio/:id — Varlık sil
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.authUserId;
    const { id } = req.params;

    await db.execute({
      sql: `DELETE FROM portfolio_items WHERE id = ? AND user_id = ?`,
      args: [id, userId]
    });

    res.json({ success: true, message: 'Varlık portföyden kaldırıldı' });
  } catch (err) {
    console.error('[PORTFOLIO] Delete item error:', err.message);
    res.status(500).json({ success: false, error: 'Varlık silinemedi' });
  }
});

module.exports = router;
