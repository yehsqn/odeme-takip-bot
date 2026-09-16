const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  telegramChatId: String,
  pairingCode: String,
  pairingCodeExpiresAt: Date,
  pin: String,
  incomeExpensePassword: String,
  language: { type: String, default: 'tr' },
  googleId: { type: String, default: null },
  displayName: { type: String, default: '' },
  avatar: { type: String, default: '' },
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },
  subscriptionPlan: { type: String, default: 'free' },
  subscriptionType: { type: String, enum: ['free', 'monthly', 'yearly'], default: 'free' },
  subscriptionStatus: { type: String, enum: ['active', 'expired', 'canceled'], default: 'active' },
  subscriptionExpiry: { type: Date, default: null },
  aiAnalysisTokens: { type: Number, default: 1 },
  aiTokensResetAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  role: { type: String, default: 'user' }
});

const PaymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
  id: String,
  title: String,
  amount: Number,
  installments: Number,
  date: String,
  category: String,
  bank: String,
  type: String,
  installmentPlan: Array,
  currency: { type: String, default: 'TRY' },
  originalAmount: Number,
  createdAt: String
}, { collection: 'payments' });

const SettingsSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.Mixed, required: true, unique: true, index: true },
  cutOffDay: { type: Number, default: 10 },
  telegram: {
    botToken: { type: String, default: '' },
    chatId: String,
    notificationsEnabled: { type: Boolean, default: true }
  },
  banks: { type: Array, default: [] },
  notificationDays: { type: Number, default: 3 },
  lastTelegramNotification: String,
  backup: {
    enabled: { type: Boolean, default: false },
    time: { type: String, default: '00:00' }
  }
});

const DailyIncomeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
  date: { type: String, required: true },
  cash: { type: Number, default: 0 },
  cc: { type: Number, default: 0 },
  salary: { type: Number, default: 0 },
  insurance: { type: Number, default: 0 },
  other: { type: Number, default: 0 },
  expenses: [{ description: String, amount: Number, date: { type: Date, default: Date.now } }]
});
DailyIncomeSchema.index({ userId: 1, date: 1 }, { unique: true });

const User = mongoose.model('User', UserSchema);
const Payment = mongoose.model('Payment', PaymentSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const DailyIncome = mongoose.model('DailyIncome', DailyIncomeSchema);

module.exports = { User, Payment, Settings, DailyIncome };
