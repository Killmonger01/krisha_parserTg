const { connectDB, Listing } = require('./db');
const { getTotalPages, findBoundary, scrapePages, sleep } = require('./krisha');
const axios = require('axios');

// ─── Конфиг ───────────────────────────────────────────────────────────────────

const CHECK_INTERVAL = 60 * 1000;
const PAGE_BUFFER = 5;
const BOT_URL = process.env.BOT_URL;

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
      if (err.code !== 11000) {
        console.error(`[DB] Error saving ${listing.url}:`, err.message);
      }
    }
  }

  return newListings;
}

// ─── Уведомить бота о новых объявлениях ───────────────────────────────────────

async function notifyBot(newListings) {
  try {
    const ids = newListings.map(l => l._id.toString());
    await axios.post(`${BOT_URL}/new-listings`, { listingIds: ids });
    console.log(`[Parser] Sent ${ids.length} listing IDs to bot`);
  } catch (err) {
    console.error(`[Parser] Failed to notify bot:`, err.message);
  }
}

// ─── Главный цикл парсера ─────────────────────────────────────────────────────

async function main() {
  await connectDB();
  console.log('[Parser] Starting...');

  const totalPages = await getTotalPages();
  console.log(`[Parser] Total pages: ${totalPages}`);

  let boundaryPage = await findBoundary(totalPages);
  console.log(`[Parser] Boundary at page ${boundaryPage}`);

  async function check() {
    try {
      const fromPage = Math.max(1, boundaryPage - PAGE_BUFFER);
      console.log(`\n[Parser] Checking pages ${fromPage}..${boundaryPage + 2}...`);

      const listings = await scrapePages(fromPage, boundaryPage + 2);
      const newListings = await saveNewListings(listings);

      if (newListings.length > 0) {
        console.log(`[Parser] Found ${newListings.length} NEW listings!`);
        await notifyBot(newListings);
      } else {
        console.log(`[Parser] No new listings.`);
      }

      // Обновляем границу
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

  await check();

  setInterval(check, CHECK_INTERVAL);
  console.log(`[Parser] Monitoring every ${CHECK_INTERVAL / 1000}s...`);
}

main().catch(err => {
  console.error('[Parser] Fatal error:', err);
  process.exit(1);
});