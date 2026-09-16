require('dotenv').config({ path: '../.env' });
require('dotenv').config({ path: './.env' });
const { db } = require('./db/turso');

async function grantUnlimitedAI() {
  const email = 'yehsanefe20@gmail.com';
  console.log(`[UPGRADE] ${email} kullanıcısı aranıyor...`);

  const findUser = await db.execute({
    sql: 'SELECT id, email, is_premium, subscription_type, subscription_status, role FROM users WHERE email = ?',
    args: [email]
  });

  console.log('Mevcut Kullanıcı Durumu:', findUser.rows);

  if (findUser.rows.length === 0) {
    console.log('[UYARI] Kullanıcı henüz bu email ile kayıt olmamış olabilir. Yeni kullanıcı kaydı açılıyor...');
    const crypto = require('crypto');
    const bcrypt = require('bcryptjs');
    const newId = crypto.randomBytes(12).toString('hex');
    const hashedDefault = await bcrypt.hash('123456', 10);
    await db.execute({
      sql: `INSERT INTO users (id, email, password, is_premium, subscription_type, subscription_status, subscription_expiry, ai_analysis_tokens, role)
            VALUES (?, ?, ?, 1, 'lifetime', 'active', '2099-12-31T23:59:59.000Z', 999999, 'admin')`,
      args: [newId, email, hashedDefault]
    });
  } else {
    await db.execute({
      sql: `UPDATE users SET 
              is_premium = 1, 
              subscription_type = 'lifetime', 
              subscription_status = 'active', 
              subscription_expiry = '2099-12-31T23:59:59.000Z', 
              ai_analysis_tokens = 999999, 
              role = 'admin' 
            WHERE email = ?`,
      args: [email]
    });
  }

  const updatedUser = await db.execute({
    sql: 'SELECT id, email, is_premium, subscription_type, subscription_status, subscription_expiry, ai_analysis_tokens, role FROM users WHERE email = ?',
    args: [email]
  });

  console.log('✅ GÜNCELLENMİŞ KULLANICI DETAYLARI:');
  console.log(JSON.stringify(updatedUser.rows[0], null, 2));
}

grantUnlimitedAI()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Hata:', err);
    process.exit(1);
  });
