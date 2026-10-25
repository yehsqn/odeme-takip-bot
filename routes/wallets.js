const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');

const genId = () => crypto.randomBytes(12).toString('hex');
const { isPremiumActive } = require('./subscription');

// ── Girdi doğrulama ────────────────────────────────────────────────
const WALLET_TYPES = new Set(['bank', 'cash', 'credit_card', 'savings', 'crypto', 'investment']);
const CURRENCIES = new Set(['TRY', 'USD', 'EUR', 'GBP']);
const MAX_WALLETS = 20;
const FREE_WALLETS = 2; // ücretsiz: varsayılan iki cüzdan (yol haritası: çoklu cüzdan Premium)

/** İstek gövdesinden güvenli cüzdan alanları; partial=true ise yalnızca gönderilenler */
function walletFields(body, partial = false) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) out.name = String(body.name ?? '').trim().slice(0, 40);
  if (!partial || has('type')) out.type = WALLET_TYPES.has(body.type) ? body.type : 'bank';
  if (!partial || has('balance')) {
    const b = Number(body.balance);
    out.balance = Number.isFinite(b) && Math.abs(b) < 1e12 ? Math.round(b * 100) / 100 : 0;
  }
  if (!partial || has('currency')) out.currency = CURRENCIES.has(body.currency) ? body.currency : 'TRY';
  if (!partial || has('color')) out.color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? body.color : '#3b82f6';
  if (!partial || has('icon')) out.icon = /^[A-Za-z]{1,24}$/.test(String(body.icon || '')) ? body.icon : 'Wallet';
  if (!partial || has('bankName')) out.bankName = String(body.bankName ?? '').trim().slice(0, 40);
  if (!partial || has('ibanLast4')) out.ibanLast4 = /^\d{4}$/.test(String(body.ibanLast4 || '')) ? String(body.ibanLast4) : '';
  return out;
}

async function userIsPremium(userId) {
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [userId] })).rows[0];
  return isPremiumActive(u);
}

