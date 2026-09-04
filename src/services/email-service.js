// ══════════════════════════════════════════════════
// src/services/email-service.js
// SendGrid email notifications — purchase confirmations, referral
// notifications, large-purchase alerts, and the daily admin digest.
//
// Fail-silent by design: if SENDGRID_API_KEY is unset, or a send throws,
// every function here swallows the error and returns. Nothing in this file
// is allowed to interrupt the purchase-confirmation flow.
// ══════════════════════════════════════════════════

const sgMail = require('@sendgrid/mail');
const pool = require('../db/pool');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const TZ = process.env.TIMEZONE || 'Asia/Dubai';
const FROM = process.env.EMAIL_FROM || 'noreply@flowdexprotocol.com';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://flowdexprotocol.com').split(',')[0].trim().replace(/\/$/, '');

// Resolves the effective SendGrid API key: cms_settings (admin-set via
// PUT /admin/settings/sendgrid) takes priority, falling back to the
// SENDGRID_API_KEY env var. Re-checked on every send rather than cached at
// module load, so an admin updating the key via the dashboard takes effect
// immediately — no redeploy needed. The cms_settings query is wrapped in
// its own try/catch: on a database that hasn't been migrated to include
// that table yet, this silently falls through to the env var instead of
// breaking every email send.
async function getApiKey() {
  try {
    const result = await pool.query("SELECT value FROM cms_settings WHERE key = 'sendgrid_api_key'");
    const dbKey = result.rows[0]?.value;
    if (dbKey) return dbKey;
  } catch (err) {
    console.error('[EMAIL] cms_settings lookup failed, falling back to env var:', err.message);
  }
  return process.env.SENDGRID_API_KEY || null;
}

const EXPLORER_TX_URL = {
  ethereum: 'https://etherscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  solana: 'https://solscan.io/tx/',
  bitcoin: 'https://mempool.space/tx/',
  tron: 'https://tronscan.org/#/transaction/',
  arbitrum: 'https://arbiscan.io/tx/',
  polygon: 'https://polygonscan.com/tx/',
  base: 'https://basescan.org/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
};

function explorerLink(chain, txHash) {
  const base = EXPLORER_TX_URL[chain];
  return base && txHash ? base + txHash : null;
}

