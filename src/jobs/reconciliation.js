// ══════════════════════════════════════════════════
// src/jobs/reconciliation.js
// 6-hourly on-chain vs database comparison.
// Runs before every tier close (rule #9). OTC allocations are excluded —
// their payment was off-chain (rule #13).
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');
const { alertReconciliationMismatch } = require('../services/alert-service');

const PERIOD_HOURS = 24; // look back window per run — overlapping windows catch anything a prior run missed

async function reconcileEthereum() {
  const address = process.env.EVM_RECEIVING_ADDRESS;
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!address || !apiKey) return null;

  const cutoff = Math.floor((Date.now() - PERIOD_HOURS * 60 * 60 * 1000) / 1000);
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

  const response = await axios.get(url, { timeout: 10000 });
  const onChainTxs = (response.data.result || []).filter(tx =>
    parseInt(tx.timeStamp) >= cutoff && tx.to.toLowerCase() === address.toLowerCase() && tx.isError === '0'
  );

  const dbResult = await pool.query(
    // OTC excluded — its payment was off-chain (rule #13)
    "SELECT tx_hash FROM purchases WHERE chain = 'ethereum' AND created_at > NOW() - ($1 || ' hours')::interval",
    [PERIOD_HOURS]
  );

  return buildResult('ethereum', onChainTxs.map(t => t.hash), dbResult.rows.map(r => r.tx_hash));
}

async function reconcileTron() {
  const address = process.env.TRON_RECEIVING_ADDRESS;
  if (!address) return null;

  // Get TRC-20 USDT transfers from TronGrid
  const url = 'https://api.trongrid.io/v1/accounts/' + address + '/transactions/trc20';
  const response = await axios.get(url, {
    params: { only_to: true, limit: 200, contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    timeout: 5000,
  });

  const onChainTxs = response.data.data || [];
  const dbResult = await pool.query(
    "SELECT tx_hash FROM purchases WHERE chain = 'tron' AND created_at > NOW() - INTERVAL '24 hours'"
  );

  return buildResult('tron', onChainTxs.map(tx => tx.transaction_id), dbResult.rows.map(r => r.tx_hash));
}

async function buildResult(chain, chainHashesArr, dbHashesArr) {
  const dbHashes = new Set(dbHashesArr);
  const chainHashes = new Set(chainHashesArr);

  const unmatchedIncoming = chainHashesArr.filter(h => !dbHashes.has(h));
  const unmatchedRecords = dbHashesArr.filter(h => !chainHashes.has(h));

  const status = (unmatchedIncoming.length === 0 && unmatchedRecords.length === 0) ? 'clean' : 'discrepancies_found';

  await pool.query(
    `INSERT INTO reconciliation_results (period_start, period_end, chain, total_on_chain_txs, total_database_records,
       matched, unmatched_incoming, unmatched_records, status, discrepancy_details)
     VALUES (NOW() - INTERVAL '24 hours', NOW(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [chain, chainHashesArr.length, dbHashesArr.length,
     Math.min(chainHashesArr.length, dbHashesArr.length),
     unmatchedIncoming.length, unmatchedRecords.length, status,
     JSON.stringify({ unmatched_incoming: unmatchedIncoming, unmatched_records: unmatchedRecords })]
  );

  if (status !== 'clean') {
    console.warn('[RECONCILIATION] ' + chain + ': ' + unmatchedIncoming.length + ' unmatched incoming, ' + unmatchedRecords.length + ' unmatched records');
  }

  return { chain, status, unmatched_incoming: unmatchedIncoming.length, unmatched_records: unmatchedRecords.length };
}

async function runReconciliation() {
  const results = [];
  try {
    const eth = await reconcileEthereum();
    if (eth) results.push(eth);
  } catch (err) { console.error('[RECONCILIATION] Ethereum failed:', err.message); }

  try {
    const tron = await reconcileTron();
    if (tron) results.push(tron);
  } catch (err) { console.error('[RECONCILIATION] TRON failed:', err.message); }

  const dirty = results.filter(r => r.status !== 'clean');
  if (dirty.length > 0) {
    for (const r of dirty) {
      await alertReconciliationMismatch({ unmatched_incoming: r.unmatched_incoming, unmatched_records: r.unmatched_records });
    }
  }

  console.log('[RECONCILIATION] Run complete: ' + results.map(r => r.chain + '=' + r.status).join(', '));
  return results;
}

module.exports = { runReconciliation, reconcileEthereum, reconcileTron };

if (require.main === module) {
  runReconciliation().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
