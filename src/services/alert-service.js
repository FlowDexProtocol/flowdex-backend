// ══════════════════════════════════════════════════
// src/services/alert-service.js
// Sends Telegram alerts for critical events
// ══════════════════════════════════════════════════

const axios = require('axios');

// 🔴 INSERT YOUR TELEGRAM BOT TOKEN (from @BotFather)
const BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN;

// 🔴 INSERT CHAT IDs FOR ATLAS AND HELIX
// To get chat ID: message your bot, then visit:
// https://api.telegram.org/bot<TOKEN>/getUpdates
function getChatIds() {
  return [process.env.ALERT_CHAT_ID_ATLAS, process.env.ALERT_CHAT_ID_HELIX].filter(Boolean);
}

async function sendAlert(title, message, severity) {
  if (!BOT_TOKEN) return; // Not configured yet — skip silently
  const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  const text = emoji + ' *' + title + '*\n\n' + message + '\n\n_FlowDex Backend Alert_';

  for (const chatId of getChatIds()) {
    try {
      await axios.post('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      console.error('[ALERT] Failed to send to ' + chatId + ':', err.message);
    }
  }
}

// Pre-built alert functions
async function alertReconciliationMismatch(details) {
  await sendAlert('Reconciliation Mismatch',
    'Discrepancies found in last reconciliation run.\n' +
    'Unmatched incoming: ' + details.unmatched_incoming + '\n' +
    'Unmatched records: ' + details.unmatched_records + '\n' +
    'Check admin dashboard immediately.', 'critical');
}

async function alertTierNearlyFull(tierId, pct) {
  await sendAlert('Tier ' + tierId + ' is ' + pct + '% Full',
    'Tier ' + tierId + ' is approaching its hard cap.\n' +
    'Prepare for tier advancement and TGE claim generation.', 'warning');
}

async function alertWebhookDown(minutesSince) {
  await sendAlert('Webhook Health Warning',
    'No Alchemy webhook received in ' + minutesSince + ' minutes.\n' +
    'Check Alchemy dashboard and server connectivity.', 'critical');
}

async function alertSupplyLow(remaining, pct) {
  await sendAlert('Token Supply Alert',
    'Presale supply utilization at ' + pct + '%.\n' +
    'Remaining tokens to allocate: ' + Number(remaining).toLocaleString() + '\n' +
    'Review allocation pace.', 'warning');
}

async function alertLargePurchase(wallet, amount, tokens) {
  await sendAlert('Large Purchase Detected',
    'Wallet: ' + wallet.substring(0,8) + '...' + wallet.slice(-4) + '\n' +
    'Amount: $' + amount.toLocaleString() + '\n' +
    'Tokens: ' + tokens.toLocaleString() + ' $FDP', 'info');
}

async function alertTierAdvanced(fromTier, toTier) {
  await sendAlert('Tier Advanced',
    'Tier ' + fromTier + ' has closed. ' + (toTier ? ('Tier ' + toTier + ' is now active.') : 'Presale is complete — all tiers closed.') + '\n' +
    'TGE claims for Tier ' + fromTier + ' have been generated.', 'info');
}

async function alertUnknownToken(currency, tokenName, amount, contractAddress, chain, senderWallet) {
  await sendAlert('Unknown Token Received',
    'Token: ' + currency + ' (' + (tokenName || 'unknown') + ')\n' +
    'Amount: ' + amount + '\n' +
    'Contract: ' + (contractAddress || 'native') + '\n' +
    'Chain: ' + chain + '\n' +
    'From: ' + senderWallet.substring(0,8) + '...' + '\n' +
    'Action: Set USD value in admin dashboard.',
    'warning');
}

module.exports = {
  sendAlert, alertReconciliationMismatch, alertTierNearlyFull,
  alertWebhookDown, alertSupplyLow, alertLargePurchase, alertTierAdvanced, alertUnknownToken
};
