const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const { computePulse, stageFor, LEAGUES } = require('../game/pulseScore');
const { parsePlan } = require('../game/stamp');
const { sendToUser } = require('../websocket');
const { areFriends, isBlockedEitherWay, publicName } = require('./social');

// Puanlar sunucudaki kayıtlardan hesaplanır (istemcinin gönderdiği puana güvenilmez)
const cache = new Map(); // userId → { at, data }
const CACHE_MS = 2 * 60 * 1000;

async function scoreFor(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const [pay, set] = await Promise.all([
    db.execute({ sql: 'SELECT title, installment_plan, created_at FROM payments WHERE user_id = ?', args: [userId] }),
    db.execute({ sql: 'SELECT extras FROM settings WHERE user_id = ?', args: [userId] }),
  ]);
  let extras = {};
  try { extras = JSON.parse(set.rows[0]?.extras || '{}') || {}; } catch { extras = {}; }
  const data = computePulse({
    payments: pay.rows.map(r => ({ title: r.title, installmentPlan: parsePlan(r.installment_plan), createdAt: r.created_at })),
    goals: Array.isArray(extras.goals) ? extras.goals : [],
    budgets: extras.budgets && typeof extras.budgets === 'object' ? extras.budgets : {},
  });
  cache.set(userId, { at: Date.now(), data });
  return data;
}

// Tüm oyuncuların puanı: istek başına değil 60 sn'de bir hesaplanır (spam ile sunucu yorulmasın)
let board = { at: 0, rows: null, pending: null };
async function scoredPlayers() {
  if (board.rows && Date.now() - board.at < 60 * 1000) return board.rows;
  if (!board.pending) {
    board.pending = (async () => {
      const all = (await db.execute('SELECT * FROM game_profiles WHERE opt_in = 1')).rows;
      const rows = [];
      for (const p of all) {
        const s = await scoreFor(p.user_id);
        if (s.suspicious) continue; // olağandışı puan artışı: incelemeye düşer, listede görünmez
        rows.push({ p, s });
      }
      board = { at: Date.now(), rows, pending: null };
      return rows;
    })().catch((err) => { board.pending = null; throw err; });
  }
  return board.pending;
}
const resetBoard = () => { board = { at: 0, rows: null, pending: null }; };

const getProfile = async (userId) =>
  (await db.execute({ sql: 'SELECT * FROM game_profiles WHERE user_id = ?', args: [userId] })).rows[0] || null;

const season = (d = new Date()) => `${d.getFullYear()}-S${Math.floor(d.getMonth() / 3) + 1}`;

// Sıralamada yalnızca takma ad, aşama ve puan görünür — tutar/gelir/borç asla
const publicRow = (p, s, me) => ({
  nickname: p.nickname,
  week: s.week,
  total: s.total,
  stage: s.index,
  me: p.user_id === me,
});

