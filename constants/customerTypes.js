/**
 * customerTypes.js
 * Müşteri tipi ve ödeme yöntemi enum sabitleri + yetki matrisi.
 * Hem backend guard middleware hem de frontend validasyon mantığı bu sabitleri kullanır.
 */

// ── Müşteri Tipi ────────────────────────────────────────────────
const CUSTOMER_TYPE = Object.freeze({
  INDIVIDUAL: 'INDIVIDUAL', // Bireysel
  CORPORATE:  'CORPORATE',  // Kurumsal
});

// ── Ödeme Yöntemi ───────────────────────────────────────────────
const PAYMENT_METHOD = Object.freeze({
  // Bireysel & Kurumsal — ortak
  CREDIT_CARD:      'CREDIT_CARD',      // Kredi / Banka Kartı
  BANK_TRANSFER:    'BANK_TRANSFER',    // Havale / EFT
  DIGITAL_WALLET:   'DIGITAL_WALLET',  // Dijital Cüzdan
  SUBSCRIPTION:     'SUBSCRIPTION',    // Abonelik / Fatura

  // Yalnızca Kurumsal
  CORPORATE_CARD:   'CORPORATE_CARD',  // Kurumsal Kart
  E_INVOICE:        'E_INVOICE',       // E-Fatura / E-Arşiv
  CURRENT_ACCOUNT:  'CURRENT_ACCOUNT', // Cari Hesap
  CHECK:            'CHECK',           // Çek
  PROMISSORY_NOTE:  'PROMISSORY_NOTE', // Senet
  DEFERRED_PAYMENT: 'DEFERRED_PAYMENT',// Vadeli / Açık Hesap (B2B)
});

// ── Yetki Matrisi ────────────────────────────────────────────────
// Bireysel müşterilere ticari enstrümanlar kesinlikle kapalı.
const PAYMENT_PERMISSIONS = Object.freeze({
  [CUSTOMER_TYPE.INDIVIDUAL]: Object.freeze([
    PAYMENT_METHOD.CREDIT_CARD,
    PAYMENT_METHOD.BANK_TRANSFER,
    PAYMENT_METHOD.DIGITAL_WALLET,
    PAYMENT_METHOD.SUBSCRIPTION,
  ]),
  [CUSTOMER_TYPE.CORPORATE]: Object.freeze(Object.values(PAYMENT_METHOD)),
});

// ── İnsan okunabilir etiketler (UI & hata mesajları için) ────────
const PAYMENT_METHOD_LABELS = Object.freeze({
  [PAYMENT_METHOD.CREDIT_CARD]:      'Kredi / Banka Kartı',
  [PAYMENT_METHOD.BANK_TRANSFER]:    'Havale / EFT',
  [PAYMENT_METHOD.DIGITAL_WALLET]:   'Dijital Cüzdan',
  [PAYMENT_METHOD.SUBSCRIPTION]:     'Abonelik / Fatura',
  [PAYMENT_METHOD.CORPORATE_CARD]:   'Kurumsal Kart',
  [PAYMENT_METHOD.E_INVOICE]:        'E-Fatura / E-Arşiv',
  [PAYMENT_METHOD.CURRENT_ACCOUNT]:  'Cari Hesap',
  [PAYMENT_METHOD.CHECK]:            'Çek',
  [PAYMENT_METHOD.PROMISSORY_NOTE]:  'Senet',
  [PAYMENT_METHOD.DEFERRED_PAYMENT]: 'Vadeli / Açık Hesap',
});

const CUSTOMER_TYPE_LABELS = Object.freeze({
  [CUSTOMER_TYPE.INDIVIDUAL]: 'Bireysel',
  [CUSTOMER_TYPE.CORPORATE]:  'Kurumsal',
});

/**
 * Bir müşteri tipinin verilen ödeme yöntemine erişip erişemeyeceğini kontrol eder.
 * @param {string} customerType - CUSTOMER_TYPE değeri
 * @param {string} paymentMethod - PAYMENT_METHOD değeri
 * @returns {boolean}
 */
function canUsePaymentMethod(customerType, paymentMethod) {
  const allowed = PAYMENT_PERMISSIONS[customerType];
  if (!allowed) return false;
  return allowed.includes(paymentMethod);
}

module.exports = {
  CUSTOMER_TYPE,
  PAYMENT_METHOD,
  PAYMENT_PERMISSIONS,
  PAYMENT_METHOD_LABELS,
  CUSTOMER_TYPE_LABELS,
  canUsePaymentMethod,
};
