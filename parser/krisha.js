const axios = require('axios');
const { District } = require('./db');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://krisha.kz/',
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function cleanText(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Определение района из адреса (берёт районы из базы) ──────────────────────

let cachedDistricts = null;

async function getDistricts() {
  if (!cachedDistricts) {
    const docs = await District.find();
    cachedDistricts = docs.map(d => d.name);
  }
  return cachedDistricts;
}

async function detectDistrict(address) {
  if (!address) return null;
  const districts = await getDistricts();
  const lower = address.toLowerCase();
  for (const d of districts) {
    if (lower.includes(d.toLowerCase())) return d;
  }
  return null;
}

// ─── Загрузка страницы ────────────────────────────────────────────────────────

async function fetchPage(page = 1) {
  const url = 'https://krisha.kz/arenda/kvartiry/almaty/';
  const res = await axios.get(url, {
    params: { page },
    headers: HEADERS,
    maxRedirects: 5,
    decompress: true,
    responseType: 'text',
  });
  return res.data;
}

// ─── Парсинг объявлений ───────────────────────────────────────────────────────

async function parseListings(html) {
  const listings = [];
  const cardRegex = /<div[^>]+class="a-card a-storage-live[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const block = match[0];
    const listing = {};

    const linkMatch = block.match(/href="(\/a\/show\/\d+[^"]*)"/);
    if (linkMatch) listing.url = 'https://krisha.kz' + linkMatch[1];

    const titleMatch = block.match(/class="[^"]*a-card__title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (titleMatch) listing.title = cleanText(titleMatch[1]);

    const priceMatch = block.match(/class="[^"]*a-card__price[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (priceMatch) listing.priceStr = cleanText(priceMatch[1]);

    const addressMatch = block.match(/class="[^"]*a-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (addressMatch) listing.address = cleanText(addressMatch[1]);

    const imgMatch = block.match(/(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (imgMatch) listing.photo = imgMatch[1];

    if (block.includes('user-specialist') || block.includes('user-label-identified-specialist')) {
      listing.ownerType = 'агент';
    } else {
      listing.ownerType = 'частник';
    }

    if (block.includes('common-b vip')) {
      listing.adType = 'vip';
    } else if (block.includes('topb')) {
      listing.adType = 'top';
    } else if (block.includes('tm-click-checked-hot-adv')) {
      listing.adType = 'горячее';
    } else {
      listing.adType = 'обычное';
    }

    listing.isPaid = listing.adType !== 'обычное';

    if (listing.priceStr) {
      const num = parseInt(listing.priceStr.replace(/\D/g, ''));
      listing.price = isNaN(num) ? null : num;
    }

    listing.district = await detectDistrict(listing.address);

    if (listing.title) {
      const roomsMatch = listing.title.match(/(\d+)-комн/);
      listing.rooms = roomsMatch ? parseInt(roomsMatch[1]) : null;
    }

    if (listing.url) listings.push(listing);
  }

  return listings;
}

// ─── Общее количество страниц ─────────────────────────────────────────────────

function parseTotalPages(html) {
  const pageNumbers = [];
  const dataPageRegex = /data-page="(\d+)"/g;
  let m;
  while ((m = dataPageRegex.exec(html)) !== null) {
    pageNumbers.push(parseInt(m[1]));
  }
  if (pageNumbers.length > 0) return Math.max(...pageNumbers);

  const totalMatch = html.match(/Найдено\s*<span>([\d\s]+)<\/span>/);
  if (totalMatch) {
    const total = parseInt(totalMatch[1].replace(/\s/g, ''));
    if (!isNaN(total)) return Math.ceil(total / 20);
  }

  return 1;
}

async function getTotalPages() {
  const html = await fetchPage(1);
  return parseTotalPages(html);
}

// ─── Классификация страницы ───────────────────────────────────────────────────

async function classifyPage(page) {
  const html = await fetchPage(page);
  const listings = await parseListings(html);

  if (listings.length === 0) {
    return { type: 'empty', listings: [] };
  }

  const paidCount = listings.filter(l => l.isPaid).length;
  const freeCount = listings.filter(l => !l.isPaid).length;

  let type;
  if (paidCount > 0 && freeCount > 0) type = 'mixed';
  else if (paidCount > 0) type = 'paid';
  else type = 'free';

  console.log(`  Page ${page}: ${type} (paid=${paidCount}, free=${freeCount})`);
  return { type, listings };
}

// ─── Бинарный поиск границы ───────────────────────────────────────────────────

async function findBoundary(totalPages) {
  console.log(`[Boundary] Binary search in ${totalPages} pages...`);

  let lo = 1;
  let hi = totalPages;
  let boundaryPage = 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = await classifyPage(mid);
    await sleep(500);

    if (result.type === 'mixed') {
      console.log(`[Boundary] Found at page ${mid}`);
      return mid;
    } else if (result.type === 'paid') {
      lo = mid + 1;
      boundaryPage = mid;
    } else {
      hi = mid - 1;
    }
  }

  console.log(`[Boundary] Approximate at page ${boundaryPage}`);
  return boundaryPage;
}

// ─── Парсинг диапазона страниц ────────────────────────────────────────────────

async function scrapePages(fromPage, toPage) {
  const allListings = [];

  for (let page = fromPage; page <= toPage; page++) {
    try {
      const html = await fetchPage(page);
      const listings = await parseListings(html);

      if (listings.length === 0) {
        console.log(`  Page ${page}: empty, stopping.`);
        break;
      }

      allListings.push(...listings);
      console.log(`  Page ${page}: ${listings.length} listings (total: ${allListings.length})`);
      await sleep(800);
    } catch (err) {
      console.error(`  Page ${page}: error - ${err.message}`);
      break;
    }
  }

  return allListings;
}

module.exports = {
  fetchPage,
  parseListings,
  getTotalPages,
  classifyPage,
  findBoundary,
  scrapePages,
  sleep,
};