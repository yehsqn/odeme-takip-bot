const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'libsql://odeme-takip-yehsqn.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJnaWQiOiIxODE1MGVhZi03N2JjLTQ4ZmQtYTkyMi01NTIyZGE0MjgzYzEiLCJpYXQiOjE3NzYwMjMyOTYsInJpZCI6ImM3ZTRhMTUyLTUyYzUtNDExNy05MGYwLTA3YmQ5MjM2N2I2OCJ9.wdMNsozpY2wuzi1g3GPCekUnuN2F30RnXmKYJE5yyHZskpCHwpOYyMxvqNatv5HGzA3RyPpkPFLOSkwKChWBDQ',
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
    // ── Müşteri tipi migration (mevcut kullanıcılar INDIVIDUAL varsayılır)
    { table: 'users', name: 'customer_type', def: "TEXT NOT NULL DEFAULT 'INDIVIDUAL'" },
    // ── Şifre sıfırlama sütunları
    { table: 'users', name: 'reset_password_code', def: 'TEXT' },
    { table: 'users', name: 'reset_password_expires_at', def: 'TEXT' },
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
