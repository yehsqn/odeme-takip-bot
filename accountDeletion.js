const { db } = require('./db/turso');

/**
 * Hesabı ve kullanıcıya ait tüm kayıtları kalıcı olarak siler (KVKK).
 * Hem kullanıcının kendi hesap silmesi hem de admin silmesi bunu kullanır; tablo eklenirse yalnızca burası güncellenir.
 * Geri bildirim ve hata kayıtları anonimleştirilir (kimlik bilgisi silinir, kayıt kalır).
 */
async function deleteUserData(userId) {
  await db.batch([
    { sql: 'DELETE FROM payments WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM settings WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM daily_incomes WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM notifications WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM individual_profiles WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM corporate_profiles WHERE user_id = ?', args: [userId] },
    // KVKK: hesapla birlikte kullanıcıya ait tüm kayıtlar silinir
    { sql: 'DELETE FROM wallet_transfers WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM wallets WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM portfolio_items WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM user_notes WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM ai_reports WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM game_profiles WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM ai_usage WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM device_tokens WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM referral_codes WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM referrals WHERE invitee_id = ? OR inviter_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM app_events WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM game_cheers WHERE sender_id = ? OR receiver_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM friendships WHERE requester_id = ? OR recipient_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM user_reports WHERE reporter_id = ? OR reported_user_id = ?', args: [userId, userId] },
    { sql: 'DELETE FROM user_sessions WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM presale_acceptances WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM contract_deliveries WHERE user_id = ?', args: [userId] },
    { sql: 'UPDATE feedbacks SET user_id = NULL, user_email = NULL WHERE user_id = ?', args: [userId] },
    { sql: 'UPDATE app_errors SET user_id = NULL WHERE user_id = ?', args: [userId] },
    { sql: 'DELETE FROM users WHERE id = ?', args: [userId] },
  ], 'write');
}

module.exports = { deleteUserData };
