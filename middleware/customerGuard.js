/**
 * customerGuard.js
 * Ödeme yöntemi yetki kontrolü — Express middleware factory.
 *
 * Kullanım (route üzerinde):
 *   const { requirePaymentPermission } = require('../middleware/customerGuard');
 *   router.post('/pay', requirePaymentPermission('CHECK'), handler);
 *
 * userId'yi şu sırayla arar: req.body.userId → req.query.userId → req.params.userId
 */

const { db } = require('../db/turso');
const { PAYMENT_PERMISSIONS, PAYMENT_METHOD_LABELS, CUSTOMER_TYPE_LABELS } = require('../constants/customerTypes');

/**
 * Middleware factory — belirli bir ödeme yöntemine erişim iznini zorunlu kılar.
 * @param {string} requiredMethod - PAYMENT_METHOD sabitlerinden biri
 */
function requirePaymentPermission(requiredMethod) {
  return async (req, res, next) => {
    try {
      const userId =
        req.body?.userId ||
        req.query?.userId ||
        req.params?.userId;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'userId gerekli',
          code: 'MISSING_USER_ID',
        });
      }

      const result = await db.execute({
        sql: 'SELECT customer_type FROM users WHERE id = ?',
        args: [userId],
      });

      const user = result.rows[0];
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'Kullanıcı bulunamadı',
          code: 'USER_NOT_FOUND',
        });
      }

      const customerType = user.customer_type || 'INDIVIDUAL';
      const allowed = PAYMENT_PERMISSIONS[customerType] || [];

      if (!allowed.includes(requiredMethod)) {
        const methodLabel = PAYMENT_METHOD_LABELS[requiredMethod] || requiredMethod;
        const typeLabel   = CUSTOMER_TYPE_LABELS[customerType]   || customerType;

        return res.status(403).json({
          success: false,
          error: `"${methodLabel}" ödeme yöntemi ${typeLabel} hesabı için kullanılamaz.`,
          code: 'PAYMENT_METHOD_NOT_ALLOWED',
          details: {
            requiredMethod,
            customerType,
            allowedMethods: allowed,
          },
        });
      }

      // Downstream handler'lara müşteri tipi bilgisini ilet
      req.customerType = customerType;
      next();
    } catch (err) {
      console.error('[customerGuard] Hata:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

/**
 * Middleware — sadece Kurumsal müşterilere erişim izni verir.
 */
function requireCorporate(req, res, next) {
  return requirePaymentPermission('CORPORATE_CARD')(req, res, () => {
    if (req.customerType !== 'CORPORATE') {
      return res.status(403).json({
        success: false,
        error: 'Bu işlem yalnızca Kurumsal hesaplar için geçerlidir.',
        code: 'CORPORATE_ONLY',
      });
    }
    next();
  });
}

/**
 * Kullanıcının müşteri tipini req'e ekler, erişimi kesmez.
 * Bilgilendirme/log amaçlı kullanılabilir.
 */
async function attachCustomerType(req, res, next) {
  try {
    const userId =
      req.body?.userId ||
      req.query?.userId ||
      req.params?.userId;

    if (userId) {
      const result = await db.execute({
        sql: 'SELECT customer_type FROM users WHERE id = ?',
        args: [userId],
      });
      req.customerType = result.rows[0]?.customer_type || 'INDIVIDUAL';
    }
    next();
  } catch {
    next(); // Hata olsa bile devam et
  }
}

module.exports = {
  requirePaymentPermission,
  requireCorporate,
  attachCustomerType,
};
