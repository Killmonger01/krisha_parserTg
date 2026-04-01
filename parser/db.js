const mongoose = require('mongoose');

// ─── Схема объявления ─────────────────────────────────────────────────────────

const listingSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true, index: true },
  title: String,
  priceStr: String,
  price: Number,
  address: String,
  photo: String,
  ownerType: String,    // 'частник' | 'агент'
  adType: String,       // 'vip' | 'top' | 'горячее' | 'обычное'
  isPaid: Boolean,
  district: String,     // район из адреса
  rooms: Number,        // количество комнат
  createdAt: { type: Date, default: Date.now },
});

// ─── Схема подписки юзера ─────────────────────────────────────────────────────

const subscriptionSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true, index: true },
  mode: { type: String, default: 'monthly' },   // 'daily' | 'monthly'
  checkin: String,
  checkout: String,
  filters: {
    district: { type: String, default: null },
    ownerType: { type: String, default: 'все' },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    rooms: { type: Number, default: null },
    adTypes: { type: [String], default: [] },
  },
  active: { type: Boolean, default: true },
  lastCheckedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

const Listing = mongoose.model('Listing', listingSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// ─── Подключение ──────────────────────────────────────────────────────────────

async function connectDB() {
  const url = process.env.MONGO_URL || 'mongodb://localhost:27017/krisha';
  await mongoose.connect(url);
  console.log(`[DB] Connected to ${url}`);
}

module.exports = { connectDB, Listing, Subscription, mongoose };