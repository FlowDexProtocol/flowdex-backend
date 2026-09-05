// ══════════════════════════════════════════════════
// src/services/price-service.js
// On-demand price fetching — no background cron. A price is only fetched
// from an upstream API (CoinMarketCap, falling back to CoinGecko) when
// getPrice() is actually called by a request, and even then only if the
// cache is stale and we're not inside the CMC cooldown window.
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');

// 🔴 COINMARKETCAP_API_KEY must be set in .env (from pro.coinmarketcap.com)
const API_KEY = process.env.COINMARKETCAP_API_KEY;

// CMC uses symbols directly — no ID mapping needed
const SYMBOLS = 'ETH,BNB,SOL,BTC,USDT,USDC,TRX';

// A cached price under 30 minutes old is served as-is, no upstream call at all.
const CACHE_FRESH_MINUTES = 30;

// CMC fetches every tracked symbol in a single request, so one shared
// cooldown (rather than a per-symbol one) already guarantees no symbol is
// re-fetched more than once per 2 minutes — and it means a burst of
// concurrent buyers asking about different coins at once still only
// triggers a single CMC call instead of one each.
const CMC_COOLDOWN_MS = 2 * 60 * 1000;
let lastCmcAttemptAt = 0;

// CoinGecko's free simple/price endpoint — no API key required.
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_ID_TO_SYMBOL = {
  ethereum: 'ETH',
  bitcoin: 'BTC',
  binancecoin: 'BNB',
  solana: 'SOL',
  tether: 'USDT',
  'usd-coin': 'USDC',
  tron: 'TRX',
};

async function writePricesToCache(prices) {
  const now = new Date();
  for (const [symbol, price] of Object.entries(prices)) {
    await pool.query(
      'INSERT INTO price_cache (crypto, usd_price, updated_at) VALUES ($1, $2, $3) ON CONFLICT (crypto) DO UPDATE SET usd_price = $2, updated_at = $3',
      [symbol, price, now]
    );
  }
}

// Tries CMC first, falling back to CoinGecko if CMC fails for any reason
// (429, timeout, any other error). Writes whatever succeeds into
// price_cache. Returns true if at least one price was written.
async function refreshFromUpstream() {
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
      {
        params: { symbol: SYMBOLS, convert: 'USD' },
        headers: { 'X-CMC_PRO_API_KEY': API_KEY },
        timeout: 5000,
      }
    );

    const prices = {};
    for (const [symbol, info] of Object.entries(response.data.data)) {
      const price = info.quote?.USD?.price;
      if (price) prices[symbol] = price;
    }
    if (Object.keys(prices).length > 0) {
      await writePricesToCache(prices);
      return true;
    }
  } catch (err) {
    console.error('[PRICE] CMC fetch failed (' + (err.response?.status || err.code || 'error') + '):', err.message);
  }

  try {
    const response = await axios.get(COINGECKO_URL, {
      params: { ids: Object.keys(COINGECKO_ID_TO_SYMBOL).join(','), vs_currencies: 'usd' },
      timeout: 5000,
    });

    const prices = {};
    for (const [id, symbol] of Object.entries(COINGECKO_ID_TO_SYMBOL)) {
      const price = response.data[id]?.usd;
      if (price) prices[symbol] = price;
    }
    if (Object.keys(prices).length > 0) {
      await writePricesToCache(prices);
      console.warn('[PRICE] CMC failed — used CoinGecko fallback for ' + Object.keys(prices).length + ' coin(s).');
      return true;
    }
  } catch (err) {
    console.error('[PRICE] CoinGecko fallback also failed:', err.message);
  }

  return false;
}

// On-demand price lookup:
//   - cached price < 30 min old            -> return it (stale: false), no API call
//   - cached price missing or >= 30 min old -> attempt a fresh fetch (subject
//     to the CMC cooldown above), then:
//       - fetch produced a new price for this symbol -> return it (stale: false)
//       - fetch was skipped (cooldown) or failed, but something's cached   -> return the
//         old cached price anyway (stale: true) instead of refusing outright
//       - nothing cached at all, and the fetch failed/was skipped          -> return null
async function getPrice(crypto) {
  const symbol = crypto.toUpperCase();

  const cached = await pool.query('SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1', [symbol]);
  const row = cached.rows[0] || null;
  const ageMinutes = row ? (Date.now() - new Date(row.updated_at).getTime()) / 60000 : Infinity;

  if (row && ageMinutes < CACHE_FRESH_MINUTES) {
    return { usd_price: parseFloat(row.usd_price), updated_at: row.updated_at, stale: false };
  }

  const now = Date.now();
  if (now - lastCmcAttemptAt > CMC_COOLDOWN_MS) {
    lastCmcAttemptAt = now;
    const previousUpdatedAtMs = row ? new Date(row.updated_at).getTime() : null;

    await refreshFromUpstream();

    const fresh = await pool.query('SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1', [symbol]);
    const freshRow = fresh.rows[0];
    if (freshRow) {
      const updatedAtMs = new Date(freshRow.updated_at).getTime();
      const wasRefreshed = previousUpdatedAtMs === null || updatedAtMs > previousUpdatedAtMs;
      return { usd_price: parseFloat(freshRow.usd_price), updated_at: freshRow.updated_at, stale: !wasRefreshed };
    }
  }

  // Still inside the CMC cooldown, or the refresh didn't produce a price for
  // this symbol — serve the stale cached price rather than refuse entirely.
  if (row) {
    return { usd_price: parseFloat(row.usd_price), updated_at: row.updated_at, stale: true };
  }

  return null;
}

async function lockPrice(crypto) {
  const p = await getPrice(crypto);
  if (!p) throw new Error('No price available for ' + crypto);

  return {
    price: parseFloat(p.usd_price),
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    source: 'coinmarketcap',
    stale: p.stale,
  };
}

// ── Unknown token pricing by contract address ──
const CHAIN_TO_CMC_PLATFORM = {
  ethereum: '1',      // CMC platform ID for Ethereum
  bsc: '14',          // BSC
  arbitrum: '42161',  // Arbitrum
  polygon: '137',     // Polygon
  base: '8453',       // Base
  optimism: '10',     // Optimism
};

async function fetchPriceByContract(contractAddress, chain) {
  if (!contractAddress) return null;

  try {
    const platformId = CHAIN_TO_CMC_PLATFORM[chain];
    if (!platformId) return null;

    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest',
      {
        params: { address: contractAddress, convert: 'USD' },
        headers: { 'X-CMC_PRO_API_KEY': API_KEY },
        timeout: 5000,
      }
    );

    const data = response.data.data;
    if (!data) return null;

    // CMC returns data keyed by token ID
    const tokenId = Object.keys(data)[0];
    if (!tokenId) return null;

    const price = data[tokenId]?.quote?.USD?.price;
    return price || null;

  } catch (err) {
    console.log('[PRICE] Contract lookup failed for ' + contractAddress + ':', err.message);
    return null;
  }
}

module.exports = { getPrice, lockPrice, fetchPriceByContract };
