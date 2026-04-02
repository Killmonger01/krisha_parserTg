const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { connectDB, Subscription, District } = require('./db');

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

const userState = {};

function getState(chatId) {
  if (!userState[chatId]) {
    userState[chatId] = {
      step: 'idle',
      filters: {
        district: null,
        ownerType: 'все',
        rooms: [],
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

async function districtsKeyboard() {
  const districts = await District.find().sort({ name: 1 });
  const rows = [];
  for (let i = 0; i < districts.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < districts.length; j++) {
      row.push({ text: districts[j].name, callback_data: `district_${districts[j].name}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '🌐 Все районы', callback_data: 'district_all' }]);
  return { inline_keyboard: rows };
}

// ─── Клавиатура комнат с мультивыбором ───────────────────────────────────────

function roomsKeyboard(selected = []) {
  function label(r) {
    const display = r === 6 ? '6+' : String(r);
    return selected.includes(r) ? `✅ ${display}` : display;
  }

  return {
    inline_keyboard: [
      [
        { text: label(1), callback_data: 'rooms_toggle_1' },
        { text: label(2), callback_data: 'rooms_toggle_2' },
      ],
      [
        { text: label(3), callback_data: 'rooms_toggle_3' },
        { text: label(4), callback_data: 'rooms_toggle_4' },
      ],
      [
        { text: label(5), callback_data: 'rooms_toggle_5' },
        { text: label(6), callback_data: 'rooms_toggle_6' },
      ],
      [
        { text: '✔️ Готово', callback_data: 'rooms_done' },
        { text: '🌐 Любое', callback_data: 'rooms_any' },
      ],
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

// ─── Форматирование комнат для текста ─────────────────────────────────────────

function formatRooms(rooms) {
  if (!rooms || rooms.length === 0) return 'любое';
  return rooms.sort((a, b) => a - b).map(r => r === 6 ? '6+' : String(r)).join(', ');
}

// ─── Сохранить подписку в БД ──────────────────────────────────────────────────

async function saveSubscription(chatId, filters) {
  await Subscription.findOneAndUpdate(
    { chatId },
    { chatId, filters, active: true },
    { upsert: true, new: true }
  );
}

// ─── Проверить фильтры юзера ──────────────────────────────────────────────────

function matchesFilter(listing, filters) {
  if (filters.district) {
    if (listing.district !== filters.district) return false;
  }

  if (filters.ownerType && filters.ownerType !== 'все') {
    if (listing.ownerType !== filters.ownerType) return false;
  }

  if (filters.minPrice && listing.price !== null) {
    if (listing.price < filters.minPrice) return false;
  }
  if (filters.maxPrice && listing.price !== null) {
    if (listing.price > filters.maxPrice) return false;
  }

  // Мультивыбор комнат (6 означает 6+)
  if (filters.rooms && filters.rooms.length > 0 && listing.rooms !== null) {
    const matches = filters.rooms.some(r => {
      if (r === 6) return listing.rooms >= 6;
      return listing.rooms === r;
    });
    if (!matches) return false;
  }

  return true;
}

// ─── API эндпоинт — принимает объявления от парсера ───────────────────────────

app.post('/new-listings', async (req, res) => {
  try {
    const { listings } = req.body;
    if (!listings || listings.length === 0) {
      return res.json({ ok: true, notified: 0 });
    }

    console.log(`[API] Received ${listings.length} new listings from parser`);

    const subscriptions = await Subscription.find({ active: true });

    let totalNotified = 0;

    for (const sub of subscriptions) {
      const matching = listings.filter(l => matchesFilter(l, sub.filters));

      if (matching.length === 0) continue;

      console.log(`[Notify] ${matching.length} listings match for chatId ${sub.chatId}`);
      totalNotified += matching.length;

      try {
        await bot.sendMessage(sub.chatId, `🔔 Найдено *${matching.length}* новых объявлений!`, { parse_mode: 'Markdown' });

        for (const item of matching) {
          const ownerIcon = item.ownerType === 'частник' ? '👤' : '🏢';
          const adIcon = item.adType === 'vip' ? '⭐ VIP' : item.adType === 'top' ? '🔝 TOP' : item.adType === 'горячее' ? '🔥 Горячее' : '📄 Обычное';
          const caption =
            `🆕 *${item.title || 'Квартира'}*\n` +
            `💰 ${item.priceStr || '—'}\n` +
            `📍 ${item.address || '—'}\n` +
            `${ownerIcon} ${item.ownerType} · ${adIcon}\n` +
            `🔗 [Открыть объявление](${item.url})`;

          if (item.photo) {
            await bot.sendPhoto(sub.chatId, item.photo, { caption, parse_mode: 'Markdown' });
          } else {
            await bot.sendMessage(sub.chatId, caption, { parse_mode: 'Markdown' });
          }

          await new Promise(r => setTimeout(r, 300));
        }
      } catch (err) {
        console.error(`[Notify] Error for chatId ${sub.chatId}:`, err.message);
      }
    }

    res.json({ ok: true, notified: totalNotified });
  } catch (err) {
    console.error(`[API] Error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Telegram Handlers ───────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = null;

  bot.sendMessage(chatId,
    '🏠 *Krisha Parser Bot*\n\n' +
    'Подпишись на фильтры — бот будет присылать новые объявления аренды в Алматы в реальном времени.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: 'Главное меню' }]],
        resize_keyboard: true,
      }
    }
  ).then(() => {
    bot.sendMessage(chatId, 'Выбери действие:', { reply_markup: mainMenuKeyboard() });
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const state = getState(chatId);

  bot.answerCallbackQuery(query.id);

  if (data === 'start_subscribe') {
    state.step = 'awaiting_owner';
    state.filters = { district: null, ownerType: 'все', rooms: [], minPrice: null, maxPrice: null, adTypes: [] };
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
      `🛏 Комнат: ${formatRooms(f.rooms)}\n` +
      `💰 Цена: ${f.minPrice || '—'} – ${f.maxPrice || '—'} 〒`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data === 'unsubscribe') {
    await Subscription.findOneAndUpdate({ chatId }, { active: false });
    bot.sendMessage(chatId, '🛑 Подписка отключена. Уведомления больше не придут.', { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith('owner_')) {
    state.filters.ownerType = data.replace('owner_', '');
    state.step = 'awaiting_district';
    bot.sendMessage(chatId, '🗺 Выбери район:', { reply_markup: await districtsKeyboard() });
    return;
  }

  if (data === 'district_all') {
    state.filters.district = null;
    state.step = 'awaiting_rooms';
    bot.sendMessage(chatId, '🛏 Сколько комнат? (можно выбрать несколько)', { reply_markup: roomsKeyboard([]) });
    return;
  }

  if (data.startsWith('district_')) {
    state.filters.district = data.replace('district_', '');
    state.step = 'awaiting_rooms';
    bot.sendMessage(chatId, '🛏 Сколько комнат? (можно выбрать несколько)', { reply_markup: roomsKeyboard([]) });
    return;
  }

  // ─── Мультивыбор комнат ───────────────────────────────────────────────────

  if (data.startsWith('rooms_toggle_')) {
    const num = parseInt(data.replace('rooms_toggle_', ''));
    const rooms = state.filters.rooms || [];

    if (rooms.includes(num)) {
      state.filters.rooms = rooms.filter(r => r !== num);
    } else {
      state.filters.rooms = [...rooms, num];
    }

    bot.editMessageReplyMarkup(
      roomsKeyboard(state.filters.rooms),
      { chat_id: chatId, message_id: query.message.message_id }
    );
    return;
  }

  if (data === 'rooms_done') {
    if (!state.filters.rooms || state.filters.rooms.length === 0) {
      bot.answerCallbackQuery(query.id, { text: '⚠️ Выбери хотя бы одну комнату или нажми "Любое"', show_alert: true });
      return;
    }
    state.step = 'awaiting_price';
    bot.sendMessage(chatId, '💰 Выбери диапазон цены:', { reply_markup: priceKeyboard() });
    return;
  }

  if (data === 'rooms_any') {
    state.filters.rooms = null;
    state.step = 'awaiting_price';
    bot.sendMessage(chatId, '💰 Выбери диапазон цены:', { reply_markup: priceKeyboard() });
    return;
  }

  // ─── Цена ─────────────────────────────────────────────────────────────────

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

    await saveSubscription(chatId, state.filters);
    state.step = 'idle';

    const f = state.filters;

    bot.sendMessage(chatId,
      `✅ *Подписка активирована!*\n\n` +
      `🗺 Район: ${f.district || 'все'}\n` +
      `👤 Владелец: ${f.ownerType}\n` +
      `🛏 Комнат: ${formatRooms(f.rooms)}\n` +
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

  if (text === 'Главное меню') {
    userState[chatId] = null;
    bot.sendMessage(chatId,
      '🏠 *Krisha Parser Bot*\n\n' +
      'Подпишись на фильтры — бот будет присылать новые объявления аренды в Алматы в реальном времени.',
      { parse_mode: 'Markdown' }
    ).then(() => {
      bot.sendMessage(chatId, 'Выбери действие:', { reply_markup: mainMenuKeyboard() });
    });
    return;
  }

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
      `🛏 Комнат: ${formatRooms(f.rooms)}\n` +
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

  app.listen(PORT, () => {
    console.log(`[API] Listening on port ${PORT}`);
  });

  console.log('🤖 Бот запущен...');
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});