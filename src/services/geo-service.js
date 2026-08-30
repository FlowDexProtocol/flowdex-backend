// ══════════════════════════════════════════════════
// src/services/geo-service.js
// IP geolocation via ip-api.com (free, no key needed, 45 req/min)
// Location tracked for analytics only. No geo-blocking.
// ══════════════════════════════════════════════════

const axios = require('axios');
const crypto = require('crypto');

async function lookupIP(ip) {
  try {
    // Skip local/private IPs
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { country: 'Local', country_code: 'LO', state: 'Local', city: 'Local', blocked: false };
    }
    const res = await axios.get('http://ip-api.com/json/' + ip, { timeout: 3000 });
    if (res.data.status === 'success') {
      return {
        country: res.data.country,
        country_code: res.data.countryCode,
        state: res.data.regionName,
        city: res.data.city,
        blocked: false, // No geo-blocking
      };
    }
    return null;
  } catch (err) {
    console.error('[GEO] Lookup failed:', err.message);
    return null;
  }
}

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + process.env.JWT_SECRET).digest('hex').substring(0, 16);
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.socket.remoteAddress;
}

module.exports = { lookupIP, hashIP, getClientIP };
