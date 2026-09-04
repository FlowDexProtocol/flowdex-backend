// ══════════════════════════════════════════════════
// src/middleware/admin-auth.js
// Verifies the admin JWT issued by POST /admin/login.
// Payload shape (both login paths): { user_id, username, role }.
// role is one of 'super_admin' | 'editor' | 'viewer' — the legacy
// env-var bootstrap login also issues 'super_admin' (with user_id: 0,
// no real admin_users row) so it keeps full access under the new scheme.
// ══════════════════════════════════════════════════

const jwt = require('jsonwebtoken');

const VALID_ROLES = ['super_admin', 'editor', 'viewer'];

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Invalid token', code: 'NO_TOKEN' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!VALID_ROLES.includes(decoded.role)) {
      return res.status(401).json({ success: false, error: 'Invalid token', code: 'NOT_ADMIN' });
    }
    req.admin = { user_id: decoded.user_id, username: decoded.username, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid token', code: 'TOKEN_INVALID' });
  }
}

module.exports = { adminAuth };
