// ══════════════════════════════════════════════════
// src/services/announce-service.js
// Public buy announcements to the Telegram channel.
//
// Distinct from alert-service.js, which sends private operational alerts
// to the team. This posts to a PUBLIC channel, so everything here is
// written on the assumption that strangers, competitors and scammers read
// every message. Wallet addresses are truncated, and nothing that
// identifies a buyer beyond their public on-chain address is ever sent.
//
// Announcements must never affect a purchase. Every call is wrapped so a
// Telegram outage, a rate limit, or a misconfigured channel id degrades to
// a log line rather than a failed payment.
// ══════════════════════════════════════════════════

const axios = require('axios');
const pool = require('../db/pool');

// Reuses the existing alert bot. That bot must be added to the channel as
// an administrator with "Post Messages" permission, otherwise Telegram
// answers 403 and nothing is published.
const BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN;

// Where announcements go. Either may be set, or both: the channel is the
// broadcast feed, the group is where people talk. A purchase posted to both
// appears once in each.
//
// Each is a public @username (e.g. "@flowdexprotocol") or a numeric id
// (e.g. "-1001234567890"). The numeric form survives a rename, so prefer it
// once you have it. For a group, the bot must be a member with permission
// to post; for a channel, an administrator with Post Messages.
function destinations() {
  return [process.env.TELEGRAM_CHANNEL_ID, process.env.TELEGRAM_GROUP_ID].filter(Boolean);
}

// Announcements are on whenever a destination is configured. There is no
// separate on/off flag: the presence of TELEGRAM_CHANNEL_ID (or
// TELEGRAM_GROUP_ID) IS the switch, and one fewer variable is one fewer
// thing to be set wrong.
//
// To silence announcements, remove the destination variables. To send
// somewhere else, change them.

// Dust filter. A presale attracts $1 test transactions, and a channel full
// of them reads worse than an empty one.
const MIN_USD = parseFloat(process.env.PUBLIC_ANNOUNCE_MIN_USD || '25');

// Every purchase post reaches someone already thinking about buying, so the
// message ends with somewhere to go. Set PUBLIC_BUY_URL if the buy page ever
// moves; the default is where it lives today. Shown as the bare domain
// rather than a button: a link reads as information, a button as an advert.
const BUY_URL = (process.env.PUBLIC_BUY_URL || 'https://buy.flowdexprotocol.com')
  .trim().replace(/\/$/, '');
