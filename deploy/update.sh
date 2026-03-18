#!/bin/bash
set -e

# Training Tracker - Update Script for LXC containers
# Run as root

APP_DIR="/opt/training-tracker"

echo "=== Training Tracker - Updating ==="

cd ${APP_DIR}

# Pull latest changes
echo "[1/5] Pulling latest changes..."
git pull origin main || {
    echo "Git pull failed. If running from a non-git directory, copy files manually."
    exit 1
}

# Install any new dependencies
echo "[2/5] Installing dependencies..."
npm install

# Run database migrations
echo "[3/5] Running database migrations..."
npx prisma migrate deploy
npx prisma generate

# Rebuild the application
echo "[4/5] Building application..."
npm run build

# Restart the service
echo "[5/5] Restarting service..."
if command -v systemctl &> /dev/null; then
    systemctl restart training-tracker
elif [ -f /etc/init.d/training-tracker ]; then
    /etc/init.d/training-tracker restart
else
    echo "No service manager found. Restart manually:"
    echo "  cd ${APP_DIR} && NODE_ENV=production npm start"
fi

echo ""
echo "=== Update Complete ==="
echo "Training Tracker has been updated and restarted."
