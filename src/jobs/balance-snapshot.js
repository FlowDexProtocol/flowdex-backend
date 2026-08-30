// ══════════════════════════════════════════════════
// src/jobs/balance-snapshot.js
// 6-hourly wallet balance verification.
// Compares each treasury address's on-chain native-coin balance against
// (confirmed purchases in that currency) - (withdrawals in that currency).
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');

async function getExpectedBalance(chain, currency) {
  const purchased = await pool.query(
    "SELECT COALESCE(SUM(crypto_amount), 0) as t FROM purchases WHERE chain = $1 AND crypto_currency = $2 AND status = 'confirmed'",
    [chain, currency]
  );
  const withdrawn = await pool.query(
    "SELECT COALESCE(SUM(crypto_amount), 0) as t FROM withdrawals WHERE chain = $1 AND crypto_currency = $2",
    [chain, currency]
  );
  return parseFloat(purchased.rows[0].t) - parseFloat(withdrawn.rows[0].t);
}

async function recordSnapshot(chain, wallet, currency, onChainBalance) {
  const expected = await getExpectedBalance(chain, currency);
  const difference = onChainBalance - expected;
  const status = Math.abs(difference) < 0.0001 ? 'match' : 'discrepancy';

  await pool.query(
    `INSERT INTO balance_snapshots (chain, wallet_address, on_chain_balance, expected_balance, difference, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [chain, wallet, onChainBalance, expected, difference, status]
  );

  if (status === 'discrepancy') {
    console.warn('[BALANCE] ' + chain + ' discrepancy: on-chain=' + onChainBalance + ' expected=' + expected);
  }
  return { chain, wallet, on_chain_balance: onChainBalance, expected_balance: expected, difference, status };
}

async function checkEthereumBalance() {
  const address = process.env.EVM_RECEIVING_ADDRESS;
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!address || !apiKey) return null;

  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address=${address}&tag=latest&apikey=${apiKey}`;
  const res = await axios.get(url, { timeout: 10000 });
  const balanceEth = parseInt(res.data.result) / 1e18;
  return recordSnapshot('ethereum', address, 'ETH', balanceEth);
}

async function checkSolanaBalance() {
  const address = process.env.SOLANA_RECEIVING_ADDRESS;
  if (!address) return null;

  const res = await axios.post('https://api.mainnet-beta.solana.com', {
    jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address],
  }, { timeout: 10000 });
  const balanceSol = (res.data.result?.value || 0) / 1e9;
  return recordSnapshot('solana', address, 'SOL', balanceSol);
}

async function checkTronBalance() {
  const address = process.env.TRON_RECEIVING_ADDRESS;
  if (!address) return null;

  const res = await axios.get('https://api.trongrid.io/v1/accounts/' + address, { timeout: 10000 });
  const account = res.data.data?.[0];
  const balanceTrx = (account?.balance || 0) / 1e6;
  return recordSnapshot('tron', address, 'TRX', balanceTrx);
}

async function checkBtcBalance() {
  const addresses = await pool.query(
    "SELECT DISTINCT btc_deposit_address FROM buyers WHERE btc_deposit_address IS NOT NULL"
  );
  if (addresses.rows.length === 0) return null;

  let totalBalance = 0;
  for (const row of addresses.rows) {
    try {
      const res = await axios.get('https://blockstream.info/api/address/' + row.btc_deposit_address, { timeout: 5000 });
      const funded = res.data.chain_stats.funded_txo_sum + res.data.mempool_stats.funded_txo_sum;
      const spent = res.data.chain_stats.spent_txo_sum + res.data.mempool_stats.spent_txo_sum;
      totalBalance += (funded - spent) / 100000000;
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (err) {
      console.error('[BALANCE] BTC lookup failed for ' + row.btc_deposit_address + ':', err.message);
    }
  }
  return recordSnapshot('bitcoin', 'all_derived_addresses', 'BTC', totalBalance);
}

async function takeBalanceSnapshot() {
  const results = [];
  for (const fn of [checkEthereumBalance, checkSolanaBalance, checkTronBalance, checkBtcBalance]) {
    try {
      const r = await fn();
      if (r) results.push(r);
    } catch (err) {
      console.error('[BALANCE] Snapshot check failed:', err.message);
    }
  }
  console.log('[BALANCE] Snapshot complete: ' + results.map(r => r.chain + '=' + r.status).join(', '));
  return results;
}

module.exports = { takeBalanceSnapshot };

if (require.main === module) {
  takeBalanceSnapshot().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
