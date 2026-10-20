// ══════════════════════════════════════════════════
// src/services/buyer-count.js
// One definition of "a buyer", imported everywhere it is reported.
//
// There used to be three answers live at once: /api/public/stats counted
// distinct wallets with a confirmed purchase (which excluded every OTC
// investor), /api/stats counted every row in `buyers` (which included anyone
// who had merely connected a wallet and never paid), and the leaderboard
// counted both purchase routes. With $13,500 raised entirely through OTC,
// those read 0, 3 and 2 respectively.
//
// A buyer is a wallet that has paid for tokens, by either route. That is the
// same set the leaderboard draws from, so the count and the list can no
// longer disagree.
// ══════════════════════════════════════════════════

const pool = require('./../db/pool');

// Wallets are lowercased on both sides before the union: an OTC allocation
// is stored lowercased by the importer, while an on-chain purchase is
// lowercased at confirmation. Normalising here means one wallet that bought
// by both routes counts once, not twice.
const DISTINCT_BUYERS_SQL = `
  SELECT COUNT(*)::int AS t FROM (
    SELECT LOWER(buyer_wallet) AS w
    FROM purchases
    WHERE status = 'confirmed'
    UNION
    SELECT LOWER(investor_wallet) AS w
    FROM otc_allocations
    WHERE status IN ('completed', 'partial') AND paid_amount > 0
  ) AS everyone
`;

async function countBuyers() {
  const r = await pool.query(DISTINCT_BUYERS_SQL);
  return parseInt(r.rows[0].t, 10);
}

// Every wallet that has ever connected, whether or not it paid. Reported
// separately and named for what it is, rather than as a buyer count.
async function countWalletsConnected() {
  const r = await pool.query('SELECT COUNT(*)::int AS t FROM buyers');
  return parseInt(r.rows[0].t, 10);
}

module.exports = { countBuyers, countWalletsConnected, DISTINCT_BUYERS_SQL };
