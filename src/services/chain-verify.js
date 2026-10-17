// ══════════════════════════════════════════════════
// src/services/chain-verify.js
// Independent on-chain confirmation for inbound webhook payments.
//
// Why this exists: a webhook payload is a CLAIM that a payment happened,
// not evidence of it. Before this module, that claim was trusted on the
// strength of a shared secret alone (Alchemy), or on nothing at all
// (Helius). Either way, forging a payment required no on-chain activity —
// just a well-formed POST.
//
// This asks the chain directly: does this transaction exist, did it
// succeed, did it pay OUR address, from the claimed sender, for the
// claimed amount? A forged payload fails because the transaction was
// never mined. That holds regardless of who holds the signing key.
//
// Reuses ETHERSCAN_API_KEY (Etherscan V2, already used by bsc-monitor.js
// and reconciliation.js) and HELIUS_API_KEY — no new credentials.
// ══════════════════════════════════════════════════

const axios = require('axios');

// Etherscan V2 covers every EVM chain off one key via chainid.
const EVM_CHAIN_IDS = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
};

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Webhook providers report amounts as decimal floats, which lose precision
// against on-chain integers. 1% tolerance absorbs that without being wide
// enough to let a meaningfully inflated amount through.
const AMOUNT_TOLERANCE = 0.01;

// A transaction can reach us before the explorer has indexed it. Retry
// once rather than rejecting a legitimate early payment.
const NOT_FOUND_RETRY_MS = 4000;

// When the verification API itself is unreachable, accepting the payment
// is usually the lesser evil: the signature already passed, and
// reconciliation.js compares on-chain against the database every 6 hours,
// so a wrongly-accepted payment surfaces there. Set CHAIN_VERIFY_FAIL_OPEN
// to 'false' to reject instead once you are confident in the plumbing.
const FAIL_OPEN = process.env.CHAIN_VERIFY_FAIL_OPEN !== 'false';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withinTolerance(actual, claimed) {
  if (!claimed || claimed <= 0) return false;
  return Math.abs(actual - claimed) / claimed <= AMOUNT_TOLERANCE;
}

function topicToAddress(topic) {
  if (!topic || topic.length < 42) return '';
  return ('0x' + topic.slice(-40)).toLowerCase();
}

function ok(detail) {
  return { verified: true, reason: 'confirmed_on_chain', detail };
}
function reject(reason, detail) {
  return { verified: false, failOpen: false, reason, detail };
}
function unavailable(reason, detail) {
  return { verified: false, failOpen: FAIL_OPEN, reason, detail };
}

// ───────────────────────────────────────────────
// EVM
// ───────────────────────────────────────────────

