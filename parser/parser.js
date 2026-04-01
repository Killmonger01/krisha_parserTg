const { connectDB, Listing } = require('./db');
const { getTotalPages, findBoundary, scrapePages, sleep } = require('./krisha');

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

// ─── Главный цикл парсера ─────────────────────────────────────────────────────

async function main() {
  await connectDB();
  console.log('[Parser] Starting...');

  // 1. Первый запуск — находим границу бинарным поиском
  const totalPages = await getTotalPages();
  console.log(`[Parser] Total pages: ${totalPages}`);

  let boundaryPage = await findBoundary(totalPages);
  console.log(`[Parser] Boundary at page ${boundaryPage}`);

  // 2. Каждую минуту — парсим от (boundary - 5) до boundary + 2, ищем новые
  async function check() {
    try {
      const fromPage = Math.max(1, boundaryPage - PAGE_BUFFER);
      console.log(`\n[Parser] Checking pages ${fromPage}..${boundaryPage + 2}...`);

      const listings = await scrapePages(fromPage, boundaryPage + 2);
      const newListings = await saveNewListings(listings);

      if (newListings.length > 0) {
        console.log(`[Parser] Found ${newListings.length} NEW listings!`);
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