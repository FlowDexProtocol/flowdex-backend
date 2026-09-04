// ══════════════════════════════════════════════════
// src/middleware/require-role.js
// Role gate — chain after adminAuth (req.admin.role must already be set).
// super_admin > editor > viewer, each level a superset of the ones below it.
// ══════════════════════════════════════════════════

const LEVEL = { viewer: 0, editor: 1, super_admin: 2 };

function requireRole(minRole) {
  const minLevel = LEVEL[minRole];
  return function (req, res, next) {
    const role = req.admin?.role;
    if (LEVEL[role] === undefined || LEVEL[role] < minLevel) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for this action', code: 'FORBIDDEN_ROLE' });
    }
    next();
  };
}

module.exports = { requireRole };
