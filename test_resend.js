require('dotenv').config({ path: '../.env' });
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// 1. Domain durumunu kontrol et
resend.domains.list().then(function(result) {
  var data = result.data;
  var error = result.error;
  if (error) {
    console.log('Domain listesi hatasi:', JSON.stringify(error));
    return;
  }
  var domains = data && data.data ? data.data : (Array.isArray(data) ? data : []);
  console.log('--- DOMAIN DURUMU ---');
  domains.forEach(function(d) {
    console.log('Domain:', d.name, '| Status:', d.status, '| Region:', d.region);
  });

  // 2. Test emaili gonder
  var domain = domains.find(function(d) { return d.name === 'yehsqn.online'; });
  var fromAddr = (domain && domain.status === 'verified')
    ? 'PayPulse <noreply@yehsqn.online>'
    : 'PayPulse <onboarding@resend.dev>';

  var toAddr = 'test-random-123@yahoo.com'; // Testing to non-account email

  console.log('\n--- EMAIL GONDERIMI ---');
  console.log('From:', fromAddr);
  console.log('To:', toAddr);

  return resend.emails.send({
    from: fromAddr,
    to: [toAddr],
    subject: 'PayPulse - Sifre Sifirlama Test',
    html: '<div style="font-family:Arial;padding:24px;background:#0f172a;color:#f8fafc;border-radius:12px"><h2 style="color:#38bdf8;text-align:center">PayPulse</h2><p style="text-align:center">Dogrulama kodunuz:</p><div style="background:#1e293b;padding:20px;border-radius:8px;text-align:center;border:1px dashed #38bdf8"><span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#38bdf8">847291</span></div><p style="color:#94a3b8;font-size:13px;text-align:center">Bu kod 10 dakika gecerlidir.</p></div>',
  });
}).then(function(result) {
  if (!result) return;
  var data = result.data;
  var error = result.error;
  if (error) {
    console.log('EMAIL HATASI:', JSON.stringify(error));
  } else {
    console.log('EMAIL BASARILI! ID:', data.id);
    console.log('Gelen kutusunu kontrol edin: sqnova.software@gmail.com');
  }
}).catch(function(err) {
  console.log('Hata:', err.message);
});