function fmtNum(n, decimals = 2) {
  const v = parseFloat(n);
  if (!isFinite(v)) return '0';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

function fmtUsd(n) {
  return '$' + fmtNum(n, 2);
}

// ── Shared dark-themed HTML wrapper for every template ──
function wrapEmail(preheader, contentHtml) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FlowDex Protocol</title>
</head>
<body style="margin:0;padding:0;background-color:#060D18;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#060D18;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#0B1524;border-radius:12px;overflow:hidden;">
<tr><td style="padding:32px 40px 24px 40px;border-bottom:1px solid #1B2B45;">
<span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.5px;font-family:'DM Sans',Helvetica,Arial,sans-serif;">FLOW<span style="color:#627EEA;">DEX</span></span>
</td></tr>
<tr><td style="padding:32px 40px;color:#ffffff;font-size:14px;line-height:1.65;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
${contentHtml}
</td></tr>
<tr><td style="padding:20px 40px 28px 40px;border-top:1px solid #1B2B45;color:#6B7A94;font-size:12px;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
FlowDex Protocol — this is an automated message, please do not reply.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function ctaButton(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background-color:#627EEA;">
<a href="${href}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;font-family:'DM Sans',Helvetica,Arial,sans-serif;">${label}</a>
</td></tr></table>`;
}

function statRow(label, value) {
  return `<tr>
<td style="padding:8px 0;color:#8C9BB5;font-size:13px;border-bottom:1px solid #1B2B45;">${label}</td>
<td style="padding:8px 0;color:#ffffff;font-size:13px;font-weight:600;text-align:right;border-bottom:1px solid #1B2B45;">${value}</td>
</tr>`;
}

async function sendEmail(to, subject, html) {
  if (!to) return;
  const apiKey = await getApiKey();
  if (!apiKey) return;
  try {
    sgMail.setApiKey(apiKey);
    await sgMail.send({ to, from: FROM, subject, html });
  } catch (err) {
    console.error('[EMAIL] Failed to send "' + subject + '" to ' + to + ':', err.message);
  }
}

// Like sendEmail, but surfaces the real result instead of failing silently —
// used only by the admin-triggered "Send Test Email" action, where swallowing
// the error would defeat the entire point of testing.
async function sendTestEmail(to) {
  const apiKey = await getApiKey();
  if (!apiKey) return { success: false, error: 'No SendGrid API key configured (set one via Admin Settings, or the SENDGRID_API_KEY env var).' };

  const html = wrapEmail(
    'This is a test email from your FlowDex admin dashboard.',
    `
    <h2 style="margin:0 0 4px 0;color:#ffffff;font-size:18px;">Test Email</h2>
    <p style="margin:0 0 20px 0;color:#8C9BB5;">This is a test email sent from the FlowDex admin dashboard to confirm your SendGrid configuration is working.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${statRow('Sent At', dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss') + ' (' + TZ + ')')}
      ${statRow('Sent To', to)}
    </table>
    `
  );

  try {
    sgMail.setApiKey(apiKey);
    await sgMail.send({ to, from: FROM, subject: 'FlowDex Admin — Test Email', html });
    return { success: true, message: 'Test email sent to ' + to + '.' };
  } catch (err) {
    const detail = err.response?.body?.errors?.[0]?.message || err.message;
    return { success: false, error: detail };
  }
}

// ══════════════════════════════════════════════════
// 1. Purchase Confirmation — sent to the buyer (if we have their email on
//    file, matched by wallet address in email_subscribers)
// ══════════════════════════════════════════════════
async function sendPurchaseConfirmation(purchase, tier) {
  try {
    const sub = await pool.query(
      `SELECT email FROM email_subscribers WHERE wallet_address = $1 AND is_active = true
       ORDER BY subscribed_at DESC LIMIT 1`,
      [purchase.buyer_wallet]
    );
    const to = sub.rows[0]?.email;
    if (!to) return;

    let bonusTokens = 0;
    if (purchase.referred_by_code) {
      const bonusResult = await pool.query(
        `SELECT bonus_tokens FROM bonus_allocations WHERE source_purchase_id = $1 AND role = 'buyer' LIMIT 1`,
        [purchase.id]
      );
      bonusTokens = parseFloat(bonusResult.rows[0]?.bonus_tokens || 0);
    }

    const link = explorerLink(purchase.chain, purchase.tx_hash);
    const vestingLine = tier.cliff_months > 0
      ? `${tier.tge_percentage}% unlocks at TGE, remainder vests linearly over ${tier.vest_months} months following a ${tier.cliff_months}-month cliff.`
      : `${tier.tge_percentage}% unlocks at TGE, remainder vests linearly over ${tier.vest_months} months.`;

    const html = wrapEmail(
      `Your purchase of ${fmtNum(purchase.tokens_allocated, 0)} $FDP is confirmed.`,
      `
      <h2 style="margin:0 0 4px 0;color:#ffffff;font-size:18px;">Purchase Confirmed</h2>
      <p style="margin:0 0 20px 0;color:#8C9BB5;">Thank you for participating in the FlowDex Protocol presale.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${statRow('Amount Paid', `${fmtNum(purchase.crypto_amount, 6)} ${purchase.crypto_currency}`)}
        ${statRow('USD Value', fmtUsd(purchase.usd_value))}
        ${statRow('Tier', purchase.tier_name)}
        ${statRow('Tier Price', fmtUsd(purchase.tier_price) + ' / $FDP')}
        ${statRow('Tokens Allocated', fmtNum(purchase.tokens_allocated, 2) + ' $FDP')}
        ${bonusTokens > 0 ? statRow('Referral Bonus Tokens', '+' + fmtNum(bonusTokens, 2) + ' $FDP') : ''}
        ${statRow('Transaction Hash', purchase.tx_hash.slice(0, 10) + '...' + purchase.tx_hash.slice(-8))}
      </table>
      ${link ? `<p style="margin:16px 0 0 0;"><a href="${link}" style="color:#627EEA;text-decoration:none;">View transaction on block explorer &rarr;</a></p>` : ''}
      <div style="margin:24px 0;padding:16px;background-color:#0F1B30;border-radius:8px;border:1px solid #1B2B45;">
        <p style="margin:0 0 4px 0;color:#8C9BB5;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Vesting Schedule</p>
        <p style="margin:0;color:#ffffff;font-size:13px;">${vestingLine}</p>
      </div>
      <p style="margin:0 0 8px 0;color:#8C9BB5;">Know someone who'd be interested? Share your referral code and earn 30% in bonus tokens and credits on their purchase.</p>
      ${ctaButton('View Your Portfolio', FRONTEND_URL + '/portfolio?wallet=' + encodeURIComponent(purchase.buyer_wallet))}
      `
    );

    await sendEmail(to, 'Purchase Confirmed — ' + fmtNum(purchase.tokens_allocated, 0) + ' $FDP Allocated', html);
  } catch (err) {
    console.error('[EMAIL] sendPurchaseConfirmation failed:', err.message);
  }
}

// ══════════════════════════════════════════════════
// 2. Referral Purchase Notification — sent to the referrer when someone
//    they referred completes a purchase
// ══════════════════════════════════════════════════
async function sendReferralNotification(referrerWallet, purchase) {
  try {
    const sub = await pool.query(
      `SELECT email FROM email_subscribers WHERE wallet_address = $1 AND is_active = true
       ORDER BY subscribed_at DESC LIMIT 1`,
      [referrerWallet]
    );
    const to = sub.rows[0]?.email;
    if (!to) return;

    const bonusResult = await pool.query(
      `SELECT bonus_tokens, terminal_credits_usd, tokens_burned FROM bonus_allocations
       WHERE source_purchase_id = $1 AND role = 'referrer' LIMIT 1`,
      [purchase.id]
    );
    const bonus = bonusResult.rows[0];
    if (!bonus) return;

    const html = wrapEmail(
      'Your referral just earned you bonus tokens and credits.',
      `
      <h2 style="margin:0 0 4px 0;color:#ffffff;font-size:18px;">Referral Bonus Earned</h2>
      <p style="margin:0 0 20px 0;color:#8C9BB5;">Someone you referred just completed a purchase of ${fmtUsd(purchase.usd_value)} in Tier ${purchase.tier_name}. Here's your 15% referral bonus:</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${statRow('Bonus Tokens', '+' + fmtNum(bonus.bonus_tokens, 2) + ' $FDP')}
        ${statRow('Terminal Credits', fmtUsd(bonus.terminal_credits_usd))}
        ${statRow('Tokens Burned (bonus funding)', fmtNum(bonus.tokens_burned, 2) + ' $FDP')}
      </table>
      ${ctaButton('View Your Referral Earnings', FRONTEND_URL + '/referrals?wallet=' + encodeURIComponent(referrerWallet))}
      `
    );

    await sendEmail(to, 'You Earned a Referral Bonus — ' + fmtNum(bonus.bonus_tokens, 0) + ' $FDP', html);
  } catch (err) {
    console.error('[EMAIL] sendReferralNotification failed:', err.message);
  }
}

// ══════════════════════════════════════════════════
// 3. Large Purchase Alert — sent immediately to super_admins when a single
//    purchase exceeds $10,000
// ══════════════════════════════════════════════════
async function sendLargePurchaseAlert(purchase) {
  try {
    const admins = await pool.query(
      `SELECT email FROM admin_users WHERE role = 'super_admin' AND is_active = true AND email IS NOT NULL AND email != ''`
    );
    if (admins.rows.length === 0) return;

    const link = explorerLink(purchase.chain, purchase.tx_hash);
    const html = wrapEmail(
      `Large purchase alert: ${fmtUsd(purchase.usd_value)}`,
      `
      <h2 style="margin:0 0 4px 0;color:#ffffff;font-size:18px;">Large Purchase Alert</h2>
      <p style="margin:0 0 20px 0;color:#8C9BB5;">A single purchase exceeded the $10,000 threshold.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${statRow('Wallet', purchase.buyer_wallet.slice(0, 8) + '...' + purchase.buyer_wallet.slice(-6))}
        ${statRow('USD Value', fmtUsd(purchase.usd_value))}
        ${statRow('Tokens Allocated', fmtNum(purchase.tokens_allocated, 2) + ' $FDP')}
        ${statRow('Tier', purchase.tier_name)}
        ${statRow('Currency', purchase.crypto_currency + ' (' + purchase.chain + ')')}
      </table>
      ${link ? `<p style="margin:16px 0 0 0;"><a href="${link}" style="color:#627EEA;text-decoration:none;">View transaction on block explorer &rarr;</a></p>` : ''}
      `
    );

    for (const admin of admins.rows) {
      await sendEmail(admin.email, 'Large Purchase Alert — ' + fmtUsd(purchase.usd_value), html);
    }
  } catch (err) {
    console.error('[EMAIL] sendLargePurchaseAlert failed:', err.message);
  }
}

// ══════════════════════════════════════════════════
// 4. Daily Admin Digest — cron job, 08:00 GMT+4 daily, sent to every
//    admin_users row with role='super_admin' and an email on file
// ══════════════════════════════════════════════════
async function sendDailyAdminDigest() {
  try {
    const admins = await pool.query(
      `SELECT email FROM admin_users WHERE role = 'super_admin' AND is_active = true AND email IS NOT NULL AND email != ''`
    );
    if (admins.rows.length === 0) return;

    const today = dayjs().tz(TZ).format('YYYY-MM-DD');

    const [purchasesToday, newBuyersToday, totalsResult, activeTierResult, topPurchases] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count, COALESCE(SUM(usd_value),0) as usd FROM purchases WHERE day_gmt4 = $1 AND status = 'confirmed'`, [today]),
      pool.query(`SELECT COUNT(*) as count FROM buyers WHERE created_at::date = $1::date`, [today]),
      pool.query(`SELECT COALESCE(SUM(total_raised_usd),0) as total FROM tiers`),
      pool.query(`SELECT name FROM tiers WHERE is_active = true LIMIT 1`),
      pool.query(
        `SELECT buyer_wallet, usd_value, tokens_allocated FROM purchases
         WHERE day_gmt4 = $1 AND status = 'confirmed' ORDER BY usd_value DESC LIMIT 5`,
        [today]
      ),
    ]);

    const activeBuyersResult = await pool.query(
      `SELECT COUNT(DISTINCT buyer_wallet) as count FROM purchases WHERE day_gmt4 = $1 AND status = 'confirmed'`,
      [today]
    );

    const { getWebhookHealth } = require('./webhook-health');
    const health = getWebhookHealth();

    const purchaseRows = purchasesToday.rows[0];
    const totalRaised = totalsResult.rows[0].total;
    const currentTier = activeTierResult.rows[0]?.name || 'None active';

    const topRows = topPurchases.rows.map((p) =>
      statRow(p.buyer_wallet.slice(0, 6) + '...' + p.buyer_wallet.slice(-4), fmtUsd(p.usd_value) + ' (' + fmtNum(p.tokens_allocated, 0) + ' $FDP)')
    ).join('');

    const html = wrapEmail(
      `Daily digest for ${today} — ${fmtUsd(purchaseRows.usd)} raised today`,
      `
      <h2 style="margin:0 0 4px 0;color:#ffffff;font-size:18px;">Daily Admin Digest</h2>
      <p style="margin:0 0 20px 0;color:#8C9BB5;">Summary for ${today} (GMT+4).</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${statRow("Today's Purchases", purchaseRows.count)}
        ${statRow('USD Raised Today', fmtUsd(purchaseRows.usd))}
        ${statRow('New Buyers Today', newBuyersToday.rows[0].count)}
        ${statRow('Active Buyers Today', activeBuyersResult.rows[0].count)}
        ${statRow('Total Raised (All-Time)', fmtUsd(totalRaised))}
        ${statRow('Current Active Tier', currentTier)}
        ${statRow('Webhook Health', health.status.toUpperCase() + ' — ' + health.message)}
      </table>
      ${topRows ? `
      <div style="margin:24px 0 0 0;">
        <p style="margin:0 0 8px 0;color:#8C9BB5;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Top Purchases Today</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${topRows}</table>
      </div>` : ''}
      ${ctaButton('Open Admin Dashboard', FRONTEND_URL + '/admin')}
      `
    );

    for (const admin of admins.rows) {
      await sendEmail(admin.email, 'FlowDex Daily Digest — ' + today, html);
    }
  } catch (err) {
    console.error('[EMAIL] sendDailyAdminDigest failed:', err.message);
  }
}

module.exports = {
  sendPurchaseConfirmation,
  sendReferralNotification,
  sendLargePurchaseAlert,
  sendDailyAdminDigest,
  sendTestEmail,
};
