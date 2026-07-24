#!/bin/bash

# TitanMail Marketing Tool — Start/Restart Script
# Run this anytime you need to start or restart the server:
#   bash start.sh

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║    📧  TitanMail Marketing Tool                      ║"
echo "╚══════════════════════════════════════════════════════╝"

# Check if pm2 is installed
if command -v pm2 &> /dev/null; then
  echo ""
  echo "🔄  Restarting with PM2 (stays alive permanently)..."
  pm2 restart titanmail 2>/dev/null || pm2 start server/index.js --name titanmail
  pm2 save
  echo ""
  echo "✅  Server running at http://localhost:3000"
  echo "📊  Monitor: pm2 logs titanmail"
else
  echo ""
  echo "⚠️  PM2 not found — installing..."
  npm install -g pm2
  pm2 start server/index.js --name titanmail
  pm2 save
  echo "✅  Server running at http://localhost:3000"
fi

# Open browser
sleep 1
open http://localhost:3000
