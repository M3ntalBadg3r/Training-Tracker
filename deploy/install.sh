#!/bin/bash
set -e

# Training Tracker - Installation Script for Debian-based systems
# Run as root or with sudo

APP_DIR="/opt/training-tracker"
APP_USER="tracker"
DB_NAME="training_tracker"
DB_USER="tracker"
DB_PASS="tracker123"

echo "=== Training Tracker - Installation ==="

# 1. Update system
echo "[1/10] Updating system packages..."
apt-get update -qq

# 2. Install Node.js 22 LTS
echo "[2/10] Installing Node.js 22 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

# 3. Install PostgreSQL
echo "[3/10] Installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
    apt-get install -y postgresql postgresql-contrib
fi
systemctl enable postgresql
systemctl start postgresql

# 4. Create database and user
echo "[4/10] Setting up database..."
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};" 2>/dev/null || echo "Database already exists"
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';" 2>/dev/null || echo "User already exists"
sudo -u postgres psql -c "ALTER USER ${DB_USER} CREATEDB;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
sudo -u postgres psql -c "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};"
sudo -u postgres psql -d ${DB_NAME} -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"

# 5. Create app user
echo "[5/10] Creating application user..."
if ! id -u ${APP_USER} &>/dev/null; then
    useradd -r -m -s /bin/bash ${APP_USER}
fi

# 6. Clone/copy application
echo "[6/10] Setting up application directory..."
if [ ! -d "${APP_DIR}" ]; then
    mkdir -p ${APP_DIR}
fi

# If running from repo, copy files
if [ -f "$(dirname "$0")/../package.json" ]; then
    echo "Copying application files..."
    cp -r "$(dirname "$0")/../"* ${APP_DIR}/
    cp "$(dirname "$0")/../".* ${APP_DIR}/ 2>/dev/null || true
fi

chown -R ${APP_USER}:${APP_USER} ${APP_DIR}

# 7. Configure environment
echo "[7/10] Configuring environment..."
if [ ! -f "${APP_DIR}/.env" ]; then
    cat > ${APP_DIR}/.env << EOF
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
EOF
fi
chown ${APP_USER}:${APP_USER} ${APP_DIR}/.env
chmod 600 ${APP_DIR}/.env

# 8. Install dependencies and build
echo "[8/10] Installing dependencies and building..."
cd ${APP_DIR}
sudo -u ${APP_USER} npm install
sudo -u ${APP_USER} npx prisma migrate deploy
sudo -u ${APP_USER} npx prisma generate
sudo -u ${APP_USER} npm run build

# 9. Install systemd service
echo "[9/10] Installing systemd service..."
cp ${APP_DIR}/deploy/training-tracker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable training-tracker

# 10. Start the service
echo "[10/10] Starting Training Tracker..."
systemctl start training-tracker

echo ""
echo "=== Installation Complete ==="
echo "Training Tracker is now running on http://localhost:3000"
echo "To check status: systemctl status training-tracker"
echo "To view logs: journalctl -u training-tracker -f"
