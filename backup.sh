#!/bin/bash
# ══════════════════════════════════════════════════
# backup.sh — Daily PostgreSQL backup
# Add to crontab: 0 2 * * * /var/www/flowdex-backend/backup.sh
# Runs at 2:00 AM server time daily (rule #10: always backup the database daily)
# ══════════════════════════════════════════════════

BACKUP_DIR="/var/backups/flowdex"
DATE=$(date +%Y-%m-%d_%H%M)
# 🔴 INSERT YOUR DATABASE NAME
DB_NAME="🔴_flowdex_presale"
KEEP_DAYS=30

# Create backup directory
mkdir -p $BACKUP_DIR

# Dump database
pg_dump $DB_NAME | gzip > "$BACKUP_DIR/flowdex_$DATE.sql.gz"

# Remove backups older than 30 days
find $BACKUP_DIR -name "flowdex_*.sql.gz" -mtime +$KEEP_DAYS -delete

# Log
echo "$(date): Backup completed — flowdex_$DATE.sql.gz" >> $BACKUP_DIR/backup.log

# Optional: Copy to remote storage
# 🔴 OPTIONAL: Upload to S3 or DigitalOcean Spaces
# aws s3 cp "$BACKUP_DIR/flowdex_$DATE.sql.gz" s3://🔴_YOUR_BUCKET/backups/
