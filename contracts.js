const crypto = require('crypto');
const { db } = require('./db/turso');
const { sendMail } = require('./mailer');
const { getSeller, sellerComplete, sellerDisplayName } = require('./legal');

// Abonelik Sözleşmeleri Yönetmeliği md. 5/1: mesafeli kurulan sözleşmenin bir örneği tüketiciye
// kalıcı veri saklayıcısıyla (e-posta) verilir. Gönderilemeyen kopya tekrar denenir ve uygulamada da açılabilir.
const MAX_ATTEMPTS = 6;
const RETRY_MINUTES = [5, 30, 120, 360, 720];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDate = (iso) => {
  const d = new Date(String(iso || '').replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(iso)) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'long', timeStyle: 'short' });
};

/** Mağazaya göre değişen ifadeler; uygulamadaki src/utils/store.js ile aynı tutulmalı. */
function storeTexts(platform) {
  if (platform === 'ios') {
    return {
      name: 'App Store', of: "App Store'un",
      manage: 'iPhone Ayarlar → adın → Abonelikler',
      refundTo: "Apple'ın iade sistemi (reportaproblem.apple.com) üzerinden; Apple talebi sonuçlandırmazsa sana doğrudan banka havalesiyle",
      refundPolicy: "Apple'ın iade politikası",
    };
  }
  return {
    name: 'Google Play', of: "Google Play'in",
    manage: 'Google Play Store → Profil → Ödemeler ve abonelikler → Abonelikler',
    refundTo: 'Google Play üzerinden ödemeyi yaptığın yönteme',
    refundPolicy: "Google Play'in iade politikası",
  };
}

