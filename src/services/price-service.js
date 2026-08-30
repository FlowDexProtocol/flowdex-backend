// ══════════════════════════════════════════════════
// src/services/price-service.js
// Uses CoinMarketCap for live price feeds
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');

// 🔴 COINMARKETCAP_API_KEY must be set in .env (from pro.coinmarketcap.com)
const API_KEY = process.env.COINMARKETCAP_API_KEY;

// CMC uses symbols directly — no ID mapping needed
const SYMBOLS = 'ETH,BNB,SOL,BTC,USDT,USDC,TRX';

async function refreshPriceCache() {
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

    const data = response.data.data;
    const now = new Date();

    for (const [symbol, info] of Object.entries(data)) {
      const price = info.quote?.USD?.price;
      if (price) {
        await pool.query(
          'INSERT INTO price_cache (crypto, usd_price, updated_at) VALUES ($1, $2, $3) ON CONFLICT (crypto) DO UPDATE SET usd_price = $2, updated_at = $3',
          [symbol, price, now]
        );
      }
    }
  } catch (err) {
    console.error('[PRICE] CMC refresh failed:', err.message);
  }
}

async function getPrice(crypto) {
  const symbol = crypto.toUpperCase();
  const r = await pool.query(
    'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
    [symbol]
  );

  if (r.rows.length === 0) {
    await refreshPriceCache();
    const r2 = await pool.query(
      'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
      [symbol]
    );
    return r2.rows[0] || null;
  }

  const cached = r.rows[0];
  const ageSeconds = (Date.now() - new Date(cached.updated_at).getTime()) / 1000;

  // Refresh if older than 30 seconds
  if (ageSeconds > 30) {
    await refreshPriceCache();
    const fresh = await pool.query(
      'SELECT usd_price, updated_at FROM price_cache WHERE crypto = $1',
      [symbol]
    );
    return fresh.rows[0] || cached;
  }

  return cached;
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