// GET /api/wallets — Kullanıcının cüzdanlarını getir (yoksa varsayılan cüzdanları oluşturur)
router.get('/', async (req, res) => {
  try {
    const userId = req.authUserId;
    if (!userId) return res.status(401).json({ success: false, error: 'Oturum gerekli' });

    let r = await db.execute({
      sql: `SELECT * FROM wallets WHERE user_id = ? ORDER BY is_default DESC, created_at ASC`,
      args: [userId]
    });

    // İlk defa açıyorsa varsayılan 2 cüzdan oluştur
    if (r.rows.length === 0) {
      const defaultWallets = [
        {
          id: genId(),
          name: 'Nakit Cüzdanı',
          type: 'cash',
          balance: 0,
          currency: 'TRY',
          color: '#10b981',
          icon: 'Wallet',
          is_default: 1
        },
        {
          id: genId(),
          name: 'Ana Banka Hesabı',
          type: 'bank',
          balance: 0,
          currency: 'TRY',
          color: '#3b82f6',
          icon: 'Landmark',
          is_default: 0
        }
      ];

      for (const w of defaultWallets) {
        await db.execute({
          sql: `INSERT INTO wallets (id, user_id, name, type, balance, currency, color, icon, is_default, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
          args: [w.id, userId, w.name, w.type, w.balance, w.currency, w.color, w.icon, w.is_default]
        });
      }

      r = await db.execute({
        sql: `SELECT * FROM wallets WHERE user_id = ? ORDER BY is_default DESC, created_at ASC`,
        args: [userId]
      });
    }

    const wallets = r.rows.map(w => ({
      id: w.id,
      name: w.name,
      type: w.type,
      balance: Number(w.balance) || 0,
      currency: w.currency || 'TRY',
      color: w.color || '#3b82f6',
      icon: w.icon || 'Wallet',
      bankName: w.bank_name || '',
      ibanLast4: w.iban_last4 || '',
      isDefault: Boolean(w.is_default),
      createdAt: w.created_at,
      updatedAt: w.updated_at
    }));

    const totalBalanceTRY = wallets.reduce((acc, w) => acc + (w.currency === 'TRY' ? w.balance : 0), 0);

    res.json({
      success: true,
      wallets,
      totalBalanceTRY
    });
  } catch (err) {
    console.error('[WALLETS] List error:', err.message);
    res.status(500).json({ success: false, error: 'Cüzdanlar getirilemedi' });
  }
});

// POST /api/wallets — Yeni cüzdan oluştur
router.post('/', async (req, res) => {
  try {
    const userId = req.authUserId;
    const f = walletFields(req.body || {});
    if (!f.name) return res.status(400).json({ success: false, error: 'Cüzdan adı gerekli' });

    const cnt = Number((await db.execute({ sql: 'SELECT COUNT(*) AS cnt FROM wallets WHERE user_id = ?', args: [userId] })).rows[0]?.cnt || 0);
    if (cnt >= MAX_WALLETS) return res.status(400).json({ success: false, error: `En fazla ${MAX_WALLETS} cüzdan oluşturabilirsiniz.` });
    if (cnt >= FREE_WALLETS && !(await userIsPremium(userId))) {
      return res.status(403).json({ success: false, premiumRequired: true, error: 'Ek cüzdanlar Premium özelliğidir.' });
    }

    const id = genId();
    const isDef = req.body?.isDefault ? 1 : 0;
    const stmts = [];
    if (isDef) stmts.push({ sql: 'UPDATE wallets SET is_default = 0 WHERE user_id = ?', args: [userId] });
    stmts.push({
      sql: `INSERT INTO wallets (id, user_id, name, type, balance, currency, color, icon, bank_name, iban_last4, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [id, userId, f.name, f.type, f.balance, f.currency, f.color, f.icon, f.bankName, f.ibanLast4, isDef],
    });
    await db.batch(stmts, 'write');

    res.json({ success: true, wallet: { id, ...f, isDefault: Boolean(isDef) } });
  } catch (err) {
    console.error('[WALLETS] Create error:', err.message);
    res.status(500).json({ success: false, error: 'Cüzdan oluşturulamadı' });
  }
});

// PUT /api/wallets/:id — Cüzdan güncelle
router.put('/:id', async (req, res) => {
  try {
    const userId = req.authUserId;
    const id = String(req.params.id);
    const own = await db.execute({ sql: 'SELECT id FROM wallets WHERE id = ? AND user_id = ?', args: [id, userId] });
    if (!own.rows.length) return res.status(404).json({ success: false, error: 'Cüzdan bulunamadı' });

    const f = walletFields(req.body || {}, true);
    if (f.name !== undefined && !f.name) return res.status(400).json({ success: false, error: 'Cüzdan adı boş olamaz' });
    const cols = { name: 'name', type: 'type', balance: 'balance', currency: 'currency', color: 'color', icon: 'icon', bankName: 'bank_name', ibanLast4: 'iban_last4' };
    const sets = [];
    const args = [];
    for (const [k, col] of Object.entries(cols)) if (f[k] !== undefined) { sets.push(`${col} = ?`); args.push(f[k]); }

    const stmts = [];
    if (req.body?.isDefault !== undefined) {
      if (req.body.isDefault) stmts.push({ sql: 'UPDATE wallets SET is_default = 0 WHERE user_id = ?', args: [userId] });
      sets.push('is_default = ?');
      args.push(req.body.isDefault ? 1 : 0);
    }
    if (sets.length) {
      stmts.push({ sql: `UPDATE wallets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`, args: [...args, id, userId] });
      await db.batch(stmts, 'write');
    }

    res.json({ success: true, message: 'Cüzdan güncellendi' });
  } catch (err) {
    console.error('[WALLETS] Update error:', err.message);
    res.status(500).json({ success: false, error: 'Cüzdan güncellenemedi' });
  }
});

// DELETE /api/wallets/:id — Cüzdan sil
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.authUserId;
    const { id } = req.params;

    // Kalan tek cüzdansa silinmesini engelle
    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM wallets WHERE user_id = ?`,
      args: [userId]
    });
    if (Number(countRes.rows[0]?.cnt || 0) <= 1) {
      return res.status(400).json({ success: false, error: 'En az bir adet aktif cüzdanınız bulunmalıdır.' });
    }

    await db.execute({
      sql: `DELETE FROM wallets WHERE id = ? AND user_id = ?`,
      args: [id, userId]
    });

    res.json({ success: true, message: 'Cüzdan silindi' });
  } catch (err) {
    console.error('[WALLETS] Delete error:', err.message);
    res.status(500).json({ success: false, error: 'Cüzdan silinemedi' });
  }
});

// POST /api/wallets/transfer — Cüzdanlar arası bakiye transferi
router.post('/transfer', async (req, res) => {
  try {
    const userId = req.authUserId;
    const { fromWalletId, toWalletId, amount, note, date } = req.body;

    const transferAmount = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(transferAmount) || transferAmount <= 0 || transferAmount >= 1e12) {
      return res.status(400).json({ success: false, error: 'Geçerli bir transfer tutarı giriniz' });
    }
    if (!fromWalletId || !toWalletId || fromWalletId === toWalletId) {
      return res.status(400).json({ success: false, error: 'Kaynak ve hedef cüzdan farklı olmalıdır' });
    }

    // İki cüzdanın da kullanıcıya ait olduğunu doğrula
    const checkRes = await db.execute({
      sql: `SELECT id, balance, currency, name FROM wallets WHERE user_id = ? AND id IN (?, ?)`,
      args: [userId, fromWalletId, toWalletId]
    });

    if (checkRes.rows.length < 2) {
      return res.status(404).json({ success: false, error: 'Transfer edilecek cüzdanlar bulunamadı' });
    }

    const fromW = checkRes.rows.find(w => w.id === fromWalletId);
    const toW = checkRes.rows.find(w => w.id === toWalletId);

    if ((fromW.currency || 'TRY') !== (toW.currency || 'TRY')) {
      return res.status(400).json({ success: false, error: 'Farklı para birimindeki cüzdanlar arasında transfer yapılamaz.' });
    }

    const transferId = genId();
    const transferDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().split('T')[0];
    const safeNote = String(note || '').trim().slice(0, 120);

    // Atomik bakiye güncellemesi ve transfer kaydı
    await db.batch([
      {
        sql: `UPDATE wallets SET balance = balance - ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        args: [transferAmount, fromWalletId, userId]
      },
      {
        sql: `UPDATE wallets SET balance = balance + ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        args: [transferAmount, toWalletId, userId]
      },
      {
        sql: `INSERT INTO wallet_transfers (id, user_id, from_wallet_id, to_wallet_id, amount, currency, note, date, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [transferId, userId, fromWalletId, toWalletId, transferAmount, fromW.currency || 'TRY', safeNote, transferDate]
      }
    ], 'write');

    res.json({
      success: true,
      message: `${fromW.name} → ${toW.name} transferi başarıyla gerçekleşti.`,
      transferId
    });
  } catch (err) {
    console.error('[WALLETS] Transfer error:', err.message);
    res.status(500).json({ success: false, error: 'Transfer işlemi gerçekleştirilemedi' });
  }
});