const BUY_LABEL = BUY_URL.replace(/^https?:\/\//, '');

function configured() {
  return !!BOT_TOKEN && destinations().length > 0;
}

// Shows enough of an address to be recognisable to its owner and verifiable
// against a block explorer, without turning the channel into a convenient
// list of wallets for anyone building a target list.
function shortWallet(address) {
  const a = String(address || '');
  if (a.length <= 14) return a;
  return a.slice(0, 6) + '…' + a.slice(-4);
}

// Crypto amounts need more precision than money: 0.0043 BTC is a real
// purchase, "$0.00" is not a useful thing to print.
function formatCrypto(amount, currency) {
  const n = Number(amount) || 0;
  const stable = ['USDT', 'USDC', 'BUSD', 'DAI'].includes(String(currency).toUpperCase());
  const digits = stable ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatUsd(value) {
  return '$' + (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatTokens(value) {
  return (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ── Delivery queue ──
// Telegram allows roughly 20 messages a minute to a channel and answers 429
// beyond that. A presale launch can confirm purchases far faster than that,
// so messages are spaced rather than fired as they arrive. Without this, a
// busy hour would drop exactly the announcements worth seeing.
const SEND_INTERVAL_MS = 3500;

// Bounded so a sustained surge cannot grow the queue without limit. Sized
// to survive a full bulk import (500 rows) rather than a handful: dropping
// most of a legitimate batch was the old behaviour and it lost exactly the
// messages worth sending. At one message every 3.5s a full batch takes
// about 30 minutes to drain, which reads as a steady feed rather than a
// wall of posts.
const MAX_QUEUE = 600;

const queue = [];
let draining = false;

// Failures are alerted at most once an hour. A misconfigured bot fails on
// every single purchase, and a Telegram alert per failure would bury the
// team in exactly the moment they need to read something.
let lastFailureAlertAt = 0;
const FAILURE_ALERT_INTERVAL_MS = 60 * 60 * 1000;

async function reportFailure(status, detail) {
  console.error('[ANNOUNCE] Telegram post failed' + (status ? ' (' + status + ')' : '') + ': ' + detail);

  const now = Date.now();
  if (now - lastFailureAlertAt < FAILURE_ALERT_INTERVAL_MS) return;
  lastFailureAlertAt = now;

  let hint = '';
  if (status === 403) hint = 'The bot is probably not an administrator of the channel, or lacks Post Messages.';
  else if (status === 400) hint = 'The chat id is probably wrong (TELEGRAM_CHANNEL_ID / TELEGRAM_GROUP_ID).';
  else if (status === 429) hint = 'Rate limited by Telegram despite queueing.';

  try {
    // Required lazily: alert-service does not import this module, but keeping
    // the dependency one-directional avoids any chance of a cycle later.
    const { sendAlert } = require('./alert-service');
    await sendAlert('Buy Announcements Failing',
      'Purchases are being recorded normally, but the public channel is not receiving them.\n' +
      (status ? 'HTTP ' + status + '\n' : '') + detail + (hint ? '\n' + hint : '') +
      '\n\nFurther failures will be summarised hourly rather than alerted individually.',
      'warning');
  } catch (err) {
    console.error('[ANNOUNCE] Could not raise failure alert:', err.message);
  }
}

async function send(text) {
  // Each destination is attempted independently: a group the bot was removed
  // from must not stop the channel post going out.
  for (const chatId of destinations()) {
    try {
      await axios.post(
        'https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage',
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 8000 }
      );
    } catch (err) {
      await reportFailure(
        err.response?.status,
        chatId + ': ' + (err.response?.data?.description || err.message)
      );
    }
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      await send(queue.shift());
      if (queue.length) await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
    }
  } finally {
    draining = false;
  }
}

// Returns immediately. Announcing must never hold up a purchase, so the
// caller never waits on Telegram.
function post(text) {
  queue.push(text);
  if (queue.length > MAX_QUEUE) {
    const dropped = queue.length - MAX_QUEUE;
    queue.splice(0, dropped);
    console.warn('[ANNOUNCE] Queue over ' + MAX_QUEUE + ' — dropped ' + dropped + ' older announcement(s).');
  }
  drain();
}

// ───────────────────────────────────────────────
// Next tier price.
//
// Found by price rather than by id: tier prices only ascend, so the tier
// after this one is simply the cheapest tier priced above it. That means no
// caller has to pass a tier id, and it stays correct in the case where a
// purchase fills its tier and advances the presale — the message still names
// the tier after the one the buyer actually got, not the one after that.
//
// Tier prices are fixed once seeded, so the cache never needs invalidating.
// A null result is cached too: at the final tier there is no next price, and
// that should not re-query on every announcement.
// ───────────────────────────────────────────────
const nextPriceCache = new Map();

async function nextTierPrice(tierPrice) {
  const price = Number(tierPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (nextPriceCache.has(price)) return nextPriceCache.get(price);

  try {
    const r = await pool.query(
      'SELECT price FROM tiers WHERE price > $1 ORDER BY price ASC LIMIT 1', [price]
    );
    const next = r.rows[0] ? Number(r.rows[0].price) : null;
    nextPriceCache.set(price, next);
    return next;
  } catch (err) {
    // The announcement is worth more than the extra line. Never let a
    // failed lookup stop a purchase being posted.
    console.error('[ANNOUNCE] Next-tier lookup failed:', err.message);
    return null;
  }
}

// ───────────────────────────────────────────────
// Purchase announcement.
//
// One format for every purchase, whatever route it arrived by. An OTC deal
// settled by bank transfer and an on-chain ETH purchase are both somebody
// buying FDP, and the channel says so identically. Nothing marks a purchase
// as OTC, by design.
//
// The paid-in line has three shapes, in descending order of what is known:
//
//   both amount and currency  ->  0.52 ETH ($5,000)
//   currency only             ->  $5,000 in ETH
//   neither                   ->  $5,000
//
// The middle case exists because the crypto amount is optional on an
// imported allocation. It is deliberately NOT computed from the live price:
// the investor paid at the rate on their day, and publishing a figure they
// never sent, attached to their purchase, is worse than naming no figure at
// all. Omit both for a purchase settled in fiat.
// ───────────────────────────────────────────────
// The header scales with the purchase, so a large buy stands out in a feed
// of small ones without the message having to shout. The wording stays plain
// at every size: the icon carries the emphasis, and nothing here claims
// anything about what the token will be worth later.
function headerFor(usdValue) {
  const usd = Number(usdValue) || 0;
  if (usd >= 10000) return '\uD83D\uDC8E <b>Large purchase</b>';
  if (usd >= 1000) return '\uD83D\uDD25 <b>New purchase</b>';
  return '\u26A1 <b>New purchase</b>';
}

async function announcePurchase({ wallet, cryptoAmount, currency, usdValue, tokens, tierName, tierPrice, receivedAt }) {
  if (!configured()) return;
  if ((Number(usdValue) || 0) < MIN_USD) return;

  let paidIn;
  if (cryptoAmount && currency) {
    paidIn = '<b>' + formatCrypto(cryptoAmount, currency) + ' ' + currency + '</b>' +
      (usdValue ? ' (' + formatUsd(usdValue) + ')' : '');
  } else if (currency) {
    paidIn = '<b>' + formatUsd(usdValue) + '</b> in ' + currency;
  } else {
    paidIn = '<b>' + formatUsd(usdValue) + '</b>';
  }

  // A payment entered hours or days after it arrived should not read as
  // having just happened. When the receipt date is not today, the message
  // says when it was, so the post is a record rather than an implied
  // "moments ago".
  const when = receivedAt ? new Date(receivedAt) : null;
  const isToday = when && !isNaN(when.getTime())
    && when.toDateString() === new Date().toDateString();

  const lines = [
    headerFor(usdValue),
    '',
    '<code>' + shortWallet(wallet) + '</code> bought ' + paidIn,
    formatTokens(tokens) + ' FDP',
  ];

  if (when && !isNaN(when.getTime()) && !isToday) {
    lines.push('');
    lines.push('Received ' + when.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    }));
  }

  // The tier line carries the only urgency the message needs: what the next
  // tier costs. It is a fact about the price ladder, not a claim about what
  // the token will do, and it says plainly what waiting costs. Nothing about
  // how much has been raised appears here, by design.
  if (tierName) {
    const next = tierPrice ? await nextTierPrice(tierPrice) : null;
    lines.push('');
    lines.push(
      tierName +
      (tierPrice ? ' · $' + Number(tierPrice) : '') +
      (next ? ' · next tier $' + next : '')
    );
  }

  lines.push('');
  lines.push('Buy FDP: <a href="' + BUY_URL + '">' + BUY_LABEL + '</a>');

  post(lines.join('\n'));
}

module.exports = { announcePurchase, shortWallet };
