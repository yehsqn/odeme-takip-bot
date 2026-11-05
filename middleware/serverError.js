// 500 yanıtı: ayrıntı yalnızca sunucu günlüğüne yazılır, kullanıcıya genel mesaj döner.
const GENERIC = 'İşlem sırasında bir hata oluştu. Lütfen daha sonra tekrar deneyin.';

function serverError(res, err, message = GENERIC) {
  console.error('[API Error]', res.req?.method, res.req?.originalUrl, err?.message);
  res.status(500).json({ success: false, error: message });
}

module.exports = { serverError };
