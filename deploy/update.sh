#!/bin/bash
set -e

# Training Tracker - Update Script
# Run as root or with sudo

APP_DIR="/opt/training-tracker"
APP_USER="tracker"

echo "=== Training Tracker - Updating ==="

cd ${APP_DIR}

# Check for updates
echo "[1/5] Pulling latest changes..."
sudo -u ${APP_USER} git pull origin main || {
    echo "Git pull failed. If running from a non-git directory, copy files manually."
    exit 1
}

# Install any new dependencies
echo "[2/5] Installing dependencies..."
sudo -u ${APP_USER} npm install

# Run database migrations
echo "[3/5] Running database migrations..."
sudo -u ${APP_USER} npx prisma migrate deploy
sudo -u ${APP_USER} npx prisma generate

# Rebuild the application
echo "[4/5] Building application..."
sudo -u ${APP_USER} npm run build

# Restart the service
echo "[5/5] Restarting service..."
systemctl restart training-tracker

echo ""
echo "=== Update Complete ==="
echo "Training Tracker has been updated and restarted."
echo "To check status: systemctl status training-tracker"
