// ══════════════════════════════════════════════════
// src/services/notification-service.js
// Stores notifications for buyers — frontend polls
// ══════════════════════════════════════════════════

const pool = require('../db/pool');

// Notification types:
// purchase_confirmed — "Your purchase of 500,000 $FDP has been confirmed"
// tier_closed — "Tier 1 has closed. Your TGE claim is now available."
// claim_ready — "You have 25,000 $FDP ready to claim from Tier 1"
// referral_bonus — "You earned 90,000 bonus $FDP + $210 Terminal Credits from a referral"
// tier_closing_soon — "Tier 1 is 90% full. Price increases when it closes."

async function createNotification(wallet, type, title, message) {
  await pool.query(
    'INSERT INTO notifications (wallet, type, title, message) VALUES ($1, $2, $3, $4)',
    [wallet.toLowerCase(), type, title, message]
  );
}

async function getUnreadNotifications(wallet) {
  const result = await pool.query(
    'SELECT * FROM notifications WHERE wallet = $1 AND is_read = false ORDER BY created_at DESC LIMIT 20',
    [wallet.toLowerCase()]
  );
  return result.rows;
}

async function markAsRead(wallet, notificationId) {
  await pool.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND wallet = $2',
    [notificationId, wallet.toLowerCase()]
  );
}

async function markAllRead(wallet) {
  await pool.query(
    'UPDATE notifications SET is_read = true WHERE wallet = $1 AND is_read = false',
    [wallet.toLowerCase()]
  );
}

module.exports = { createNotification, getUnreadNotifications, markAsRead, markAllRead };