// GET /api/game/me
router.get('/me', async (req, res) => {
  try {
    const [score, profile] = await Promise.all([scoreFor(req.authUserId), getProfile(req.authUserId)]);
    res.json({
      success: true,
      score: { total: score.total, week: score.week, index: score.index, streak: score.streak },
      profile: profile ? { nickname: profile.nickname, optIn: !!profile.opt_in, league: LEAGUES[profile.league] || LEAGUES[0] } : null,
      season: season(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Oyun verisi alınamadı' });
  }
});

// POST /api/game/profile { nickname, optIn }
router.post('/profile', async (req, res) => {
  try {
    const optIn = !!req.body?.optIn;
    const nickname = String(req.body?.nickname || '').trim().replace(/\s+/g, ' ');
    if (optIn && !/^[\p{L}\p{N}_ .-]{3,20}$/u.test(nickname)) {
      return res.status(400).json({ success: false, error: 'Takma ad 3-20 karakter olmalı (harf, rakam, boşluk, _ . -).' });
    }
    if (optIn) {
      const taken = await db.execute({
        sql: 'SELECT user_id FROM game_profiles WHERE lower(nickname) = lower(?) AND user_id != ?',
        args: [nickname, req.authUserId],
      });
      if (taken.rows.length) return res.status(409).json({ success: false, error: 'Bu takma ad alınmış.' });
    }
    await db.execute({
      sql: `INSERT INTO game_profiles (user_id, nickname, opt_in) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET nickname = COALESCE(NULLIF(excluded.nickname, ''), game_profiles.nickname), opt_in = excluded.opt_in`,
      args: [req.authUserId, nickname, optIn ? 1 : 0],
    });
    resetBoard();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Profil kaydedilemedi' });
  }
});

// GET /api/game/leaderboard — kendi ligin (haftalık) + genel ilk 50
router.get('/leaderboard', async (req, res) => {
  try {
    const me = await getProfile(req.authUserId);
    const scored = [...await scoredPlayers()];
    const league = me ? me.league : 0;
    const leagueRows = scored
      .filter(x => x.p.league === league)
      .sort((a, b) => b.s.week - a.s.week || b.s.total - a.s.total)
      .slice(0, 30)
      .map(x => publicRow(x.p, x.s, req.authUserId));
    const overall = scored
      .sort((a, b) => b.s.total - a.s.total)
      .slice(0, 50)
      .map(x => publicRow(x.p, x.s, req.authUserId));
    res.json({ success: true, league: LEAGUES[league] || LEAGUES[0], leagueRows, overall, joined: !!(me && me.opt_in) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Sıralama alınamadı' });
  }
});

// ── Arkadaş şehri ───────────────────────────────────────────────
const CITY_BUILDINGS = new Set(['house', 'garden', 'market', 'park', 'bank', 'school', 'skyscraper', 'stadium', 'tower']);
const CITY_SLOT = /^[0-3]-[0-3]$/;
const trDayNumber = () => Math.floor((Date.now() + 3 * 3600000) / 86400000);

const readExtras = async (userId) => {
  const r = await db.execute({ sql: 'SELECT extras FROM settings WHERE user_id = ?', args: [userId] });
  try { return JSON.parse(r.rows[0]?.extras || '{}') || {}; } catch { return {}; }
};

// extras istemciden gelir: yalnızca bilinen parsel ve binalar dışarı verilir
const safeLayout = (layout) => Object.fromEntries(
  Object.entries(layout && typeof layout === 'object' ? layout : {})
    .filter(([slot, type]) => CITY_SLOT.test(slot) && CITY_BUILDINGS.has(type))
);

// Yalnızca kabul edilmiş, engellenmemiş arkadaşlar (sebep yanıttan anlaşılmaz)
async function requireFriend(req, res, next) {
  try {
    const friendId = String(req.params.friendId);
    if (friendId === req.authUserId
      || await isBlockedEitherWay(req.authUserId, friendId)
      || !(await areFriends(req.authUserId, friendId))) {
      return res.status(403).json({ success: false, error: 'Yalnızca arkadaşlarının şehrini ziyaret edebilirsin.' });
    }
    req.friendId = friendId;
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: 'Arkadaş bilgisi alınamadı' });
  }
}

// GET /api/game/friends/:friendId/city — yalnızca aşama adı ve yerleşim (puan, tutar, borç asla)
router.get('/friends/:friendId/city', requireFriend, async (req, res) => {
  try {
    const extras = await readExtras(req.friendId);
    if (extras.pulseCityHidden) return res.json({ success: true, hidden: true });

    const [score, cheer] = await Promise.all([
      scoreFor(req.friendId),
      db.execute({
        sql: 'SELECT 1 FROM game_cheers WHERE sender_id = ? AND receiver_id = ? AND day = ?',
        args: [req.authUserId, req.friendId, trDayNumber()],
      }),
    ]);
    const earned = score.total + (Number(extras.pulseBonusPoints) || 0);
    res.json({
      success: true,
      hidden: false,
      stage: stageFor(earned).stage.name,
      layout: safeLayout(extras.pulseCityLayout),
      cheeredToday: cheer.rows.length > 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Arkadaşın şehri alınamadı' });
  }
});

// POST /api/game/friends/:friendId/cheer — arkadaş başına günde bir tebrik, karşı tarafa bildirim gider
router.post('/friends/:friendId/cheer', requireFriend, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'INSERT OR IGNORE INTO game_cheers (sender_id, receiver_id, day) VALUES (?, ?, ?)',
      args: [req.authUserId, req.friendId, trDayNumber()],
    });
    if (result.rowsAffected > 0) {
      const sender = (await db.execute({ sql: 'SELECT display_name FROM users WHERE id = ?', args: [req.authUserId] })).rows[0];
      sendToUser(req.friendId, {
        type: 'CITY_CHEER',
        title: '🏙️ Şehrin tebrik edildi',
        body: `${publicName(sender)} PulseCity şehrini ziyaret etti ve seni tebrik etti.`,
      }).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Tebrik gönderilemedi' });
  }
});

/**
 * Haftalık lig turu (Pazartesi): her ligde geçen haftanın ilk 5'i üst lige çıkar, son 5'i düşer.
 * Küçük liglerde oran korunur (üye sayısının üçte biri, en az 1).
 */
async function runWeeklyLeagues() {
  const weekKey = (() => {
    const d = new Date(Date.now() + 3 * 3600000);
    const n = Math.floor(d.getTime() / 86400000);
    return String(n - ((n + 3) % 7));
  })();
  const all = (await db.execute('SELECT * FROM game_profiles WHERE opt_in = 1')).rows
    .filter(p => p.last_week !== weekKey);
  for (let l = 0; l < LEAGUES.length; l++) {
    const members = [];
    for (const p of all.filter(p => p.league === l)) members.push({ p, s: await scoreFor(p.user_id) });
    members.sort((a, b) => b.s.lastWeek - a.s.lastWeek);
    const k = Math.min(5, Math.max(1, Math.floor(members.length / 3)));
    const stmts = members.map((m, i) => {
      let league = l;
      if (members.length >= 2 && i < k && l < LEAGUES.length - 1 && m.s.lastWeek > 0) league = l + 1;
      else if (members.length >= 2 && i >= members.length - k && l > 0) league = l - 1;
      return { sql: 'UPDATE game_profiles SET league = ?, last_week = ? WHERE user_id = ?', args: [league, weekKey, m.p.user_id] };
    });
    if (stmts.length) await db.batch(stmts, 'write');
  }
  console.log('[GAME] Haftalık lig turu tamamlandı:', weekKey);
}

module.exports = router;
module.exports.runWeeklyLeagues = runWeeklyLeagues;
module.exports.invalidateScore = (userId) => cache.delete(userId);