/** Sözleşme metni. PreSaleInfoModal.jsx ile aynı içerikte tutulmalı. */
function buildContract({ seller, consumer, acceptance, purchasedAt }) {
  const st = storeTexts(acceptance.platform);
  const sellerLine = [
    `<strong>${esc(sellerDisplayName(seller))}</strong>`,
    seller.mersisNo ? `MERSİS: ${esc(seller.mersisNo)}` : '',
    `Adres: ${esc(seller.address)}`,
    `Telefon: ${esc(seller.phone)}`,
    `E-posta: ${esc(seller.email)}`,
  ].filter(Boolean).join(' · ');
  const consumerLine = [
    consumer.name ? `<strong>${esc(consumer.name)}</strong>` : '',
    `E-posta: ${esc(consumer.email)}`,
    `Kullanıcı no: ${esc(consumer.id)}`,
  ].filter(Boolean).join(' · ');
  const plan = `${esc(acceptance.plan_title)} — ${esc(acceptance.price_text)}`;
  const period = esc(acceptance.period_text);

  const sections = [
    ['1. Taraflar', `<p>Satıcı / hizmet sağlayıcı: ${sellerLine}</p><p>Tüketici: ${consumerLine}</p>`],
    ['2. Sözleşmenin konusu', `<p>PayPulse Premium: uygulamadaki Premium özelliklere (yapay zekâ analizleri, gelişmiş raporlar, sınırsız takip ve diğer Premium özellikler) abonelik süresince erişim sağlayan, elektronik ortamda anında ifa edilen dijital hizmettir. Premium, hesabına bağlıdır; aynı hesapla girdiğin tüm cihazlarda geçerlidir.</p>`],
    ['3. Tarihler', `<ul><li>Sözleşmenin kurulduğu (ön bilgilendirmenin onaylandığı) tarih: ${esc(fmtDate(acceptance.accepted_at))}</li><li>Hizmetin başladığı tarih: ${esc(fmtDate(purchasedAt))}</li></ul>`],
    ['4. Fiyat, ödeme ve yenileme', `<ul>
      <li>Seçilen plan: <strong>${plan}</strong> (vergiler dahil). Kesin tutar ödeme ekranında ${st.name} tarafından gösterilmiştir.</li>
      <li>Ödeme ${st.name} üzerinden alınır; kart bilgilerin PayPulse'a iletilmez ve saklanmaz.</li>
      <li>Abonelik belirsiz sürelidir: <strong>sen iptal edene kadar devam eder</strong>. Ücret her dönem (${period}) başında o anki fiyatla ${st.name} üzerinden alınır. Fiyat değişikliği olursa tahsilattan önce bildirilir.</li>
      <li>Ek bir teslimat veya kargo ücreti yoktur.</li></ul>`],
    ['5. Ödeme alınamazsa', `<p>Yenileme bedeli ${st.name} tarafından tahsil edilemezse ${st.of} ödeme yeniden deneme süreci uygulanır; bedel tahsil edilemezse Premium erişimi sona erer. Bunun için gecikme faizi, ceza veya ek bir bedel istenmez.</p>`],
    ['6. İptal', `<p>Aboneliği istediğin an uygulamada Ayarlar → "Aboneliği yönet / iptal et" ya da ${st.manage} bölümünden iptal edebilirsin. İptal, içinde bulunulan dönemin sonunda geçerli olur; dönem sonuna kadar Premium kullanılmaya devam eder. Uygulamadaki hesabını silmek aboneliği kendiliğinden iptal etmez.</p><p>İptal talebini ${esc(seller.email)} adresine e-postayla da iletebilirsin. <strong>Kalan süre için iade:</strong> İptalden sonra içinde bulunulan dönemin kullanılmayan kısmının ücretini geri almak istersen hesabındaki e-posta adresinden aynı adrese yazman yeterli. Talebin en geç 7 gün içinde işlenir; kalan süreye düşen tutar ${st.refundTo} iade edilir ve Premium erişimi o tarihte sona erer.</p>`],
    ['7. Cayma hakkı', `<p>Mesafeli Sözleşmeler Yönetmeliği md. 15/1-(ğ) uyarınca, elektronik ortamda anında ifa edilen hizmetlerde ve tüketiciye anında teslim edilen gayri maddi mallarda, ifaya tüketicinin onayıyla başlandığında cayma hakkı kullanılamaz. Satın alma adımında verdiğin onayla Premium hemen açıldığından, ilgili dönem için cayma hakkı sona erer. İade talepleri ayrıca ${st.refundPolicy} kapsamında değerlendirilebilir.</p>`],
    ['8. Ayıplı hizmet', `<p>Hizmetin ayıplı ifası halinde 6502 sayılı Tüketicinin Korunması Hakkında Kanun md. 15 uyarınca hizmetin yeniden görülmesi, hizmet sonucu ortaya çıkan eserin ücretsiz onarımı, ayıp oranında bedelden indirim veya sözleşmeden dönme haklarından birini kullanabilir; ayrıca Türk Borçlar Kanunu hükümlerine göre tazminat isteyebilirsin.</p>`],
    ['9. Şikâyet ve uyuşmazlık', `<p>Talep ve şikâyetlerini ${esc(seller.email)} adresine veya ${esc(seller.phone)} numarasına iletebilirsin. Uyuşmazlıklarda, Ticaret Bakanlığı'nca ilan edilen parasal sınırlar dahilinde tüketicinin yerleşim yerindeki Tüketici Hakem Heyetleri, bu sınırları aşan durumlarda Tüketici Mahkemeleri yetkilidir.</p>`],
    ['10. Yürürlük', `<p>Bu ön bilgilendirme formu ve sözleşme, satın alma adımında onaylanmasıyla elektronik ortamda kurulmuştur. Onaylanan form sürümü: ${esc(acceptance.form_version)} · Onay kayıt no: ${esc(acceptance.id)}. Kişisel verilerin KVKK Aydınlatma Metni'ne göre işlenir.</p>`],
  ];

  const body = sections.map(([h, c]) => `<h3 style="font-size:15px;margin:18px 0 6px;">${h}</h3>${c}`).join('\n');
  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>PayPulse Premium Abonelik Sözleşmesi</title></head>
<body style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#111827;max-width:680px;margin:0 auto;padding:24px;">
<h2 style="margin-top:0;">PayPulse Premium — Ön Bilgilendirme Formu ve Abonelik Sözleşmesi</h2>
<p>Bu e-posta, satın aldığın aboneliğin sözleşme örneğidir. Lütfen saklayın.</p>
${body}
</body></html>`;
  return { subject: 'PayPulse Premium abonelik sözleşmen', html };
}

async function renderFor(row) {
  const acc = (await db.execute({ sql: 'SELECT * FROM presale_acceptances WHERE id = ?', args: [row.acceptance_id] })).rows[0];
  const user = (await db.execute({ sql: 'SELECT id, email, display_name FROM users WHERE id = ?', args: [row.user_id] })).rows[0];
  if (!acc || !user) return null;
  return {
    email: user.email,
    ...buildContract({
      seller: getSeller(),
      consumer: { id: user.id, email: user.email, name: user.display_name },
      acceptance: acc,
      purchasedAt: row.purchased_at,
    }),
  };
}

/** Tek bir kopyayı göndermeyi dener; sonucu kayda işler. */
async function attemptDelivery(id) {
  const row = (await db.execute({ sql: 'SELECT * FROM contract_deliveries WHERE id = ?', args: [id] })).rows[0];
  if (!row || row.status === 'sent') return row?.status || null;
  const setState = (status, error, nextMinutes) => db.execute({
    sql: `UPDATE contract_deliveries SET status = ?, last_error = ?, attempts = attempts + 1,
            next_attempt_at = ${nextMinutes ? `datetime('now', '+${Number(nextMinutes)} minutes')` : 'NULL'} WHERE id = ?`,
    args: [status, error, id],
  });

  if (!sellerComplete()) {
    // Eksik satıcı bilgisiyle sözleşme gönderilmez; bilgi girilince zamanlayıcı tekrar dener
    await db.execute({ sql: "UPDATE contract_deliveries SET status = 'pending', last_error = 'seller_info_missing', next_attempt_at = datetime('now', '+60 minutes') WHERE id = ?", args: [id] });
    console.warn('[CONTRACT] Satıcı bilgileri (SELLER_*) eksik, sözleşme e-postası bekletiliyor.');
    return 'pending';
  }
  const doc = await renderFor(row);
  if (!doc) {
    await setState('failed', 'record_missing', null);
    return 'failed';
  }
  let ok = false;
  try {
    ok = await sendMail({ to: doc.email, subject: doc.subject, html: doc.html });
  } catch (err) {
    console.error('[CONTRACT] Gönderim hatası:', err.message);
  }
  if (ok) {
    await db.execute({ sql: "UPDATE contract_deliveries SET status = 'sent', sent_at = datetime('now'), last_error = NULL, attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?", args: [id] });
    return 'sent';
  }
  const attempts = Number(row.attempts || 0) + 1;
  const giveUp = attempts >= MAX_ATTEMPTS;
  await setState(giveUp ? 'failed' : 'pending', 'mail_not_sent', giveUp ? null : RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)]);
  return giveUp ? 'failed' : 'pending';
}

/**
 * İlk satın almada sözleşme kopyasını kuyruğa alır ve hemen göndermeyi dener.
 * Kullanıcının bu satın alma için verdiği son ön bilgilendirme onayı esas alınır; aynı onay için ikinci kopya oluşmaz.
 */
async function queueContract(userId, { productId, purchasedAtMs } = {}) {
  const acc = (await db.execute({
    sql: 'SELECT id FROM presale_acceptances WHERE user_id = ? ORDER BY accepted_at DESC LIMIT 1',
    args: [userId],
  })).rows[0];
  if (!acc) {
    console.warn(`[CONTRACT] ${userId} için ön bilgilendirme onayı bulunamadı, sözleşme kopyası oluşturulmadı.`);
    return null;
  }
  const id = crypto.randomBytes(12).toString('hex');
  const purchasedAt = purchasedAtMs ? new Date(Number(purchasedAtMs)).toISOString() : new Date().toISOString();
  const ins = await db.execute({
    sql: `INSERT INTO contract_deliveries (id, user_id, acceptance_id, product_id, purchased_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (acceptance_id) DO NOTHING`,
    args: [id, userId, acc.id, String(productId || '').slice(0, 120), purchasedAt],
  });
  if (!ins.rowsAffected) return null;
  return attemptDelivery(id);
}

/** Zamanlayıcı: bekleyen kopyaları yeniden dener. */
async function retryPendingContracts() {
  const rows = (await db.execute(
    "SELECT id FROM contract_deliveries WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now')) LIMIT 50"
  )).rows;
  for (const r of rows) await attemptDelivery(r.id);
  if (rows.length) console.log(`[CONTRACT] ${rows.length} sözleşme kopyası yeniden denendi.`);
}

module.exports = { buildContract, queueContract, attemptDelivery, retryPendingContracts, renderFor, MAX_ATTEMPTS };
