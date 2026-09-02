// ══════════════════════════════════════════════════
// src/jobs/disk-monitor.js
// Daily disk usage check — alerts via Telegram if the root filesystem
// is more than 80% full.
// ══════════════════════════════════════════════════

const { execSync } = require('child_process');
const { sendAlert } = require('../services/alert-service');

async function checkDiskUsage() {
  try {
    const usage = execSync("df -h / | tail -1 | awk '{print $5}'").toString().trim();
    const pct = parseInt(usage.replace('%', ''), 10);

    console.log('[DISK] Root filesystem usage: ' + usage);

    if (Number.isFinite(pct) && pct > 80) {
      await sendAlert(
        'Disk Space Warning',
        'Disk usage at ' + pct + '%. Clean up Docker images or old backups.',
        'warning'
      );
    }
  } catch (err) {
    console.error('[DISK] Check failed:', err.message);
  }
}

module.exports = { checkDiskUsage };
