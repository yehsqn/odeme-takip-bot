// Satıcı / veri sorumlusu bilgileri. Depo herkese açık olduğu için kişisel bilgiler koda yazılmaz,
// Render ortam değişkenlerinden okunur. Uygulamadaki src/constants/legal.js ile aynı tutulmalı.
//   SELLER_FULL_NAME   Satıcı gerçek kişinin adı soyadı (şirket yoksa zorunlu)
//   SELLER_TRADE_NAME  Ticaret siciline kayıtlı unvan (yalnızca şirket / esnaf kaydı varsa)
//   SELLER_MERSIS      MERSİS numarası (yalnızca şirketse)
//   SELLER_BRAND       Marka adı (ör. Sqnova Software) — tüzel kişi değildir
//   SELLER_PHONE, SELLER_EMAIL, SELLER_ADDRESS
function getSeller() {
  const env = (k) => String(process.env[k] || '').trim();
  return {
    fullName: env('SELLER_FULL_NAME'),
    tradeName: env('SELLER_TRADE_NAME'),
    mersisNo: env('SELLER_MERSIS'),
    brandName: env('SELLER_BRAND'),
    phone: env('SELLER_PHONE'),
    email: env('SELLER_EMAIL'),
    address: env('SELLER_ADDRESS'),
  };
}

/** Sözleşmede zorunlu satıcı bilgileri (Abonelik Sözleşmeleri Yönetmeliği md. 6/1-a) eksiksiz mi? */
function sellerComplete(s = getSeller()) {
  return !!((s.fullName || s.tradeName) && s.phone && s.email && s.address);
}

function sellerDisplayName(s = getSeller()) {
  if (s.tradeName) return s.tradeName;
  return s.brandName ? `${s.fullName} (${s.brandName} markasıyla)` : s.fullName;
}

module.exports = { getSeller, sellerComplete, sellerDisplayName };
