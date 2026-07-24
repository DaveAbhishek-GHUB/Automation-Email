#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  TitanMail Public Launcher
#  Starts the app server + opens it publicly via your permanent ngrok URL.
#
#  Your permanent public URL (never changes):
#  https://overdress-courier-maroon.ngrok-free.dev
#
#  Usage:  bash start-public.sh
# ─────────────────────────────────────────────────────────────────────────────

PUBLIC_URL="https://overdress-courier-maroon.ngrok-free.dev"

cd "$(dirname "$0")"
mkdir -p logs

# Kill old instances cleanly
echo "⏹  Stopping any old instances..."
pkill -f "node server/index.js" 2>/dev/null
pkill -f "ngrok" 2>/dev/null
sleep 1

# Start Node.js server
echo "🚀 Starting TitanMail server..."
nohup node server/index.js > logs/server.log 2>&1 &
SERVER_PID=$!
echo "   Server PID: $SERVER_PID"
sleep 2

# Verify server started
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
  echo "❌ Server failed to start. Check logs/server.log"
  exit 1
fi
echo "   ✅ Server is running on localhost:3000"

# Start ngrok with permanent static domain
echo "🌐 Opening public tunnel..."
nohup ngrok http --domain=overdress-courier-maroon.ngrok-free.dev 3000 > logs/ngrok.log 2>&1 &
NGROK_PID=$!
sleep 3

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅  TitanMail is LIVE and accessible worldwide!            ║"
echo "║                                                              ║"
echo "║  🌐  $PUBLIC_URL  ║"
echo "║                                                              ║"
echo "║  📧  Go to Settings and paste this as your Public App URL   ║"
echo "║      so Gmail tracking works correctly.                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "📋 Logs:"
echo "   Server → logs/server.log"
echo "   Ngrok  → logs/ngrok.log"
echo ""
echo "Press Ctrl+C to stop everything."
echo ""

# Keep script alive — stop both processes when Ctrl+C is pressed
trap "echo ''; echo 'Stopping...'; kill $SERVER_PID $NGROK_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID
