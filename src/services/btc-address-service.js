// ══════════════════════════════════════════════════
// src/services/btc-address-service.js
// Derives unique Bitcoin addresses per buyer from xpub
// ══════════════════════════════════════════════════

const bitcoin = require('bitcoinjs-lib');
const bip32 = require('bip32');
const ecc = require('tiny-secp256k1');
const pool = require('../db/pool');

// 🔴 BTC_TREASURY_EXTENDED_PUBLIC_KEY must be set in .env (your xpub from Sparrow)
const XPUB = process.env.BTC_TREASURY_EXTENDED_PUBLIC_KEY;

// Initialize BIP32 with secp256k1
const BIP32Factory = bip32.BIP32Factory || bip32.default?.BIP32Factory;
let bip32Instance;
try {
  bip32Instance = (BIP32Factory || bip32)(ecc);
} catch (e) {
  bip32Instance = bip32.fromBase58 ? bip32 : null;
}

// Derive a unique bc1q... address for a specific index
function deriveAddress(index) {
  if (!XPUB) throw new Error('BTC_TREASURY_EXTENDED_PUBLIC_KEY not set in .env');

  let node;
  if (bip32Instance && bip32Instance.fromBase58) {
    node = bip32Instance.fromBase58(XPUB);
  } else {
    node = bip32.fromBase58(XPUB);
  }

  // Derive path: /0/{index} — each buyer gets their own index
  const child = node.derive(0).derive(index);

  // Generate Native SegWit (bc1q...) address
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network: bitcoin.networks.bitcoin,
  });

  return address;
}

// Get or create a BTC address for a buyer
async function getBtcAddressForBuyer(buyerWallet) {
  // Check if buyer already has a BTC address assigned
  const existing = await pool.query(
    "SELECT btc_deposit_address, btc_address_index FROM buyers WHERE buyer_wallet = $1",
    [buyerWallet]
  );

  if (existing.rows[0]?.btc_deposit_address) {
    return existing.rows[0].btc_deposit_address;
  }

  // Get next available index
  const maxIndex = await pool.query(
    "SELECT COALESCE(MAX(btc_address_index), -1) + 1 as next_index FROM buyers WHERE btc_address_index IS NOT NULL"
  );
  const nextIndex = parseInt(maxIndex.rows[0].next_index);

  // Derive address
  const address = deriveAddress(nextIndex);

  // Save to buyer record
  await pool.query(
    "UPDATE buyers SET btc_deposit_address = $1, btc_address_index = $2 WHERE buyer_wallet = $3",
    [address, nextIndex, buyerWallet]
  );

  return address;
}

module.exports = { deriveAddress, getBtcAddressForBuyer };
