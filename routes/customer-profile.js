/**
 * customer-profile.js
 * Müşteri profili CRUD endpoint'leri.
 *
 * GET  /api/customer-profile/:userId           → Profil bilgilerini döner
 * PUT  /api/customer-profile/:userId           → Profil güncelleme
 * GET  /api/customer-profile/:userId/permissions → İzin verilen ödeme yöntemleri
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/turso');
const {
  CUSTOMER_TYPE,
  PAYMENT_PERMISSIONS,
  PAYMENT_METHOD_LABELS,
  CUSTOMER_TYPE_LABELS,
} = require('../constants/customerTypes');

// ─── Yardımcı: Bireysel profil satırını formatlı objeye çevir ──────
function formatIndividualProfile(row) {
  if (!row) return null;
  return {
    type: CUSTOMER_TYPE.INDIVIDUAL,
    firstName:   row.first_name   || '',
    lastName:    row.last_name    || '',
    tcIdentity:  row.tc_identity  || '',
    phone:       row.phone        || '',
    address:     row.address      || '',
    billAddress: row.bill_address || '',
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  };
}

// ─── Yardımcı: Kurumsal profil satırını formatlı objeye çevir ─────
function formatCorporateProfile(row) {
  if (!row) return null;
  return {
    type:              CUSTOMER_TYPE.CORPORATE,
    companyName:       row.company_name       || '',
    taxOffice:         row.tax_office         || '',
    taxNumber:         row.tax_number         || '',
    authorizedName:    row.authorized_name    || '',
    authorizedSurname: row.authorized_surname || '',
    phone:             row.phone              || '',
    companyAddress:    row.company_address    || '',
    eInvoiceAlias:     row.e_invoice_alias    || '',
    createdAt:         row.created_at,
    updatedAt:         row.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────────
// GET /api/customer-profile/:userId
// Kullanıcı tipini ve ilgili profil bilgilerini döner.
// ─────────────────────────────────────────────────────────────────
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userRes = await db.execute({
      sql: 'SELECT id, email, customer_type, display_name FROM users WHERE id = ?',
      args: [userId],
    });
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const customerType = user.customer_type || CUSTOMER_TYPE.INDIVIDUAL;
    let profile = null;

    if (customerType === CUSTOMER_TYPE.INDIVIDUAL) {
      const r = await db.execute({
        sql: 'SELECT * FROM individual_profiles WHERE user_id = ?',
        args: [userId],
      });
      profile = formatIndividualProfile(r.rows[0]);
    } else {
      const r = await db.execute({
        sql: 'SELECT * FROM corporate_profiles WHERE user_id = ?',
        args: [userId],
      });
      profile = formatCorporateProfile(r.rows[0]);
    }

    res.json({
      success: true,
      customerType,
      customerTypeLabel: CUSTOMER_TYPE_LABELS[customerType],
      profileComplete: profile !== null,
      profile,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/customer-profile/:userId/permissions
// Kullanıcının erişebildiği ödeme yöntemlerini döner.
// ─────────────────────────────────────────────────────────────────
router.get('/:userId/permissions', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await db.execute({
      sql: 'SELECT customer_type FROM users WHERE id = ?',
      args: [userId],
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const customerType = user.customer_type || CUSTOMER_TYPE.INDIVIDUAL;
    const allowed = PAYMENT_PERMISSIONS[customerType] || [];

    res.json({
      success: true,
      customerType,
      allowedMethods: allowed.map(method => ({
        key:   method,
        label: PAYMENT_METHOD_LABELS[method] || method,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// PUT /api/customer-profile/:userId
// Profil bilgilerini günceller. customer_type değiştirilemez.
// ─────────────────────────────────────────────────────────────────
router.put('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userRes = await db.execute({
      sql: 'SELECT customer_type FROM users WHERE id = ?',
      args: [userId],
    });
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ success: false, error: 'Kullanıcı bulunamadı' });

    const customerType = user.customer_type || CUSTOMER_TYPE.INDIVIDUAL;
    const now = new Date().toISOString();

    if (customerType === CUSTOMER_TYPE.INDIVIDUAL) {
      const { firstName, lastName, tcIdentity, phone, address, billAddress } = req.body;
      // Var mı kontrol et
      const existing = await db.execute({
        sql: 'SELECT id FROM individual_profiles WHERE user_id = ?',
        args: [userId],
      });

      if (existing.rows.length > 0) {
        await db.execute({
          sql: `UPDATE individual_profiles
                SET first_name = ?, last_name = ?, tc_identity = ?, phone = ?,
                    address = ?, bill_address = ?, updated_at = ?
                WHERE user_id = ?`,
          args: [firstName, lastName, tcIdentity, phone, address || '', billAddress || '', now, userId],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO individual_profiles
                  (user_id, first_name, last_name, tc_identity, phone, address, bill_address, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [userId, firstName, lastName, tcIdentity, phone, address || '', billAddress || '', now],
        });
      }
      // display_name güncelle
      await db.execute({
        sql: 'UPDATE users SET display_name = ? WHERE id = ?',
        args: [`${firstName} ${lastName}`.trim(), userId],
      });

    } else {
      // Kurumsal
      const { companyName, taxOffice, taxNumber, authorizedName, authorizedSurname, phone, companyAddress, eInvoiceAlias } = req.body;
      const existing = await db.execute({
        sql: 'SELECT id FROM corporate_profiles WHERE user_id = ?',
        args: [userId],
      });

      if (existing.rows.length > 0) {
        await db.execute({
          sql: `UPDATE corporate_profiles
                SET company_name = ?, tax_office = ?, tax_number = ?,
                    authorized_name = ?, authorized_surname = ?, phone = ?,
                    company_address = ?, e_invoice_alias = ?, updated_at = ?
                WHERE user_id = ?`,
          args: [companyName, taxOffice, taxNumber, authorizedName, authorizedSurname, phone, companyAddress, eInvoiceAlias || '', now, userId],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO corporate_profiles
                  (user_id, company_name, tax_office, tax_number, authorized_name,
                   authorized_surname, phone, company_address, e_invoice_alias, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [userId, companyName, taxOffice, taxNumber, authorizedName, authorizedSurname, phone, companyAddress, eInvoiceAlias || '', now],
        });
      }
      // display_name güncelle
      await db.execute({
        sql: 'UPDATE users SET display_name = ? WHERE id = ?',
        args: [companyName, userId],
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
