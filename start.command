#!/bin/bash
cd "$(dirname "$0")"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  # Rebuild native modules for this platform
  echo "Building native modules..."
  npm rebuild node-pty
fi

# Ensure native modules match this platform
if ! node -e "require('node-pty').spawn('/bin/bash',['-c','exit'],{name:'xterm-256color',cols:80,rows:24,cwd:'$HOME',env:process.env}).kill()" 2>/dev/null; then
  echo "Rebuilding native modules for this platform..."
  npm rebuild node-pty
  # If still fails, reinstall from scratch
  if ! node -e "require('node-pty').spawn('/bin/bash',['-c','exit'],{name:'xterm-256color',cols:80,rows:24,cwd:'$HOME',env:process.env}).kill()" 2>/dev/null; then
    echo "Reinstalling node-pty..."
    npm uninstall node-pty && npm install node-pty
  fi
fi

# Build if needed
if [ ! -d "dist" ]; then
  echo "Building..."
  npm run build
fi

echo ""
echo "  Ibis Hub starting..."
echo "  http://localhost:9100"
echo ""

# Open browser after a short delay
(sleep 2 && open "http://localhost:9100") &

# Start server
node server.mjs
