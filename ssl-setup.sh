#!/bin/bash
# ══════════════════════════════════════════════════
# ssl-setup.sh — Let's Encrypt SSL
# Run after Nginx is configured and DNS is pointing to your server
# ══════════════════════════════════════════════════

# 🔴 INSERT YOUR DOMAIN AND EMAIL
sudo certbot --nginx -d 🔴_api.flowdexprotocol.com --email 🔴_your@email.com --agree-tos --non-interactive

# Auto-renewal test
sudo certbot renew --dry-run

# Certbot auto-renews via systemd timer — no cron needed
echo "SSL installed. Certificate auto-renews every 90 days."
