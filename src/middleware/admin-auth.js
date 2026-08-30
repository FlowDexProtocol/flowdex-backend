// ══════════════════════════════════════════════════
// src/middleware/admin-auth.js
// Verifies the admin JWT issued by POST /admin/login
// (username + bcrypt password + TOTP 2FA — see routes/admin.js)
// ══════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Invalid token', code: 'NO_TOKEN' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(401).json({ success: false, error: 'Invalid token', code: 'NOT_ADMIN' });
    }
    req.admin = { username: decoded.username };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token', code: 'TOKEN_INVALID' });
  }
}

module.exports = { adminAuth };
