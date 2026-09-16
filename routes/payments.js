const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const crypto = require('crypto');
const { sendToUser } = require('../websocket');

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// Helper: row → payment response (parse JSON fields)
function formatPayment(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.payment_id || row.id,
    userId: row.user_id,
    title: row.title,
    amount: row.amount,
    installments: row.installments,
    date: row.date,
    category: row.category,
    bank: row.bank,
    type: row.type,
    installmentPlan: JSON.parse(row.installment_plan || '[]'),
    currency: row.currency || 'TRY',
    originalAmount: row.original_amount,
    createdAt: row.created_at,
  };
}

// GET /api/payments/:userId
router.get('/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM payments WHERE user_id = ?',
      args: [req.params.userId]
    });
    const payments = result.rows.map(formatPayment);
    res.json({ success: true, payments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/payments
router.post('/', async (req, res) => {
  try {
    const p = req.body;
    const id = genId();
    await db.execute({
      sql: `INSERT INTO payments (id, user_id, payment_id, title, amount, installments, date, category, bank, type, installment_plan, currency, original_amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, p.userId, p.id || id, p.title, p.amount, p.installments,
        p.date, p.category, p.bank, p.type,
        JSON.stringify(p.installmentPlan || []),
        p.currency || 'TRY', p.originalAmount || null, p.createdAt || new Date().toISOString()
      ]
    });
    const result = await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [id] });
    const newPayment = formatPayment(result.rows[0]);

    // Anlık bildirim: ödeme eklendi
    const amountStr = (p.amount || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    sendToUser(p.userId, {
      type: 'payment_added',
      title: '💳 Yeni Ödeme Eklendi',
      body: `${p.title} — ${amountStr} TL tutarında ödeme sisteme eklendi.`,
      paymentId: id,
    }).catch((err) => console.error('[WS] Ödeme ekleme bildirimi hatası:', err.message));

    res.json({ success: true, payment: newPayment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/payments/:id
router.put('/:id', async (req, res) => {
  try {
    const p = req.body;
    const sets = [];
    const args = [];

    if (p.title !== undefined) { sets.push('title = ?'); args.push(p.title); }
    if (p.amount !== undefined) { sets.push('amount = ?'); args.push(p.amount); }
    if (p.installments !== undefined) { sets.push('installments = ?'); args.push(p.installments); }
    if (p.date !== undefined) { sets.push('date = ?'); args.push(p.date); }
    if (p.category !== undefined) { sets.push('category = ?'); args.push(p.category); }
    if (p.bank !== undefined) { sets.push('bank = ?'); args.push(p.bank); }
    if (p.type !== undefined) { sets.push('type = ?'); args.push(p.type); }
    if (p.installmentPlan !== undefined) { sets.push('installment_plan = ?'); args.push(JSON.stringify(p.installmentPlan)); }
    if (p.currency !== undefined) { sets.push('currency = ?'); args.push(p.currency); }
    if (p.originalAmount !== undefined) { sets.push('original_amount = ?'); args.push(p.originalAmount); }

    if (sets.length > 0) {
      args.push(req.params.id);
      await db.execute({ sql: `UPDATE payments SET ${sets.join(', ')} WHERE id = ?`, args });
    }

    const result = await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [req.params.id] });
    res.json({ success: true, payment: formatPayment(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/payments/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM payments WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/payments/:id/installment — mark installment paid/unpaid
router.put('/:id/installment', async (req, res) => {
  try {
    const { installmentIndex, isPaid } = req.body;
    const result = await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [req.params.id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ success: false, error: 'Ödeme bulunamadı' });

    const plan = JSON.parse(row.installment_plan || '[]');
    if (plan[installmentIndex] !== undefined) {
      plan[installmentIndex].isPaid = isPaid;
      await db.execute({
        sql: 'UPDATE payments SET installment_plan = ? WHERE id = ?',
        args: [JSON.stringify(plan), req.params.id]
      });

      // Anlık bildirim: taksit ödendi
      if (isPaid) {
        const inst = plan[installmentIndex];
        const amtStr = (inst?.amount || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const userId = row.user_id;
        sendToUser(userId, {
          type: 'payment_paid',
          title: '✅ Taksit Ödendi',
          body: `${row.title} — ${amtStr} TL taksitiniz ödendi olarak işaretlendi.`,
          paymentId: req.params.id,
        }).catch((err) => console.error('[WS] Taksit bildirim hatası:', err.message));
      }
    }

    const updated = await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [req.params.id] });
    res.json({ success: true, payment: formatPayment(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
