const express = require('express');
const router = express.Router();
const axios = require('axios');

// Simple in-memory cache
let rateCache = null;
let cacheTime = 0;
const CACHE_MS = 60 * 60 * 1000; // 1 hour

// Full rates cache (currencies + gold)
let allRatesCache = { data: null, lastUpdated: 0 };
const ALL_CACHE_MS = 5 * 60 * 1000; // 5 minutes

const parseNum = (val) => {
  if (!val) return 0;
  const num = typeof val === 'string' ? parseFloat(val.replace(',', '.')) : parseFloat(val);
  return isNaN(num) ? 0 : num;
};

async function fetchRates() {
  if (rateCache && Date.now() - cacheTime < CACHE_MS) return rateCache;

  try {
    const res = await axios.get('https://api.genelpara.com/embed/para-birimleri.json', { timeout: 8000 });
    const d = res.data;
    rateCache = {
      USD: parseFloat(d?.USD?.satis) || 0,
      EUR: parseFloat(d?.EUR?.satis) || 0,
      USD_Change: parseFloat(d?.USD?.kapanis) || 0,
      EUR_Change: parseFloat(d?.EUR?.kapanis) || 0,
      TRY: 1.0,
      updatedAt: new Date().toISOString()
    };
    cacheTime = Date.now();
    return rateCache;
  } catch (e) {
    return rateCache || { USD: 0, EUR: 0, TRY: 1, offline: true };
  }
}

// Full GenelPara data (currencies + gold)
async function fetchAllRates(force = false) {
  const now = Date.now();
  if (!force && allRatesCache.data && (now - allRatesCache.lastUpdated < ALL_CACHE_MS)) {
    return allRatesCache.data;
  }

  try {
    console.log('[EXCHANGE] Fetching ALL rates from GenelPara...');

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

    const [currencyRes, goldRes] = await Promise.all([
      axios.get('https://api.genelpara.com/json/?list=doviz&sembol=all', { headers, timeout: 10000 }),
      axios.get('https://api.genelpara.com/json/?list=altin&sembol=all', { headers, timeout: 10000 })
    ]);

    const currencyData = currencyRes.data;
    const goldData = goldRes.data;

    // Currency mapping
    const currencyMap = {
      'USD': { name: 'AMERİKAN DOLARI', order: 1 },
      'EUR': { name: 'EURO', order: 2 },
      'SEK': { name: 'İSVEÇ KRONU', order: 3 },
      'CHF': { name: 'İSVİÇRE FRANGI', order: 4 },
      'GBP': { name: 'İNGİLİZ STERLİNİ', order: 5 },
      'AUD': { name: 'AVUSTRALYA DOLARI', order: 6 },
      'CAD': { name: 'KANADA DOLARI', order: 7 },
      'SAR': { name: 'S.ARABİSTAN RİYALİ', order: 8 },
      'JPY': { name: 'JAPON YENİ', order: 9 },
      'DKK': { name: 'DANİMARKA KRONU', order: 10 },
      'NOK': { name: 'NORVEÇ KRONU', order: 11 },
      'RUB': { name: 'RUS RUBLESİ', order: 12 }
    };

    // Gold mapping
    const goldMap = {
      'GA': { name: 'GRAM ALTIN', order: 1 },
      'C': { name: 'ÇEYREK ALTIN', order: 2 },
      'Y': { name: 'YARIM ALTIN', order: 3 },
      'T': { name: 'TAM ALTIN', order: 4 },
      'ATA': { name: 'ATA ALTIN', order: 5 },
      'CMR': { name: 'CUMHURİYET', order: 6 },
      'RA': { name: 'REŞAT ALTIN', order: 7 },
      'GR': { name: 'GREMSE', order: 8 },
      '22': { name: '22 AYAR BİLEZİK', order: 9 },
      '18': { name: '18 AYAR', order: 10 },
      '14': { name: '14 AYAR', order: 11 },
      'HA': { name: 'HAMİT ALTIN', order: 12 },
      'BSL': { name: 'BEŞLİ ALTIN', order: 13 },
      'GAG': { name: 'GRAM GÜMÜŞ', order: 14 }
    };

    // Build currencies array
    const currencies = [];
    const rates = { TRY: 1.0 };

    if (currencyData.success && currencyData.data) {
      Object.entries(currencyData.data).forEach(([code, info]) => {
        const mapping = currencyMap[code];
        if (mapping) {
          currencies.push({
            code,
            name: mapping.name,
            buying: parseNum(info.alis),
            selling: parseNum(info.satis),
            change: info.degisim || '0',
            order: mapping.order
          });
          rates[code] = parseNum(info.satis);
        }
      });
    }

    currencies.sort((a, b) => a.order - b.order);

    // Build gold array
    const gold = [];

    if (goldData.success && goldData.data) {
      Object.entries(goldData.data).forEach(([code, info]) => {
        const upperCode = code.toUpperCase();
        const mapping = goldMap[upperCode];
        if (mapping) {
          gold.push({
            code: upperCode,
            name: mapping.name,
            buying: parseNum(info.alis),
            selling: parseNum(info.satis),
            change: info.degisim || '0',
            order: mapping.order
          });
        }
      });
    }

    gold.sort((a, b) => a.order - b.order);

    allRatesCache.data = {
      currencies,
      gold,
      rates,
      lastUpdated: new Date().toISOString()
    };
    allRatesCache.lastUpdated = now;

    console.log(`[EXCHANGE] Fetched ${currencies.length} currencies and ${gold.length} gold types`);
    return allRatesCache.data;

  } catch (error) {
    console.error('[EXCHANGE] Error fetching all rates:', error.message);
    return allRatesCache.data || { currencies: [], gold: [], rates: { TRY: 1.0 } };
  }
}

// GET /api/exchange/rates
router.get('/rates', async (req, res) => {
  try {
    const rates = await fetchRates();
    res.json({ success: true, rates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/exchange/all — Full currencies + gold data
router.get('/all', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const data = await fetchAllRates(force);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
