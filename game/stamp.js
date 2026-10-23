/**
 * PulseCity hile koruması: oluşturma ve "ödendi" zamanlarını istemci değil sunucu belirler.
 * - createdAt: kayıt daha önce varsa eski değer korunur, yoksa sunucu saati.
 * - paidAt: taksit bu kayıtta ödendi yapıldıysa sunucu saati; zaten ödenmişse eski değer;
 *   ödenmemişse silinir. İstemcinin gönderdiği değerler yok sayılır.
 */

const parsePlan = (raw) => {
  try { return JSON.parse(raw || '[]') || []; } catch { return []; }
};

function stampPlan(newPlan, oldPlan, nowIso) {
  if (!Array.isArray(newPlan)) return newPlan;
  const old = new Map((oldPlan || []).map((i, idx) => [i.id ?? `#${idx}`, i]));
  return newPlan.map((inst, idx) => {
    if (!inst || typeof inst !== 'object') return inst;
    const prev = old.get(inst.id ?? `#${idx}`);
    const out = { ...inst };
    if (inst.isPaid) {
      if (prev && prev.isPaid) {
        if (prev.paidAt) out.paidAt = prev.paidAt; else delete out.paidAt; // eski kayıt: bilinmiyor
      } else {
        out.paidAt = nowIso;
      }
    } else {
      delete out.paidAt;
    }
    return out;
  });
}

/** Toplu kayıt: mevcut satırlar (payment_id → row) ile yeni listeyi damgalar */
function stampPayments(payments, existingRows, nowIso = new Date().toISOString()) {
  const byPid = new Map((existingRows || []).map(r => [r.payment_id, r]));
  return payments.map(p => {
    const row = p && p.id ? byPid.get(p.id) : null;
    return {
      ...p,
      createdAt: row ? (row.created_at || null) : nowIso,
      installmentPlan: stampPlan(p.installmentPlan || [], row ? parsePlan(row.installment_plan) : [], nowIso),
    };
  });
}

module.exports = { stampPlan, stampPayments, parsePlan };
