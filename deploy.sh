#!/bin/bash
# ══════════════════════════════════════════════════
# deploy.sh — FlowDex Backend Server Setup
# Run as root on a fresh Ubuntu 22.04/24.04 server
# ══════════════════════════════════════════════════

echo "═══ FlowDex Backend Deployment ═══"

# 1. System updates
apt update && apt upgrade -y

# 2. Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
echo "Node.js version: $(node -v)"

# 3. Install PostgreSQL
apt install -y postgresql postgresql-contrib
systemctl start postgresql
systemctl enable postgresql
echo "PostgreSQL installed"

# 4. Create database and user
# 🔴 CHANGE THESE CREDENTIALS
sudo -u postgres psql -c "CREATE USER 🔴_YOUR_DB_USERNAME WITH PASSWORD '🔴_YOUR_DB_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE flowdex_presale OWNER 🔴_YOUR_DB_USERNAME;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE flowdex_presale TO 🔴_YOUR_DB_USERNAME;"
echo "Database created"

# 5. Install PM2 (process manager)
npm install -g pm2
echo "PM2 installed"

# 6. Install Nginx (reverse proxy)
apt install -y nginx
systemctl start nginx
systemctl enable nginx
echo "Nginx installed"

# 7. Install Certbot (SSL)
apt install -y certbot python3-certbot-nginx
echo "Certbot installed"

# 8. Create app directory
mkdir -p /var/www/flowdex-backend
chown -R $USER:$USER /var/www/flowdex-backend
echo "Directory created"

# 9. Clone/copy your code to /var/www/flowdex-backend/
# Copy all files from this repo into this folder

# 10. Install dependencies
cd /var/www/flowdex-backend
npm install

# 11. Setup database tables
npm run db:setup
npm run db:seed

# 12. Start with PM2
pm2 start src/server.js --name flowdex-backend
pm2 save
pm2 startup

echo "═══ Deployment complete ═══"
echo "Next: Configure Nginx (see nginx/flowdex-api.conf)"
echo "Next: Setup SSL (see ssl-setup.sh)"
echo "Next: Setup backups (see backup.sh)"
