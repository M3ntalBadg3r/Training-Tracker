#!/bin/bash
set -e

# Training Tracker - Installation Script for Debian-based LXC containers
# Run as root (LXC containers typically run as root directly)

APP_DIR="/opt/training-tracker"
DB_NAME="training_tracker"
DB_USER="tracker"
DB_PASS="tracker123"

echo "=== Training Tracker - Installation ==="

# 1. Update system
echo "[1/9] Updating system packages..."
apt-get update -qq

# 2. Install Node.js 22 LTS
echo "[2/9] Installing Node.js 22 LTS..."
if ! command -v node &> /dev/null; then
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

# 3. Install PostgreSQL
echo "[3/9] Installing PostgreSQL..."
if ! command -v psql &> /dev/null; then
    apt-get install -y postgresql postgresql-contrib
fi

# Start PostgreSQL - try systemctl first, fall back to pg_ctlcluster / service
if command -v systemctl &> /dev/null && systemctl list-units --type=service | grep -q postgresql; then
    systemctl enable postgresql
    systemctl start postgresql
else
    pg_ctlcluster $(pg_lsclusters -h | head -1 | awk '{print $1, $2}') start 2>/dev/null || \
    service postgresql start 2>/dev/null || \
    pg_lsclusters  # show status if nothing works
fi

# Wait for PostgreSQL to be ready
for i in $(seq 1 10); do
    pg_isready -q && break
    echo "Waiting for PostgreSQL..."
    sleep 1
done

# 4. Create database and user
echo "[4/9] Setting up database..."
su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME};\"" 2>/dev/null || echo "Database already exists"
su - postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';\"" 2>/dev/null || echo "User already exists"
su - postgres -c "psql -c \"ALTER USER ${DB_USER} CREATEDB;\""
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\""
su - postgres -c "psql -c \"ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};\""
su - postgres -c "psql -d ${DB_NAME} -c \"GRANT ALL ON SCHEMA public TO ${DB_USER};\""

# 5. Set up application directory
echo "[5/9] Setting up application directory..."
if [ ! -d "${APP_DIR}" ]; then
    mkdir -p ${APP_DIR}
fi

# If running from the repo, copy files
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "${SCRIPT_DIR}/package.json" ]; then
    echo "Copying application files..."
    cp -r "${SCRIPT_DIR}/"* ${APP_DIR}/
    cp "${SCRIPT_DIR}/".[!.]* ${APP_DIR}/ 2>/dev/null || true
fi

# 6. Configure environment
echo "[6/9] Configuring environment..."
if [ ! -f "${APP_DIR}/.env" ]; then
    cat > ${APP_DIR}/.env << EOF
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}"
EOF
fi
chmod 600 ${APP_DIR}/.env

# 7. Install dependencies and build
echo "[7/9] Installing dependencies and building..."
cd ${APP_DIR}
npm install
npx prisma migrate deploy
npx prisma generate
npm run build

# 8. Install systemd service
echo "[8/9] Installing systemd service..."
if command -v systemctl &> /dev/null; then
    cp ${APP_DIR}/deploy/training-tracker.service /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable training-tracker
    systemctl start training-tracker
    echo "Started via systemd."
else
    echo "systemd not available. Starting manually..."
    echo "You can start the app with: cd ${APP_DIR} && NODE_ENV=production npm start"
    # Create a simple init script as fallback
    cat > /etc/init.d/training-tracker << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          training-tracker
# Required-Start:    $local_fs $network postgresql
# Required-Stop:     $local_fs $network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Description:       Training Tracker Next.js Application
### END INIT INFO

APP_DIR="/opt/training-tracker"
PIDFILE="/var/run/training-tracker.pid"
LOGFILE="/var/log/training-tracker.log"

case "$1" in
    start)
        echo "Starting Training Tracker..."
        cd $APP_DIR
        NODE_ENV=production PORT=3000 npm start >> $LOGFILE 2>&1 &
        echo $! > $PIDFILE
        echo "Started (PID: $(cat $PIDFILE))"
        ;;
    stop)
        if [ -f $PIDFILE ]; then
            echo "Stopping Training Tracker..."
            kill $(cat $PIDFILE) 2>/dev/null
            rm -f $PIDFILE
        fi
        ;;
    restart)
        $0 stop
        sleep 2
        $0 start
        ;;
    status)
        if [ -f $PIDFILE ] && kill -0 $(cat $PIDFILE) 2>/dev/null; then
            echo "Running (PID: $(cat $PIDFILE))"
        else
            echo "Not running"
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
INITEOF
    chmod +x /etc/init.d/training-tracker
    update-rc.d training-tracker defaults 2>/dev/null || true
    /etc/init.d/training-tracker start
    echo "Started via init.d."
fi

# 9. Done
echo ""
echo "=== Installation Complete ==="
echo "Training Tracker is now running on http://$(hostname -I | awk '{print $1}'):3000"
echo ""
if command -v systemctl &> /dev/null; then
    echo "Commands:"
    echo "  Status:  systemctl status training-tracker"
    echo "  Logs:    journalctl -u training-tracker -f"
    echo "  Restart: systemctl restart training-tracker"
else
    echo "Commands:"
    echo "  Status:  /etc/init.d/training-tracker status"
    echo "  Logs:    tail -f /var/log/training-tracker.log"
    echo "  Restart: /etc/init.d/training-tracker restart"
fi
