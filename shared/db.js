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
  mode: { type: String, default: 'monthly' },
  checkin: String,
  checkout: String,
  filters: {
    district: { type: String, default: null },
    ownerType: { type: String, default: 'все' },
    minPrice: { type: Number, default: null },
    maxPrice: { type: Number, default: null },
    rooms: { type: [Number], default: [] },  // массив комнат (пустой = любое)
    adTypes: { type: [String], default: [] },
  },
  active: { type: Boolean, default: true },
  lastCheckedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// ─── Схема района ─────────────────────────────────────────────────────────────
const districtSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
});

const Listing = mongoose.model('Listing', listingSchema);
const Subscription = mongoose.model('Subscription', subscriptionSchema);
const District = mongoose.model('District', districtSchema);

// ─── Начальные районы (заполняются при первом запуске) ─────────────────────────
const DEFAULT_DISTRICTS = [
  'Алатауский', 'Алмалинский', 'Ауэзовский',
  'Бостандыкский', 'Жетысуский', 'Медеуский',
  'Наурызбайский', 'Турксибский'
];

async function seedDistricts() {
  const count = await District.countDocuments();
  if (count === 0) {
    await District.insertMany(DEFAULT_DISTRICTS.map(name => ({ name })));
    console.log(`[DB] Seeded ${DEFAULT_DISTRICTS.length} districts`);
  }
}

// ─── Подключение ──────────────────────────────────────────────────────────────
async function connectDB() {
  const url = process.env.MONGO_URL || 'mongodb://localhost:27017/krisha';
  await mongoose.connect(url);
  console.log(`[DB] Connected to ${url}`);
  await seedDistricts();
}

module.exports = { connectDB, Listing, Subscription, District, mongoose };