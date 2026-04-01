const TelegramBot = require('node-telegram-bot-api');
const { connectDB, Subscription } = require('./shared/db');

const TOKEN = process.env.BOT_TOKEN || '8599051611:AAEDgw3lRLVmCmyl8EHHl7zssTx1zGhStaQ';
const bot = new TelegramBot(TOKEN, { polling: true });

const DISTRICTS = [
  'Алатауский', 'Алмалинский', 'Ауэзовский',
  'Бостандыкский', 'Жетысуский', 'Медеуский',
  'Наурызбайский', 'Турксибский'
];

const userState = {};

function getState(chatId) {
  if (!userState[chatId]) {
    userState[chatId] = {
      step: 'idle',
      filters: {
        district: null,
        ownerType: 'все',
        minPrice: null,
        maxPrice: null,
        adTypes: [],
      },
    };
  }
  return userState[chatId];
}

// ─── Клавиатуры ───────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔍 Подписаться на квартиры', callback_data: 'start_subscribe' }],
      [{ text: '📋 Мои фильтры', callback_data: 'show_filters' }],
      [{ text: '🛑 Отписаться', callback_data: 'unsubscribe' }],
    ]
  };
}

function ownerTypeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '👤 Частник', callback_data: 'owner_частник' },
        { text: '🏢 Агент', callback_data: 'owner_агент' },
        { text: '🌐 Все', callback_data: 'owner_все' },
      ]
    ]
  };
}

function adTypeKeyboard(selected) {
  const types = [
    { label: 'VIP', icon: '⭐', key: 'vip' },
    { label: 'TOP', icon: '🔝', key: 'top' },
    { label: 'Горячие', icon: '🔥', key: 'горячее' },
    { label: 'Обычные', icon: '📄', key: 'обычное' },
  ];
  const allSelected = selected.length === 0;
  const rows = [];
  for (let i = 0; i < types.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < types.length; j++) {
      const t = types[j];
      const isSelected = selected.includes(t.key);
      row.push({ text: (isSelected ? '✅ ' : '') + t.icon + ' ' + t.label, callback_data: `adtype_${t.key}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: (allSelected ? '✅ ' : '') + '🌐 Все', callback_data: 'adtype_all' },
    { text: '➡️ Далее', callback_data: 'adtype_done' },
  ]);
  return { inline_keyboard: rows };
}

function districtsKeyboard() {
  const rows = [];
  for (let i = 0; i < DISTRICTS.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < DISTRICTS.length; j++) {
      row.push({ text: DISTRICTS[j], callback_data: `district_${DISTRICTS[j]}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🌐 Все районы', callback_data: 'district_all' }]);
  return { inline_keyboard: rows };
}

function roomsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '1', callback_data: 'rooms_1' },
        { text: '2', callback_data: 'rooms_2' },
        { text: '3', callback_data: 'rooms_3' },
        { text: '4', callback_data: 'rooms_4' },
        { text: '5+', callback_data: 'rooms_5' },
      ],
      [{ text: '🌐 Любое', callback_data: 'rooms_any' }],
    ]
  };
}

function priceKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'до 100 000 〒', callback_data: 'price_0_100000' },
        { text: '100–200 000 〒', callback_data: 'price_100000_200000' },
      ],
      [
        { text: '200–350 000 〒', callback_data: 'price_200000_350000' },
        { text: '350–500 000 〒', callback_data: 'price_350000_500000' },
      ],
      [
        { text: '500–700 000 〒', callback_data: 'price_500000_700000' },
        { text: '700 000 – 1 млн 〒', callback_data: 'price_700000_1000000' },
      ],
      [
        { text: '✏️ Свой диапазон', callback_data: 'price_custom' },
        { text: '🌐 Любая цена', callback_data: 'price_any' },
      ]
    ]
  };
}

// ─── Сохранить подписку в БД ──────────────────────────────────────────────────