async function evmRpc(chainId, action, params, apiKey) {
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=proxy&action=${action}` +
    Object.entries(params).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('') +
    `&apikey=${apiKey}`;
  const res = await axios.get(url, { timeout: 8000 });
  // Etherscan returns rate-limit and key errors in `message`/`result` rather
  // than an HTTP error, so a string result is a failure, not a payload.
  if (typeof res.data?.result === 'string' && res.data.result.startsWith('Max')) {
    throw new Error('rate_limited: ' + res.data.result);
  }
  return res.data?.result ?? null;
}

async function verifyEvm({ txHash, chain, expectedTo, expectedFrom, expectedAmount, contractAddress, decimals }) {
  const chainId = EVM_CHAIN_IDS[chain];
  if (!chainId) return unavailable('unsupported_chain', `no Etherscan chainid for '${chain}'`);

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) return unavailable('no_api_key', 'ETHERSCAN_API_KEY is not set');

  const to = (expectedTo || '').toLowerCase();
  const from = (expectedFrom || '').toLowerCase();

  let receipt;
  try {
    receipt = await evmRpc(chainId, 'eth_getTransactionReceipt', { txhash: txHash }, apiKey);
    if (!receipt) {
      await sleep(NOT_FOUND_RETRY_MS);
      receipt = await evmRpc(chainId, 'eth_getTransactionReceipt', { txhash: txHash }, apiKey);
    }
  } catch (err) {
    return unavailable('lookup_failed', err.message);
  }

  // Still nothing after a retry: either not mined, or never existed. Both
  // mean we must not credit it now. A real late-indexed payment is caught
  // by reconciliation.js.
  if (!receipt) return reject('tx_not_found', 'no receipt on-chain after retry');
  if (receipt.status && receipt.status !== '0x1') return reject('tx_reverted', 'receipt status ' + receipt.status);

  // ── ERC-20 transfer: the value lives in the Transfer log, not tx.value ──
  if (contractAddress) {
    const token = contractAddress.toLowerCase();
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    const match = logs.find((log) =>
      (log.address || '').toLowerCase() === token &&
      (log.topics || [])[0] === TRANSFER_TOPIC &&
      topicToAddress((log.topics || [])[2]) === to
    );
    if (!match) return reject('no_transfer_to_us', `no ${token} Transfer log crediting ${to}`);

    const logFrom = topicToAddress(match.topics[1]);
    if (from && logFrom !== from) return reject('sender_mismatch', `log from ${logFrom}, claimed ${from}`);

    const dec = Number.isFinite(decimals) ? decimals : 18;
    const actual = Number(BigInt(match.data)) / Math.pow(10, dec);
    if (!withinTolerance(actual, expectedAmount)) {
      return reject('amount_mismatch', `on-chain ${actual}, claimed ${expectedAmount}`);
    }
    return ok(`erc20 ${actual} verified on ${chain}`);
  }

  // ── Native transfer ──
  let tx;
  try {
    tx = await evmRpc(chainId, 'eth_getTransactionByHash', { txhash: txHash }, apiKey);
  } catch (err) {
    return unavailable('lookup_failed', err.message);
  }
  if (!tx) return reject('tx_not_found', 'receipt present but transaction missing');

  if ((tx.to || '').toLowerCase() !== to) {
    return reject('recipient_mismatch', `tx.to ${tx.to}, expected ${to}`);
  }
  if (from && (tx.from || '').toLowerCase() !== from) {
    return reject('sender_mismatch', `tx.from ${tx.from}, claimed ${from}`);
  }

  const actual = Number(BigInt(tx.value || '0x0')) / 1e18;
  if (!withinTolerance(actual, expectedAmount)) {
    return reject('amount_mismatch', `on-chain ${actual}, claimed ${expectedAmount}`);
  }
  return ok(`native ${actual} verified on ${chain}`);
}

// ───────────────────────────────────────────────
// Solana
// ───────────────────────────────────────────────

async function heliusRpc(method, params) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error('HELIUS_API_KEY is not set');
  const res = await axios.post(
    `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
    { jsonrpc: '2.0', id: 1, method, params },
    { timeout: 8000 }
  );
  if (res.data?.error) throw new Error(res.data.error.message || 'rpc error');
  return res.data?.result ?? null;
}

async function verifySolana({ txHash, expectedTo, expectedFrom, expectedAmount, mint }) {
  let tx;
  try {
    tx = await heliusRpc('getTransaction', [
      txHash,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!tx) {
      await sleep(NOT_FOUND_RETRY_MS);
      tx = await heliusRpc('getTransaction', [
        txHash,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
    }
  } catch (err) {
    if (/not set/.test(err.message)) return unavailable('no_api_key', err.message);
    return unavailable('lookup_failed', err.message);
  }

  if (!tx) return reject('tx_not_found', 'signature not found on Solana after retry');
  if (tx.meta?.err) return reject('tx_failed', JSON.stringify(tx.meta.err));

  // ── SPL token transfer: compare token balance deltas for our owner ──
  if (mint) {
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    const ours = post.filter((b) => b.owner === expectedTo && b.mint === mint);
    if (!ours.length) return reject('no_transfer_to_us', `no ${mint} balance for ${expectedTo}`);

    let credited = 0;
    for (const after of ours) {
      const before = pre.find((b) => b.accountIndex === after.accountIndex);
      credited += (after.uiTokenAmount?.uiAmount || 0) - (before?.uiTokenAmount?.uiAmount || 0);
    }
    if (credited <= 0) return reject('no_transfer_to_us', 'token balance did not increase');
    if (!withinTolerance(credited, expectedAmount)) {
      return reject('amount_mismatch', `on-chain ${credited}, claimed ${expectedAmount}`);
    }
    return ok(`spl ${credited} verified`);
  }

  // ── Native SOL: lamport delta on our account index ──
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
    typeof k === 'string' ? k : k.pubkey
  );
  const idx = keys.indexOf(expectedTo);
  if (idx === -1) return reject('no_transfer_to_us', `${expectedTo} not among accounts`);

  const pre = tx.meta?.preBalances?.[idx];
  const post = tx.meta?.postBalances?.[idx];
  if (pre === undefined || post === undefined) {
    return unavailable('lookup_failed', 'balances missing from transaction meta');
  }

  const credited = (post - pre) / 1e9;
  if (credited <= 0) return reject('no_transfer_to_us', 'SOL balance did not increase');
  if (!withinTolerance(credited, expectedAmount)) {
    return reject('amount_mismatch', `on-chain ${credited}, claimed ${expectedAmount}`);
  }
  if (expectedFrom && !keys.includes(expectedFrom)) {
    return reject('sender_mismatch', `${expectedFrom} not among accounts`);
  }
  return ok(`native ${credited} SOL verified`);
}

module.exports = { verifyEvm, verifySolana, FAIL_OPEN };