// GET /api/wallets/transfers — Transfer geçmişi
router.get('/transfers', async (req, res) => {
  try {
    const userId = req.authUserId;
    const r = await db.execute({
      sql: `SELECT t.*,
                   fw.name as from_wallet_name, fw.color as from_wallet_color,
                   tw.name as to_wallet_name, tw.color as to_wallet_color
            FROM wallet_transfers t
            LEFT JOIN wallets fw ON fw.id = t.from_wallet_id
            LEFT JOIN wallets tw ON tw.id = t.to_wallet_id
            WHERE t.user_id = ?
            ORDER BY datetime(t.created_at) DESC
            LIMIT 50`,
      args: [userId]
    });

    const transfers = r.rows.map(t => ({
      id: t.id,
      fromWalletId: t.from_wallet_id,
      fromWalletName: t.from_wallet_name || 'Bilinmeyen Cüzdan',
      fromWalletColor: t.from_wallet_color || '#64748b',
      toWalletId: t.to_wallet_id,
      toWalletName: t.to_wallet_name || 'Bilinmeyen Cüzdan',
      toWalletColor: t.to_wallet_color || '#3b82f6',
      amount: Number(t.amount),
      currency: t.currency || 'TRY',
      note: t.note || '',
      date: t.date,
      createdAt: t.created_at
    }));

    res.json({ success: true, transfers });
  } catch (err) {
    console.error('[WALLETS] Transfers history error:', err.message);
    res.status(500).json({ success: false, error: 'Transfer geçmişi getirilemedi' });
  }
});

module.exports = router;
