// ══════════════════════════════════════════════════
// src/services/webhook-health.js
// Monitors webhook activity — alerts on gaps
// ══════════════════════════════════════════════════

let lastWebhookAt = new Date();
let webhookCount24h = 0;
let alertedThisGap = false;

function recordWebhookReceived() {
  lastWebhookAt = new Date();
  webhookCount24h++;
  alertedThisGap = false;
}

function getWebhookHealth() {
  const minutesSinceLast = (Date.now() - lastWebhookAt.getTime()) / 60000;
  let status = 'healthy';
  if (minutesSinceLast > 60) status = 'critical';
  else if (minutesSinceLast > 30) status = 'warning';

  return {
    last_webhook_at: lastWebhookAt,
    minutes_since_last: Math.floor(minutesSinceLast),
    webhooks_24h: webhookCount24h,
    status,
    message: status === 'critical'
      ? 'No webhook received in ' + Math.floor(minutesSinceLast) + ' minutes. Check Alchemy configuration.'
      : status === 'warning'
      ? 'No webhook in 30+ minutes. May be normal during low activity.'
      : 'Webhooks flowing normally.',
  };
}

// Checked periodically by server.js — fires the Telegram alert once per gap
async function checkWebhookHealthAndAlert() {
  const health = getWebhookHealth();
  if (health.status === 'warning' && !alertedThisGap) {
    const { alertWebhookDown } = require('./alert-service');
    await alertWebhookDown(health.minutes_since_last);
    alertedThisGap = true;
  }
}

// Reset daily counter at midnight
function resetDailyCounter() {
  webhookCount24h = 0;
}

module.exports = { recordWebhookReceived, getWebhookHealth, checkWebhookHealthAndAlert, resetDailyCounter };
