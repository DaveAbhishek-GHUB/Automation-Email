#!/bin/bash
# TitanMail — Start Cloudflare Tunnel
# Run this script to expose your local app to the internet via Cloudflare
# Usage: bash start-tunnel.sh

echo "🚀 Starting TitanMail + Cloudflare Tunnel..."

# Make sure the app is running via PM2
pm2 start server/index.js --name titanmail 2>/dev/null || pm2 restart titanmail
pm2 save

echo "✅ App running via PM2"
echo "🌐 Starting Cloudflare Tunnel on port 3000..."
echo ""
echo "The URL will appear below — copy it and paste into Settings → Public App URL"
echo "─────────────────────────────────────────────────"

# Start the tunnel (URL appears in output)
cloudflared tunnel --url http://localhost:3000
