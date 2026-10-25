const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDb() {
  console.log('[DB] Turso tabloları oluşturuluyor...');

  await db.batch([
    // Users tablosu
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      telegram_chat_id TEXT,
      pairing_code TEXT,
      pairing_code_expires_at TEXT,
      pin TEXT,
      income_expense_password TEXT,
      language TEXT DEFAULT 'tr',
      google_id TEXT,
      display_name TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      is_premium INTEGER DEFAULT 0,
      premium_expires_at TEXT,
      subscription_plan TEXT DEFAULT 'free',
      subscription_type TEXT DEFAULT 'free',
      subscription_status TEXT DEFAULT 'active',
      subscription_expiry TEXT,
      ai_analysis_tokens INTEGER DEFAULT 1,
      ai_tokens_reset_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      role TEXT DEFAULT 'user',
      reset_password_code TEXT,
      reset_password_expires_at TEXT
    )`,

    // Payments tablosu
    `CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id TEXT NOT NULL,
      payment_id TEXT,
      title TEXT,
      amount REAL,
      installments INTEGER,
      date TEXT,
      category TEXT,
      bank TEXT,
      type TEXT,
      installment_plan TEXT DEFAULT '[]',
      currency TEXT DEFAULT 'TRY',
      original_amount REAL,
      created_at TEXT
    )`,

    // Payments index
    `CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)`,

    // Settings tablosu
    `CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id TEXT NOT NULL UNIQUE,
      cut_off_day INTEGER DEFAULT 10,
      telegram_bot_token TEXT DEFAULT '',
      telegram_chat_id TEXT,
      telegram_notifications_enabled INTEGER DEFAULT 1,
      banks TEXT DEFAULT '[]',
      notification_time TEXT DEFAULT '09:00',
      notifications_enabled INTEGER DEFAULT 1,
      notification_days INTEGER DEFAULT 2,
      notify_on_due INTEGER DEFAULT 1,
      notify_overdue INTEGER DEFAULT 1,
      last_telegram_notification TEXT,
      backup_enabled INTEGER DEFAULT 0,
      backup_time TEXT DEFAULT '00:00'
    )`,

    // Settings index
    `CREATE INDEX IF NOT EXISTS idx_settings_user ON settings(user_id)`,

    // DailyIncomes tablosu
    `CREATE TABLE IF NOT EXISTS daily_incomes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      cash REAL DEFAULT 0,
      cc REAL DEFAULT 0,
      salary REAL DEFAULT 0,
      insurance REAL DEFAULT 0,
      other_income REAL DEFAULT 0,
      expenses TEXT DEFAULT '[]',
      UNIQUE(user_id, date)
    )`,

    // DailyIncomes index
    `CREATE INDEX IF NOT EXISTS idx_daily_incomes_user ON daily_incomes(user_id)`,

    // Notifications tablosu (uygulama içi bildirimler)
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payment_id TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // Notifications index
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read)`,

    // ── Bireysel Müşteri Profili ──────────────────────────────
    `CREATE TABLE IF NOT EXISTS individual_profiles (
      id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id       TEXT NOT NULL UNIQUE,
      first_name    TEXT NOT NULL DEFAULT '',
      last_name     TEXT NOT NULL DEFAULT '',
      tc_identity   TEXT NOT NULL DEFAULT '',
      phone         TEXT NOT NULL DEFAULT '',
      address       TEXT DEFAULT '',
      bill_address  TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // ── Kurumsal Müşteri Profili ──────────────────────────────
    `CREATE TABLE IF NOT EXISTS corporate_profiles (
      id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id            TEXT NOT NULL UNIQUE,
      company_name       TEXT NOT NULL DEFAULT '',
      tax_office         TEXT NOT NULL DEFAULT '',
      tax_number         TEXT NOT NULL DEFAULT '',
      authorized_name    TEXT NOT NULL DEFAULT '',
      authorized_surname TEXT NOT NULL DEFAULT '',
      phone              TEXT NOT NULL DEFAULT '',
      company_address    TEXT NOT NULL DEFAULT '',
      e_invoice_alias    TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now')),
      updated_at         TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,

    // Profil indeksleri
    `CREATE INDEX IF NOT EXISTS idx_individual_profiles_user ON individual_profiles(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_corporate_profiles_user ON corporate_profiles(user_id)`,

    // ── Geri Bildirim ve Hata Bildirimleri Tablosu ─────────────
    `CREATE TABLE IF NOT EXISTS feedbacks (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id     TEXT,
      user_email  TEXT,
      type        TEXT DEFAULT 'feedback',
      subject     TEXT,
      message     TEXT NOT NULL,
      app_version TEXT,
      platform    TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feedbacks_user ON feedbacks(user_id)`,
    // Uygulama çökme / hata kayıtları (Analytics & Crash)
    `CREATE TABLE IF NOT EXISTS app_errors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT,
      message     TEXT,
      stack       TEXT,
      context     TEXT,
      platform    TEXT,
      app_version TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_errors_created ON app_errors(created_at)`,
    // AI aylık rapor önbelleği (kullanıcı + ay)
    `CREATE TABLE IF NOT EXISTS ai_reports (
      user_id    TEXT NOT NULL,
      month      TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    )`,
    // PulseCity oyun profili (takma ad, lig) — puan kayıtlardan hesaplanır, saklanmaz
    `CREATE TABLE IF NOT EXISTS game_profiles (
      user_id    TEXT PRIMARY KEY,
      nickname   TEXT,
      opt_in     INTEGER DEFAULT 0,
      league     INTEGER DEFAULT 0,
      last_week  TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,

    // ── Oturum ve Cihaz Listesi (Uzaktan Çıkış) ───────────────
    `CREATE TABLE IF NOT EXISTS user_sessions (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      device_name    TEXT,
      os             TEXT,
      browser        TEXT,
      ip             TEXT,
      last_active_at TEXT DEFAULT (datetime('now')),
      created_at     TEXT DEFAULT (datetime('now')),
      is_revoked     INTEGER DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, is_revoked)`,

    // ── Çoklu Cüzdan ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS wallets (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'bank',
      balance     REAL DEFAULT 0,
      currency    TEXT DEFAULT 'TRY',
      color       TEXT DEFAULT '#3b82f6',
      icon        TEXT DEFAULT 'Wallet',
      bank_name   TEXT DEFAULT '',
      iban_last4  TEXT DEFAULT '',
      is_default  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id)`,

    `CREATE TABLE IF NOT EXISTS wallet_transfers (
      id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id        TEXT NOT NULL,
      from_wallet_id TEXT NOT NULL,
      to_wallet_id   TEXT NOT NULL,
      amount         REAL NOT NULL,
      currency       TEXT DEFAULT 'TRY',
      note           TEXT DEFAULT '',
      date           TEXT NOT NULL,
      created_at     TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user ON wallet_transfers(user_id)`,

    // ── Altın, Hisse ve Kripto Portföyü ────────────────────────
    `CREATE TABLE IF NOT EXISTS portfolio_items (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      user_id      TEXT NOT NULL,
      category     TEXT NOT NULL,
      symbol       TEXT NOT NULL,
      name         TEXT NOT NULL,
      amount       REAL NOT NULL,
      buy_price    REAL NOT NULL,
      buy_currency TEXT DEFAULT 'TRY',
      buy_date     TEXT,
      notes        TEXT DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_portfolio_items_user ON portfolio_items(user_id)`,

    // ── Arkadaşlar ve Mesajlaşma (Sosyal) ──────────────────────
    `CREATE TABLE IF NOT EXISTS friendships (
      id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      requester_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(requester_id, recipient_id)`,

    `CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      sender_id   TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      content     TEXT NOT NULL,
      msg_type    TEXT DEFAULT 'text',
      metadata    TEXT DEFAULT '{}',
      is_read     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id)`,

    // ── Google Play UGC Politikası: Engelleme ve Şikayet ───────
    `CREATE TABLE IF NOT EXISTS blocked_users (
      id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      blocker_id TEXT NOT NULL,
      blocked_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(blocker_id, blocked_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_blocked_users ON blocked_users(blocker_id, blocked_id)`,

    `CREATE TABLE IF NOT EXISTS user_reports (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(12)))),
      reporter_id      TEXT NOT NULL,
      reported_user_id TEXT NOT NULL,
      reason           TEXT NOT NULL,
      details          TEXT DEFAULT '',
      message_id       TEXT,
      status           TEXT DEFAULT 'pending',
      created_at       TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_reports ON user_reports(reported_user_id)`,

    // ── Yönetici sürüm duyuruları
    `CREATE TABLE IF NOT EXISTS app_broadcasts (
      id              TEXT PRIMARY KEY,
      version         TEXT NOT NULL,
      notes           TEXT,
      sent_by         TEXT,
      recipients      INTEGER DEFAULT 0,
      email_requested INTEGER DEFAULT 0,
      email_sent      INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    )`,
  ]);

  // Migration: Mevcut DB'ye yeni sütunlar ekle (varsa atlar)
  const columnsToAdd = [
    { table: 'settings', name: 'notification_time', def: "TEXT DEFAULT '09:00'" },
    { table: 'settings', name: 'notifications_enabled', def: 'INTEGER DEFAULT 1' },
    { table: 'settings', name: 'notification_days', def: 'INTEGER DEFAULT 2' },
    { table: 'settings', name: 'notify_on_due', def: 'INTEGER DEFAULT 1' },
    { table: 'settings', name: 'notify_overdue', def: 'INTEGER DEFAULT 1' },
    { table: 'settings', name: 'backup_enabled', def: 'INTEGER DEFAULT 0' },
    { table: 'settings', name: 'backup_time', def: "TEXT DEFAULT '00:00'" },
    // ── Esnek ayarlar (bütçe, hedefler, döviz alarmları, paylaşım) JSON
    { table: 'settings', name: 'extras', def: "TEXT DEFAULT '{}'" },
    // ── Gelir-gider ek alanları (EFT, çek geliri, kategori) JSON
    { table: 'daily_incomes', name: 'extra', def: "TEXT DEFAULT '{}'" },
    // ── Oturum güvenliği ve e-posta doğrulama (mevcut kullanıcılar doğrulanmış sayılır)
    { table: 'users', name: 'token_version', def: 'INTEGER DEFAULT 0' },
    { table: 'users', name: 'email_verified', def: 'INTEGER DEFAULT 1' },
    { table: 'users', name: 'email_verify_code', def: 'TEXT' },
    { table: 'users', name: 'email_verify_expires_at', def: 'TEXT' },
    // ── Hesap bazlı deneme sınırı (PIN / gelir-gider şifresi)
    { table: 'users', name: 'pin_fail_count', def: 'INTEGER DEFAULT 0' },
    { table: 'users', name: 'pin_locked_until', def: 'TEXT' },
    { table: 'users', name: 'income_fail_count', def: 'INTEGER DEFAULT 0' },
    { table: 'users', name: 'income_locked_until', def: 'TEXT' },
    // ── Müşteri tipi migration (mevcut kullanıcılar INDIVIDUAL varsayılır)
    { table: 'users', name: 'customer_type', def: "TEXT NOT NULL DEFAULT 'INDIVIDUAL'" },
    // ── Şifre sıfırlama sütunları
    { table: 'users', name: 'reset_password_code', def: 'TEXT' },
    { table: 'users', name: 'reset_password_expires_at', def: 'TEXT' },
    // ── Sosyal ve Cüzdan migration
    { table: 'users', name: 'friend_code', def: 'TEXT' },
    { table: 'users', name: 'email_verify_attempts', def: 'INTEGER DEFAULT 0' },
    { table: 'payments', name: 'wallet_id', def: 'TEXT' },
    { table: 'daily_incomes', name: 'wallet_id', def: 'TEXT' },
  ];

  for (const col of columnsToAdd) {
    try {
      await db.execute(`ALTER TABLE ${col.table} ADD COLUMN ${col.name} ${col.def}`);
    } catch {
      // Sütun zaten varsa hata yutulur
    }
  }

  console.log('[DB] Turso tabloları hazır ✓');
}

// Sanitize: undefined → null (Turso doesn't accept undefined)
function sanitizeArgs(args) {
  if (!args) return args;
  return args.map(a => (a === undefined ? null : a));
}

function sanitizeStmt(stmt) {
  if (typeof stmt === 'string') return stmt;
  return { ...stmt, args: sanitizeArgs(stmt.args) };
}

const wrappedDb = {
  execute(stmt) {
    return db.execute(sanitizeStmt(stmt));
  },
  batch(stmts) {
    return db.batch(stmts.map(sanitizeStmt));
  },
};

module.exports = { db: wrappedDb, initDb };
