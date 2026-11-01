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

// GenelPara altın kodlarının Truncgil karşılıkları (ONS yok: GenelPara da döndürmüyor, Truncgil'de USD cinsinden)
const TRUNCGIL_GOLD = {
  GA: 'gram-altin', C: 'ceyrek-altin', Y: 'yarim-altin', T: 'tam-altin', ATA: 'ata-altin',
  CMR: 'cumhuriyet-altini', RA: 'resat-altin', GR: 'gremse-altin', HA: 'hamit-altin',
  BSL: 'besli-altin', 22: '22-ayar-bilezik', 18: '18-ayar-altin', 14: '14-ayar-altin', GAG: 'gumus',
};
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
let truncgilCache = { data: null, at: 0 };

// Truncgil "6.222,90" ve "%-3,56" yazar, GenelPara ise "6222.90" ve "-3.56"
const truncgilNum = (val) => String(val || '0').replace(/[%$\s]/g, '').replace(/\./g, '').replace(',', '.');

async function fetchTruncgil() {
  if (truncgilCache.data && Date.now() - truncgilCache.at < 60 * 1000) return truncgilCache.data;
  const res = await axios.get('https://finans.truncgil.com/today.json', { headers: { 'User-Agent': BROWSER_UA }, timeout: 8000 });
  truncgilCache = { data: res.data, at: Date.now() };
  return res.data;
}

async function truncgilAsGenelPara(list, symbols) {
  const source = await fetchTruncgil();
  const pairs = list === 'altin'
    ? Object.entries(TRUNCGIL_GOLD)
    : Object.keys(source).filter(k => source[k]?.['Tür'] === 'Döviz').map(k => [k, k]);
  const wanted = symbols === 'all' ? null : new Set(symbols.split(','));
  const data = {};
  for (const [code, key] of pairs) {
    const item = source[key];
    if (!item || (wanted && !wanted.has(code))) continue;
    // GenelPara JPY'yi 100 birim üzerinden verir
    const scale = code === 'JPY' ? 100 : 1;
    data[code] = {
      alis: (parseFloat(truncgilNum(item['Alış'])) * scale).toFixed(4),
      satis: (parseFloat(truncgilNum(item['Satış'])) * scale).toFixed(4),
      degisim: truncgilNum(item['Değişim']),
    };
  }
  if (!Object.keys(data).length) throw new Error('Truncgil verisi boş');
  return { success: true, list, data };
}

// GenelPara biçiminde kur verisi; GenelPara yanıt vermezse aynı biçimde Truncgil verisi döner
async function fetchGenelPara(list, symbols, timeout = 8000) {
  try {
    const res = await axios.get(`https://api.genelpara.com/json/?list=${list}&sembol=${symbols}`, {
      headers: { 'User-Agent': BROWSER_UA },
      timeout,
    });
    if (res.data?.data && Object.keys(res.data.data).length) return res.data;
    throw new Error('boş yanıt');
  } catch (err) {
    console.warn(`[EXCHANGE] GenelPara ${list} alınamadı, Truncgil kullanılıyor:`, err.message);
    return truncgilAsGenelPara(list, symbols);
  }
}

async function fetchRates() {
  if (rateCache && Date.now() - cacheTime < CACHE_MS) return rateCache;

  try {
    const res = await fetchGenelPara('doviz', 'USD,EUR');
    const d = res.data;
    if (!d?.USD) throw new Error('GenelPara döviz verisi alınamadı');
    rateCache = {
      ...rateCache,
      USD: parseNum(d.USD.satis),
      EUR: parseNum(d.EUR?.satis),
      USD_Change: parseNum(d.USD.degisim),
      EUR_Change: parseNum(d.EUR?.degisim),
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
  // Zorla yenileme de en fazla 30 sn'de bir dış servise gider (herkese açık uç, dış API'yi yormasın)
  const fresh = force ? 30 * 1000 : ALL_CACHE_MS;
  if (allRatesCache.data && (now - allRatesCache.lastUpdated < fresh)) {
    return allRatesCache.data;
  }

  try {
    console.log('[EXCHANGE] Fetching ALL rates from GenelPara...');

    const [currencyData, goldData] = await Promise.all([
      fetchGenelPara('doviz', 'all', 10000),
      fetchGenelPara('altin', 'all', 10000)
    ]);

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

// Uygulama dış kur servislerine doğrudan değil, sunucu üzerinden erişir (kullanıcı IP'si bu servislere gitmez)
const RAW_SOURCES = new Map([
  ['genelpara-doviz', (s) => `https://api.genelpara.com/json/?list=doviz&sembol=${s}`],
  ['genelpara-altin', (s) => `https://api.genelpara.com/json/?list=altin&sembol=${s}`],
  ['truncgil', () => 'https://finans.truncgil.com/today.json'],
  ['binance', () => `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent('["BTCUSDT","ETHUSDT","PAXGUSDT"]')}`],
  ['er-api', () => 'https://open.er-api.com/v6/latest/USD'],
]);
const SYMBOLS_RE = /^[A-Za-z0-9,-]{1,200}$/;
const RAW_CACHE_MS = 60 * 1000;
const RAW_CACHE_MAX = 50;
const rawCache = new Map();

// GET /api/exchange/raw/:source?sembol=USD,EUR — izin verilen kaynağın yanıtını olduğu gibi döndürür
router.get('/raw/:source', async (req, res) => {
  const buildUrl = RAW_SOURCES.get(req.params.source);
  const symbols = String(req.query.sembol || '');
  if (!buildUrl || (req.params.source.startsWith('genelpara') && !SYMBOLS_RE.test(symbols))) {
    return res.status(400).json({ success: false, error: 'Geçersiz kaynak' });
  }

  const url = buildUrl(symbols);
  const cached = rawCache.get(url);
  if (cached && Date.now() - cached.at < RAW_CACHE_MS) return res.json({ success: true, payload: cached.payload });

  try {
    const genelParaList = req.params.source.startsWith('genelpara-') ? req.params.source.slice('genelpara-'.length) : null;
    const payload = genelParaList
      ? await fetchGenelPara(genelParaList, symbols, 10000)
      : (await axios.get(url, { headers: { 'User-Agent': BROWSER_UA }, timeout: 10000 })).data;
    if (rawCache.size >= RAW_CACHE_MAX) rawCache.clear();
    rawCache.set(url, { at: Date.now(), payload });
    res.json({ success: true, payload });
  } catch (err) {
    if (cached) return res.json({ success: true, payload: cached.payload });
    console.error(`[EXCHANGE] ${req.params.source} alınamadı:`, err.message);
    // 502 gönderilmez: Cloudflare gövdeyi kendi hata metniyle değiştiriyor
    res.status(503).json({ success: false, error: 'Kur verisi alınamadı' });
  }
});

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
module.exports.fetchGenelPara = fetchGenelPara;
