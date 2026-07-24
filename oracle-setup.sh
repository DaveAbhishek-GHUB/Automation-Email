#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  TitanMail — Oracle Cloud VPS Auto-Setup Script
#  Run this on a fresh Oracle Cloud Ubuntu VM:
#
#  curl -fsSL https://raw.githubusercontent.com/DaveAbhishek-GHUB/Automation-Email/main/oracle-setup.sh | bash
#
# ═══════════════════════════════════════════════════════════════════════════════

set -e
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   TitanMail — Oracle Cloud VPS Setup                    ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "📦 Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# ── 2. Install Node.js 20 ─────────────────────────────────────────────────────
echo "⬇️  Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "✅ Node.js version: $(node -v)"
echo "✅ npm version: $(npm -v)"

# ── 3. Install Git ────────────────────────────────────────────────────────────
echo "⬇️  Installing Git..."
sudo apt-get install -y git

# ── 4. Install PM2 (keeps app running forever) ────────────────────────────────
echo "⬇️  Installing PM2..."
sudo npm install -g pm2

# ── 5. Clone the repository ───────────────────────────────────────────────────
echo "📥 Cloning TitanMail repository..."
cd ~
if [ -d "Automation-Email" ]; then
  echo "   Repo already exists, pulling latest..."
  cd Automation-Email
  git pull origin main
else
  git clone https://github.com/DaveAbhishek-GHUB/Automation-Email.git
  cd Automation-Email
fi

# ── 6. Install Node dependencies ──────────────────────────────────────────────
echo "📦 Installing npm packages..."
npm install --production

# ── 7. Create data & uploads directories ─────────────────────────────────────
mkdir -p data uploads logs

# ── 8. Create .env file ───────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo "⚙️  Creating .env file..."
  cat > .env << 'EOF'
# ── SMTP (GoDaddy) ──────────────────────────────────────────────────────────
SMTP_HOST=smtpout.secureserver.net
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=info@varadatech.com
SMTP_PASS=Aadhyashakti123@
FROM_NAME=VaradaTech
FROM_EMAIL=info@varadatech.com

# ── App Config ───────────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=production
DB_PATH=/home/ubuntu/Automation-Email/data/database.sqlite

# ── Public URL (fill this after you get your Oracle IP) ──────────────────────
APP_URL=http://YOUR_ORACLE_PUBLIC_IP:3000
EOF
  echo "   ✅ .env file created"
else
  echo "   ℹ️  .env already exists, skipping"
fi

# ── 9. Start with PM2 ─────────────────────────────────────────────────────────
echo "🚀 Starting TitanMail with PM2..."
pm2 delete titanmail 2>/dev/null || true
pm2 start server/index.js --name titanmail --env production

# ── 10. Save PM2 config (auto-restart on server reboot) ──────────────────────
echo "💾 Saving PM2 startup config..."
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null || \
  sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME

# ── 11. Open firewall port 3000 ───────────────────────────────────────────────
echo "🔓 Opening firewall port 3000..."
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

# ── Done ──────────────────────────────────────────────────────────────────────
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "YOUR_IP")

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅  TitanMail is RUNNING on Oracle Cloud!                  ║"
echo "║                                                              ║"
echo "║  🌐  http://${PUBLIC_IP}:3000                               ║"
echo "║                                                              ║"
echo "║  Next steps:                                                 ║"
echo "║  1. Open Oracle firewall for port 3000 (see guide)          ║"
echo "║  2. Open the URL above in your browser                      ║"
echo "║  3. Go to Settings → Test Connection                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  pm2 status          → check if app is running"
echo "  pm2 logs titanmail  → view live logs"
echo "  pm2 restart titanmail → restart the app"