async function saveSubscription(chatId, filters) {
  await Subscription.findOneAndUpdate(
    { chatId },
    { chatId, filters, active: true },
    { upsert: true, new: true }
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = null;

  bot.sendMessage(chatId,
    '🏠 *Krisha Parser Bot*\n\n' +
    'Подпишись на фильтры — бот будет присылать новые объявления аренды в Алматы в реальном времени.',
    { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = getState(chatId);

  bot.answerCallbackQuery(query.id);

  // ─── Главное меню ───────────────────────────────────────────────────────

  if (data === 'start_subscribe') {
    state.step = 'awaiting_owner';
    state.filters = { district: null, ownerType: 'все', rooms: null, minPrice: null, maxPrice: null, adTypes: [] };
    bot.sendMessage(chatId, '👤 Кто сдаёт квартиру?', { reply_markup: ownerTypeKeyboard() });
    return;
  }

  if (data === 'show_filters') {
    const sub = await Subscription.findOne({ chatId, active: true });
    if (!sub) {
      bot.sendMessage(chatId, '❌ У тебя нет активной подписки.', { reply_markup: mainMenuKeyboard() });
      return;
    }
    const f = sub.filters;
    const text =
      `📋 *Твои фильтры:*\n\n` +
      `🗺 Район: ${f.district || 'все'}\n` +
      `👤 Владелец: ${f.ownerType}\n` +
      `🛏 Комнат: ${f.rooms || 'любое'}\n` +
      `💰 Цена: ${f.minPrice || '—'} – ${f.maxPrice || '—'} 〒`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data === 'unsubscribe') {
    await Subscription.findOneAndUpdate({ chatId }, { active: false });
    bot.sendMessage(chatId, '🛑 Подписка отключена. Уведомления больше не придут.', { reply_markup: mainMenuKeyboard() });
    return;
  }

  // ─── Настройка фильтров ─────────────────────────────────────────────────

  if (data.startsWith('owner_')) {
    state.filters.ownerType = data.replace('owner_', '');
    state.step = 'awaiting_district';
    bot.sendMessage(chatId, '🗺 Выбери район:', { reply_markup: districtsKeyboard() });
    return;
  }

  if (data === 'district_all') {
    state.filters.district = null;
    state.step = 'awaiting_rooms';
    bot.sendMessage(chatId, '🛏 Сколько комнат?', { reply_markup: roomsKeyboard() });
    return;
  }

  if (data.startsWith('district_')) {
    state.filters.district = data.replace('district_', '');
    state.step = 'awaiting_rooms';
    bot.sendMessage(chatId, '🛏 Сколько комнат?', { reply_markup: roomsKeyboard() });
    return;
  }

  if (data === 'rooms_any') {
    state.filters.rooms = null;
    state.step = 'awaiting_price';
    bot.sendMessage(chatId, '💰 Выбери диапазон цены:', { reply_markup: priceKeyboard() });
    return;
  }

  if (data.startsWith('rooms_')) {
    state.filters.rooms = parseInt(data.replace('rooms_', ''));
    state.step = 'awaiting_price';
    bot.sendMessage(chatId, '💰 Выбери диапазон цены:', { reply_markup: priceKeyboard() });
    return;
  }

  if (data.startsWith('price_')) {
    if (data === 'price_any') {
      state.filters.minPrice = null;
      state.filters.maxPrice = null;
    } else if (data === 'price_custom') {
      state.step = 'awaiting_custom_price';
      bot.sendMessage(chatId, '✏️ Введи диапазон в формате *МИН-МАКС*\nНапример: `150000-400000`', { parse_mode: 'Markdown' });
      return;
    } else {
      const parts = data.replace('price_', '').split('_');
      state.filters.minPrice = parseInt(parts[0]) || null;
      state.filters.maxPrice = parseInt(parts[1]) || null;
    }

    // Сохраняем подписку
    await saveSubscription(chatId, state.filters);
    state.step = 'idle';

    const f = state.filters;
    bot.sendMessage(chatId,
      `✅ *Подписка активирована!*\n\n` +
      `🗺 Район: ${f.district || 'все'}\n` +
      `👤 Владелец: ${f.ownerType}\n` +
      `🛏 Комнат: ${f.rooms || 'любое'}\n` +
      `💰 Цена: ${f.minPrice || '—'} – ${f.maxPrice || '—'} 〒\n\n` +
      `Как только появится новое объявление — пришлю.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
    return;
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const state = getState(chatId);

  if (state.step === 'awaiting_custom_price') {
    if (!/^\d+-\d+$/.test(text)) {
      bot.sendMessage(chatId, '❌ Неверный формат. Введи как `150000-400000`', { parse_mode: 'Markdown' });
      return;
    }
    const parts = text.split('-');
    state.filters.minPrice = parseInt(parts[0]) || null;
    state.filters.maxPrice = parseInt(parts[1]) || null;

    await saveSubscription(chatId, state.filters);
    state.step = 'idle';

    const f = state.filters;
    bot.sendMessage(chatId,
      `✅ *Подписка активирована!*\n\n` +
      `🗺 Район: ${f.district || 'все'}\n` +
      `👤 Владелец: ${f.ownerType}\n` +
      `🛏 Комнат: ${f.rooms || 'любое'}\n` +
      `💰 Цена: ${f.minPrice || '—'} – ${f.maxPrice || '—'} 〒\n\n` +
      `Как только появится новое объявление — пришлю.`,
      { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() }
    );
    return;
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function main() {
  await connectDB();
  console.log('🤖 Бот запущен...');
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});