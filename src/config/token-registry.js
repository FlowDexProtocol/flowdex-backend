// ══════════════════════════════════════════════════
// src/config/token-registry.js
// All known EVM token contract addresses across all chains
// If a token is NOT in this list, it's still accepted — just flagged for admin pricing
// ══════════════════════════════════════════════════

const TOKEN_REGISTRY = {

  // ═══ ETHEREUM MAINNET (chainId: 1) ═══
  ethereum: {
    // Stablecoins
    '0xdac17f958d2ee523a2206206994597c13d831ec': { symbol: 'USDT', name: 'Tether USD', decimals: 6, cmcId: 'tether' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', name: 'USD Coin', decimals: 6, cmcId: 'usd-coin' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', name: 'Dai', decimals: 18, cmcId: 'dai' },

    // Major tokens
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, cmcId: 'wrapped-bitcoin' },
    '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', name: 'Chainlink', decimals: 18, cmcId: 'chainlink' },
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', name: 'Uniswap', decimals: 18, cmcId: 'uniswap' },
    '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': { symbol: 'SHIB', name: 'Shiba Inu', decimals: 18, cmcId: 'shiba-inu' },
    '0x6982508145454ce325ddbe47a25d4ec3d2311933': { symbol: 'PEPE', name: 'Pepe', decimals: 18, cmcId: 'pepe' },
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { symbol: 'MATIC', name: 'Polygon', decimals: 18, cmcId: 'polygon' },
    '0x3845badade8e6dff049820680d1f14bd3903a5d0': { symbol: 'SAND', name: 'The Sandbox', decimals: 18, cmcId: 'the-sandbox' },
    '0x0d8775f648430679a709e98d2b0cb6250d2887ef': { symbol: 'BAT', name: 'Basic Attention Token', decimals: 18, cmcId: 'basic-attention-token' },
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', name: 'Aave', decimals: 18, cmcId: 'aave' },
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', name: 'Maker', decimals: 18, cmcId: 'maker' },
  },

  // ═══ BSC MAINNET (chainId: 56) ═══
  bsc: {
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', name: 'Tether USD (BSC)', decimals: 18, cmcId: 'tether' },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', name: 'USD Coin (BSC)', decimals: 18, cmcId: 'usd-coin' },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', name: 'Binance USD', decimals: 18, cmcId: 'binance-usd' },
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': { symbol: 'DAI', name: 'Dai (BSC)', decimals: 18, cmcId: 'dai' },
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': { symbol: 'ETH', name: 'Ethereum (BSC)', decimals: 18, cmcId: 'ethereum' },
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': { symbol: 'BTCB', name: 'Bitcoin BEP2', decimals: 18, cmcId: 'bitcoin' },
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': { symbol: 'CAKE', name: 'PancakeSwap', decimals: 18, cmcId: 'pancakeswap' },
  },

  // ═══ ARBITRUM (chainId: 42161) ═══
  arbitrum: {
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', name: 'Tether USD (ARB)', decimals: 6, cmcId: 'tether' },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', name: 'USD Coin (ARB)', decimals: 6, cmcId: 'usd-coin' },
    '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', name: 'Arbitrum', decimals: 18, cmcId: 'arbitrum' },
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', name: 'Wrapped Bitcoin (ARB)', decimals: 8, cmcId: 'wrapped-bitcoin' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', name: 'Dai (ARB)', decimals: 18, cmcId: 'dai' },
  },

  // ═══ POLYGON (chainId: 137) ═══
  polygon: {
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', name: 'Tether USD (Polygon)', decimals: 6, cmcId: 'tether' },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', name: 'USD Coin (Polygon)', decimals: 6, cmcId: 'usd-coin' },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', name: 'Dai (Polygon)', decimals: 18, cmcId: 'dai' },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', name: 'Wrapped Bitcoin (Polygon)', decimals: 8, cmcId: 'wrapped-bitcoin' },
  },

  // ═══ BASE (chainId: 8453) ═══
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', name: 'USD Coin (Base)', decimals: 6, cmcId: 'usd-coin' },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', name: 'Dai (Base)', decimals: 18, cmcId: 'dai' },
  },

  // ═══ OPTIMISM (chainId: 10) ═══
  optimism: {
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', name: 'Tether USD (OP)', decimals: 6, cmcId: 'tether' },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', name: 'USD Coin (OP)', decimals: 6, cmcId: 'usd-coin' },
    '0x4200000000000000000000000000000000000042': { symbol: 'OP', name: 'Optimism', decimals: 18, cmcId: 'optimism-ethereum' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', name: 'Dai (OP)', decimals: 18, cmcId: 'dai' },
  },
};

// Native token names per chain
const NATIVE_TOKENS = {
  ethereum: { symbol: 'ETH', cmcId: 'ethereum' },
  bsc: { symbol: 'BNB', cmcId: 'binancecoin' },
  arbitrum: { symbol: 'ETH', cmcId: 'ethereum' },
  polygon: { symbol: 'POL', cmcId: 'polygon' },
  base: { symbol: 'ETH', cmcId: 'ethereum' },
  optimism: { symbol: 'ETH', cmcId: 'ethereum' },
};

// Look up a token by contract address and chain
function lookupToken(contractAddress, chain) {
  const chainRegistry = TOKEN_REGISTRY[chain];
  if (!chainRegistry) return null;
  return chainRegistry[contractAddress.toLowerCase()] || null;
}

// Get native token for a chain
function getNativeToken(chain) {
  return NATIVE_TOKENS[chain] || NATIVE_TOKENS.ethereum;
}

module.exports = { TOKEN_REGISTRY, NATIVE_TOKENS, lookupToken, getNativeToken };
