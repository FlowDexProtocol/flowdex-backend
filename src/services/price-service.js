// ══════════════════════════════════════════════════
// src/services/price-service.js
// Uses CoinMarketCap for live price feeds, with a CoinGecko fallback for
// extended CMC outages. See refreshPriceCache() for the 429 backoff design.
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');

// 🔴 COINMARKETCAP_API_KEY must be set in .env (from pro.coinmarketcap.com)
const API_KEY = process.env.COINMARKETCAP_API_KEY;

// CMC uses symbols directly — no ID mapping needed
const SYMBOLS = 'ETH,BNB,SOL,BTC,USDT,USDC,TRX';

// ── CMC 429 backoff + outage tracking ──
// consecutive429Count / nextRetryAt implement the exponential backoff: 10min,
// 20min, 40min, capped at 60min, reset to 0 on the next successful CMC call.
// downSince marks when CMC started failing (429 or otherwise) so we know
// when it's been down long enough (30min) to reach for the CoinGecko
// fallback below — it's cleared only by a real CMC success, not a
// CoinGecko one, so we keep retrying CMC on its own schedule regardless.
let consecutive429Count = 0;
let nextRetryAt = 0;
let downSince = null;

const MIN_BACKOFF_MINUTES = 10;
const MAX_BACKOFF_MINUTES = 60;
const FALLBACK_AFTER_MINUTES = 30;

// CoinGecko's free simple/price endpoint — no API key required. Only covers
// the coins CoinGecko's free tier lists by id; USDC/TRX aren't included, so
// those just keep aging until CMC recovers (getPrice's 15-minute guard then
// refuses to serve them rather than serving something wrong).
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COINGECKO_ID_TO_SYMBOL = {
  ethereum: 'ETH',
  bitcoin: 'BTC',
  binancecoin: 'BNB',
  solana: 'SOL',
  tether: 'USDT',
};

function shouldTryCoinGeckoFallback() {
  return downSince !== null && Date.now() - downSince > FALLBACK_AFTER_MINUTES * 60 * 1000;
}

async function refreshFromCoinGecko() {
  try {
    const response = await axios.get(COINGECKO_URL, {
      params: { ids: Object.keys(COINGECKO_ID_TO_SYMBOL).join(','), vs_currencies: 'usd' },
      timeout: 5000,
    });

    const now = new Date();
    let updated = 0;
    for (const [id, symbol] of Object.entries(COINGECKO_ID_TO_SYMBOL)) {
      const price = response.data[id]?.usd;
      if (price) {
        await pool.query(
          'INSERT INTO price_cache (crypto, usd_price, updated_at) VALUES ($1, $2, $3) ON CONFLICT (crypto) DO UPDATE SET usd_price = $2, updated_at = $3',
          [symbol, price, now]
        );
        updated++;
      }
    }
    console.warn('[PRICE] CMC has been down for over ' + FALLBACK_AFTER_MINUTES + ' min — used CoinGecko fallback, updated ' + updated + ' price(s).');
  } catch (err) {
    console.error('[PRICE] CoinGecko fallback also failed:', err.message);
  }
}

async function refreshPriceCache() {
  const now = Date.now();

  // Still cooling down from a recent 429 — skip the CMC call entirely
  // rather than making the rate limit worse. If CMC has been down long
  // enough, lean on CoinGecko in the meantime.
  if (nextRetryAt && now < nextRetryAt) {
    console.log('[PRICE] Backing off CMC after repeated 429s — next attempt at ' + new Date(nextRetryAt).toISOString());
    if (shouldTryCoinGeckoFallback()) await refreshFromCoinGecko();
    return;
  }

  try {
    // 🔴 Uses your CoinMarketCap API key
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
      {
        params: { symbol: SYMBOLS, convert: 'USD' },
        headers: { 'X-CMC_PRO_API_KEY': API_KEY },
        timeout: 5000,
      }
    );

    consecutive429Count = 0;
    nextRetryAt = 0;
    downSince = null;

    const data = response.data.data;
    const priceNow = new Date();

    for (const [symbol, info] of Object.entries(data)) {
      const price = info.quote?.USD?.price;
      if (price) {
        await pool.query(
          'INSERT INTO price_cache (crypto, usd_price, updated_at) VALUES ($1, $2, $3) ON CONFLICT (crypto) DO UPDATE SET usd_price = $2, updated_at = $3',
          [symbol, price, priceNow]
        );
      }
    }
  } catch (err) {
    if (downSince === null) downSince = now;

    if (err.response?.status === 429) {
      consecutive429Count += 1;
      const waitMinutes = Math.min(MAX_BACKOFF_MINUTES, MIN_BACKOFF_MINUTES * 2 ** (consecutive429Count - 1));
      nextRetryAt = now + waitMinutes * 60 * 1000;
      console.error('[PRICE] CMC rate-limited (429) — backing off ' + waitMinutes + ' min (consecutive #' + consecutive429Count + ')');
    } else {
      console.error('[PRICE] CMC refresh failed:', err.message);
    }

    if (shouldTryCoinGeckoFallback()) await refreshFromCoinGecko();
  }
}

async function getPrice(crypto) {
  const symbol = crypto.toUpperCase();
  const r = await pool.query(
    'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
    [symbol]
  );

  let result;
  if (r.rows.length === 0) {
    await refreshPriceCache();
    const r2 = await pool.query(
      'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
      [symbol]
    );
    result = r2.rows[0] || null;
  } else {
    const cached = r.rows[0];
    const cachedAgeMinutes = (Date.now() - new Date(cached.updated_at).getTime()) / 60000;

    // The cron refreshes every 5 minutes; only force an on-demand refresh
    // here if the cache has drifted well past that window (a missed cron
    // tick, or a fresh deploy) — refreshPriceCache() has its own 429 backoff
    // guard, so calling it here can't itself become a source of rate-limit
    // hammering the way the old 30-second threshold did.
    if (cachedAgeMinutes > 6) {
      await refreshPriceCache();
      const fresh = await pool.query(
        'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
        [symbol]
      );
      result = fresh.rows[0] || cached;
    } else {
      result = cached;
    }
  }

  if (!result) return null;

  // Even after attempting a refresh above, the price may still be stale if
  // the upstream feed (CoinMarketCap, and once it's been down 30+ minutes,
  // the CoinGecko fallback too) has been failing repeatedly — never let a
  // purchase lock in a price that old. 15 minutes (up from 5) gives real
  // buffer for a brief CMC outage to ride out the 10-60 minute 429 backoff.
  const ageMinutes = (Date.now() - new Date(result.updated_at).getTime()) / 60000;
  if (ageMinutes > 15) {
    console.warn('[PRICE] Stale price for ' + symbol + ' — last updated ' + ageMinutes.toFixed(1) + ' minutes ago. Refusing to serve it.');
    return null;
  }

  // is_delayed: surfaced to the frontend so the buy page can show a "Prices
  // may be delayed" warning once a price is over 5 minutes old, without
  // refusing to show it outright (that only happens past 15 minutes above).
  return { ...result, is_delayed: ageMinutes > 5 };
}

async function lockPrice(crypto) {
  const p = await getPrice(crypto);
  if (!p) throw new Error('No price available for ' + crypto);

  return {
    price: parseFloat(p.usd_price),
    lockedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    source: 'coinmarketcap',
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

module.exports = { refreshPriceCache, getPrice, lockPrice, fetchPriceByContract };
