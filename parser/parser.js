const { connectDB, Listing, Subscription } = require('./db');
const { getTotalPages, findBoundary, scrapePages, classifyPage, sleep } = require('./krisha');
const axios = require('axios');

// ─── Конфиг ───────────────────────────────────────────────────────────────────

const CHECK_INTERVAL = 60 * 1000;   // каждую минуту
const PAGE_BUFFER = 5;              // минус 5 от границы

// ─── Сохранить новые объявления в БД ──────────────────────────────────────────

async function saveNewListings(listings) {
  const newListings = [];

  for (const listing of listings) {
    try {
      const exists = await Listing.findOne({ url: listing.url });
      if (!exists) {
        const doc = await Listing.create(listing);
        newListings.push(doc);
      }
    } catch (err) {
      // duplicate key — уже есть, пропускаем
      if (err.code !== 11000) {
        console.error(`[DB] Error saving ${listing.url}:`, err.message);
      }
    }
  }

  return newListings;
}

// ─── Проверить фильтры юзера ──────────────────────────────────────────────────

function matchesFilter(listing, filters) {
  // Район
  if (filters.district) {
    if (listing.district !== filters.district) return false;
  }

  // Владелец
  if (filters.ownerType && filters.ownerType !== 'все') {
    if (listing.ownerType !== filters.ownerType) return false;
  }

  // Цена
  if (filters.minPrice && listing.price !== null) {
    if (listing.price < filters.minPrice) return false;
  }
  if (filters.maxPrice && listing.price !== null) {
    if (listing.price > filters.maxPrice) return false;
  }

  // Количество комнат
  if (filters.rooms && listing.rooms !== null) {
    if (listing.rooms !== filters.rooms) return false;
  }

  // Тип объявления
  if (filters.adTypes && filters.adTypes.length > 0) {
    if (!filters.adTypes.includes(listing.adType)) return false;
  }

  return true;
}

// ─── Уведомить юзеров о новых объявлениях ─────────────────────────────────────

async function notifyUsers(newListings) {
  if (newListings.length === 0) return;

  const botToken = process.env.BOT_TOKEN || '8599051611:AAEDgw3lRLVmCmyl8EHHl7zssTx1zGhStaQ';
  const subscriptions = await Subscription.find({ active: true });

  console.log(`[Notify] ${newListings.length} new listings, ${subscriptions.length} active subscriptions`);

  for (const sub of subscriptions) {
    const matching = newListings.filter(l => matchesFilter(l, sub.filters));

    if (matching.length === 0) continue;

    console.log(`[Notify] ${matching.length} listings match for chatId ${sub.chatId}`);

    // Отправляем уведомление
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: sub.chatId,
        text: `🔔 Найдено *${matching.length}* новых объявлений!`,
        parse_mode: 'Markdown',
      });

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
          await axios.post(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            chat_id: sub.chatId,
            photo: item.photo,
            caption,
            parse_mode: 'Markdown',
          });
        } else {
          await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: sub.chatId,
            text: caption,
            parse_mode: 'Markdown',
          });
        }

        await sleep(300);
      }
    } catch (err) {
      console.error(`[Notify] Error for chatId ${sub.chatId}:`, err.message);
    }
  }
}

// ─── Главный цикл парсера ─────────────────────────────────────────────────────

async function main() {
  await connectDB();
  console.log('[Parser] Starting...');

  // 1. Первый запуск — находим границу бинарным поиском
  const totalPages = await getTotalPages();
  console.log(`[Parser] Total pages: ${totalPages}`);

  let boundaryPage = await findBoundary(totalPages);
  console.log(`[Parser] Boundary at page ${boundaryPage}`);

  // 2. Каждую минуту — парсим от (boundary - 5) до boundary, ищем новые
  async function check() {
    try {
      const fromPage = Math.max(1, boundaryPage - PAGE_BUFFER);
      console.log(`\n[Parser] Checking pages ${fromPage}..${boundaryPage + 2}...`);

      const listings = await scrapePages(fromPage, boundaryPage + 2);
      const newListings = await saveNewListings(listings);

      if (newListings.length > 0) {
        console.log(`[Parser] Found ${newListings.length} NEW listings!`);
        await notifyUsers(newListings);
      } else {
        console.log(`[Parser] No new listings.`);
      }

      // Обновляем границу — ищем последнее платное
      const lastPaidIdx = listings.reduce((acc, l, i) => l.isPaid ? i : acc, -1);
      if (lastPaidIdx >= 0 && lastPaidIdx < listings.length - 1) {
        const listingsPerPage = 20;
        const newBoundary = fromPage + Math.floor(lastPaidIdx / listingsPerPage);
        if (newBoundary !== boundaryPage) {
          console.log(`[Parser] Boundary shifted: ${boundaryPage} -> ${newBoundary}`);
          boundaryPage = newBoundary;
        }
      }

    } catch (err) {
      console.error(`[Parser] Error:`, err.message);
    }
  }

  // Первая проверка сразу
  await check();

  // Потом каждую минуту
  setInterval(check, CHECK_INTERVAL);
  console.log(`[Parser] Monitoring every ${CHECK_INTERVAL / 1000}s...`);
}

main().catch(err => {
  console.error('[Parser] Fatal error:', err);
  process.exit(1);
});