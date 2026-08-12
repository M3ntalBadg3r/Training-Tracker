#!/bin/bash

# Training Tracker - Installation Script for Debian-based LXC containers or VMs
#
# Installing needs root: on an LXC you are usually root already, on a VM you
# normally log in as a regular user and the script re-execs under sudo. The
# installed *application* does not run as root — it runs as an unprivileged
# service account and reaches privileged work through the root-owned update
# helper. See deploy/lib/common.sh for why there is no sudoers rule anywhere.

set -e

APP_DIR="/opt/training-tracker"
DB_NAME="training_tracker"
DB_USER="tracker"

SCRIPT_DIR_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR_SELF}/lib/common.sh"

require_root "$@"

# Fail loudly and completely on a missing dependency rather than discovering it
# half way through — or worse, at first use in production.
check_dependencies

# With `set -e`, an abort between creating the service account and installing the
# helper units leaves a host that looks installed but cannot update, with nothing
# on screen explaining why. Say so.
trap 'echo "" >&2; echo "ERROR: install failed at line ${LINENO}. The service account and update helper may be only partly installed — fix the cause above and re-run this script (it is safe to re-run)." >&2' ERR

# CA bundle that Node should trust in addition to its built-ins. On Debian this
# file is maintained by `update-ca-certificates`, so it already includes any
# corporate/firewall root certs the admin imported — which is what lets Prisma's
# Node-based engine downloader (and the running app) work behind an
# SSL-inspecting proxy. Node ignores the system store unless pointed at it.
CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"

# Generate a random secret/password (32 bytes -> 64 hex chars).
generate_secret() {
    openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
}

echo "=== Training Tracker - Installation ==="

# 1. Update system
echo "[1/10] Updating system packages..."
apt-get update -qq

# 2. Install Node.js 22 LTS
echo "[2/10] Installing Node.js 22 LTS..."
apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Ensure node/npm are on PATH
export PATH="/usr/bin:/usr/local/bin:$PATH"
hash -r
if ! command -v npm &> /dev/null; then
    echo "npm still not found, installing npm separately..."
    apt-get install -y npm
fi
echo "Using Node $(node --version), npm $(npm --version)"

# 3. Install PostgreSQL
echo "[3/10] Installing PostgreSQL..."
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
echo "[4/10] Setting up database..."

# Decide the database password before creating the role. On a re-run where .env
# already has a DATABASE_URL, keep the existing credentials (CREATE USER no-ops
# below and step 6 won't rewrite DATABASE_URL). On a fresh install, generate a
# strong random password and surface it at the end.
if [ -f "${APP_DIR}/.env" ] && grep -q '^DATABASE_URL=' "${APP_DIR}/.env"; then
    REUSE_DB_CREDS=true
else
    REUSE_DB_CREDS=false
fi
DB_PASS="$(generate_secret)"

su - postgres -c "psql -c \"CREATE DATABASE ${DB_NAME};\"" 2>/dev/null || echo "Database already exists"
su - postgres -c "psql -c \"CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';\"" 2>/dev/null || echo "User already exists"
su - postgres -c "psql -c \"ALTER USER ${DB_USER} CREATEDB;\""
su - postgres -c "psql -c \"GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};\""
su - postgres -c "psql -c \"ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};\""
su - postgres -c "psql -d ${DB_NAME} -c \"GRANT ALL ON SCHEMA public TO ${DB_USER};\""

# 5. Set up application directory
echo "[5/10] Setting up application directory..."
ensure_service_user
ensure_log_dir
ensure_cron_allow
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Determine if we're already running from APP_DIR or need to copy
if [ "$(realpath "${SCRIPT_DIR}")" = "$(realpath "${APP_DIR}" 2>/dev/null)" ]; then
    echo "Already running from ${APP_DIR}, skipping copy."
else
    mkdir -p ${APP_DIR}
    # Installing from somewhere else over an existing install: the tree belongs
    # to the service user, and root cannot overwrite files it does not own here.
    # Take it back first; step 7's ensure_ownership hands it over again.
    if id -u "${SVC_USER}" >/dev/null 2>&1; then
        chown -R root:root "${APP_DIR}" 2>/dev/null || true
    fi
    if [ -f "${SCRIPT_DIR}/package.json" ]; then
        echo "Copying application files..."
        cp -r "${SCRIPT_DIR}/"* ${APP_DIR}/
        cp "${SCRIPT_DIR}/".[!.]* ${APP_DIR}/ 2>/dev/null || true
    fi
fi

# 6. Configure environment
echo "[6/10] Configuring environment..."

# URL-encode a password so special characters (#$&@etc.) don't break the connection string
url_encode_password() {
    node -e "console.log(encodeURIComponent(process.argv[1]))" "$1"
}

# Read a line from the controlling terminal when one is attached. Under a piped
# install (curl ... | sudo bash) stdin is the script, so we read /dev/tty
# directly; with no terminal we return empty and the caller skips the prompt.
prompt_tty() {
    local _ans=""
    if ( : </dev/tty ) 2>/dev/null; then
        read -r -p "$1" _ans </dev/tty || _ans=""
    fi
    printf '%s' "${_ans}"
}

ENV_FILE="${APP_DIR}/.env"

# Does the .env already define KEY?
env_has() {
    [ -f "${ENV_FILE}" ] && grep -q "^$1=" "${ENV_FILE}"
}

# Optional site configuration — prompt only when not already set via an env var
# or an existing .env. Env-var overrides (e.g. APP_BASE_URL=... bash install.sh)
# win and skip the prompt; a non-interactive install simply leaves them unset.
if [ -z "${APP_BASE_URL}" ] && ! env_has APP_BASE_URL; then
    APP_BASE_URL="$(prompt_tty "Domain name / public URL for the site (e.g. https://tracker.example.com), or leave blank to skip: ")"
fi
if [ -z "${TRUSTED_PROXIES}" ] && ! env_has TRUSTED_PROXIES; then
    _rp="$(prompt_tty "Are you running behind a reverse proxy? [y/N]: ")"
    case "${_rp}" in
        [Yy]*)
            _ips="$(prompt_tty "Reverse proxy IP(s), comma-separated [127.0.0.1,::1]: ")"
            TRUSTED_PROXIES="${_ips:-127.0.0.1,::1}"
            ;;
    esac
fi

DB_PASS_ENCODED=$(url_encode_password "${DB_PASS}")

if [ ! -f "${ENV_FILE}" ]; then
    cat > "${ENV_FILE}" << EOF
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS_ENCODED}@localhost:5432/${DB_NAME}"
JWT_SECRET="$(generate_secret)"
ENCRYPTION_KEY="$(generate_secret)"
CRON_SECRET="$(generate_secret)"
EOF
    [ -f "${CA_BUNDLE}" ] && echo "NODE_EXTRA_CA_CERTS=\"${CA_BUNDLE}\"" >> "${ENV_FILE}"
    [ -n "${APP_BASE_URL}" ] && echo "APP_BASE_URL=\"${APP_BASE_URL}\"" >> "${ENV_FILE}"
    [ -n "${TRUSTED_PROXIES}" ] && echo "TRUSTED_PROXIES=\"${TRUSTED_PROXIES}\"" >> "${ENV_FILE}"
else
    # Append any keys missing from an existing .env (idempotent re-run).
    env_has DATABASE_URL   || { echo "DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS_ENCODED}@localhost:5432/${DB_NAME}\"" >> "${ENV_FILE}"; echo "Added DATABASE_URL to existing .env"; }
    env_has JWT_SECRET     || { echo "JWT_SECRET=\"$(generate_secret)\"" >> "${ENV_FILE}"; echo "Added JWT_SECRET to existing .env"; }
    env_has ENCRYPTION_KEY || { echo "ENCRYPTION_KEY=\"$(generate_secret)\"" >> "${ENV_FILE}"; echo "Added ENCRYPTION_KEY to existing .env"; }
    env_has CRON_SECRET    || { echo "CRON_SECRET=\"$(generate_secret)\"" >> "${ENV_FILE}"; echo "Added CRON_SECRET to existing .env"; }
    if [ -f "${CA_BUNDLE}" ] && ! env_has NODE_EXTRA_CA_CERTS; then
        echo "NODE_EXTRA_CA_CERTS=\"${CA_BUNDLE}\"" >> "${ENV_FILE}"; echo "Added NODE_EXTRA_CA_CERTS to existing .env"
    fi
    if [ -n "${APP_BASE_URL}" ] && ! env_has APP_BASE_URL; then
        echo "APP_BASE_URL=\"${APP_BASE_URL}\"" >> "${ENV_FILE}"; echo "Added APP_BASE_URL to existing .env"
    fi
    if [ -n "${TRUSTED_PROXIES}" ] && ! env_has TRUSTED_PROXIES; then
        echo "TRUSTED_PROXIES=\"${TRUSTED_PROXIES}\"" >> "${ENV_FILE}"; echo "Added TRUSTED_PROXIES to existing .env"
    fi
fi
# root:service-group 0660 rather than 0600 — see ensure_ownership in
# lib/common.sh. Both root and the app write this file.
if id -u "${SVC_USER}" >/dev/null 2>&1; then
    chown "root:${SVC_GROUP}" "${ENV_FILE}"
    chmod 0660 "${ENV_FILE}"
else
    chmod 600 "${ENV_FILE}"
fi

# Make Node trust the system CA bundle for the build below (install.sh does not
# source .env). This is what lets the Prisma engine download succeed behind an
# SSL-inspecting proxy; harmless otherwise, since it only adds trust.
[ -f "${CA_BUNDLE}" ] && export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-${CA_BUNDLE}}"

# 7. Install dependencies and build
echo "[7/10] Installing dependencies and building..."

# Everything so far ran as root, so the tree is root-owned. Hand it to the
# service account (which also locks deploy/ and .git back to root) before the
# build, so npm never runs a dependency's postinstall script with privilege.
ensure_ownership

cd ${APP_DIR}
run_as_service_user npm install
# Self-heal npm's optional-dependency bug (npm/cli#4828): a package-lock.json
# generated on another OS/arch can leave platform-native binaries uninstalled
# (e.g. lightningcss for Tailwind v4), breaking the build. If the native CSS
# engine can't load, regenerate the lockfile for this platform and reinstall.
if ! node -e "require('lightningcss')" >/dev/null 2>&1; then
    echo "Native CSS engine missing for this platform; reinstalling dependencies..."
    # node_modules belongs to the service user; root cannot delete inside a
    # directory it does not own on a container without CAP_DAC_OVERRIDE.
    run_as_service_user rm -rf node_modules package-lock.json
    run_as_service_user npm install
fi
run_as_service_user npx prisma migrate deploy
run_as_service_user npx prisma generate
run_as_service_user npm run build

# The build wrote .next; re-reconcile so nothing is left root-owned.
ensure_ownership

# 8. Install systemd service + the root-owned update helper
echo "[8/10] Installing systemd service..."
if command -v systemctl &> /dev/null; then
    # training-tracker.service (the app, unprivileged) plus
    # training-tracker-update.path/.service — the root side of the update
    # boundary, see deploy/update-agent.sh.
    install_units
    systemctl enable training-tracker
    # restart, not start: on a re-run (which is exactly how an existing install
    # migrates) the service is already up, and `start` is a no-op — so the newly
    # written unit would never take effect and the app would keep running as root.
    restart_app || echo "WARNING: could not restart the service — run 'systemctl restart training-tracker' manually." >&2
    echo "Started via systemd (running as ${SVC_USER})."
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
SVC_USER="training-tracker"
PIDFILE="/var/run/training-tracker.pid"
LOGFILE="/var/log/training-tracker/app.log"

case "$1" in
    start)
        echo "Starting Training Tracker..."
        cd $APP_DIR
        # Drop to the service account — this fallback must not run as root either.
        if command -v runuser >/dev/null 2>&1 && id -u "$SVC_USER" >/dev/null 2>&1; then
            runuser -u "$SVC_USER" -- env HOME="$APP_DIR" NODE_ENV=production PORT=3000 \
                npm start >> $LOGFILE 2>&1 &
        else
            NODE_ENV=production PORT=3000 npm start >> $LOGFILE 2>&1 &
        fi
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
    # restart, not start — see the systemd branch above.
    /etc/init.d/training-tracker restart
    echo "Started via init.d."
fi

# 9. Install the fixed cron entries
echo "[9/10] Installing scheduled jobs..."
if command -v crontab &> /dev/null || [ -d /etc/cron.d ]; then
    # Fixed entries, owned by root, so the app never edits a crontab it would
    # need privilege to write. auto-update.sh decides for itself whether an
    # update is due by reading .auto-update.json (which the app does own);
    # auto-export.sh runs every minute regardless and exits immediately when
    # nothing is scheduled. Defined once in lib/common.sh so an update applies
    # the same entries.
    ensure_cron_jobs
    echo "Installed /etc/cron.d/training-tracker"
else
    echo "cron not available — scheduled updates, exports and credential checks will not run."
fi

# 10. Done
echo ""
echo "=== Installation Complete ==="
echo "Training Tracker is now running on http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "  Configuration (stored in ${APP_DIR}/.env, permissions 600):"
if command -v systemctl &> /dev/null; then
    _EFFECTIVE_USER="$(systemctl show -p User --value training-tracker 2>/dev/null)"
    if [ "${_EFFECTIVE_USER}" = "${SVC_USER}" ]; then
        echo "    Runs as:         ${SVC_USER} (unprivileged; confirmed)"
    else
        echo "    Runs as:         ${_EFFECTIVE_USER:-root} — EXPECTED ${SVC_USER}!"
        echo "                     ^ run: systemctl restart training-tracker"
    fi
else
    echo "    Runs as:         ${SVC_USER} (unprivileged; not root)"
fi
echo "    Database:        ${DB_NAME} (user: ${DB_USER})"
if [ "${REUSE_DB_CREDS}" = false ]; then
    echo "    DB password:     ${DB_PASS}"
    echo "                     ^ save this somewhere safe (also in .env)"
else
    echo "    DB password:     unchanged (existing .env reused)"
fi
echo "    Secrets:         JWT_SECRET, ENCRYPTION_KEY, CRON_SECRET auto-generated"
[ -n "${APP_BASE_URL}" ]    && echo "    Public URL:      ${APP_BASE_URL}"
[ -n "${TRUSTED_PROXIES}" ] && echo "    Trusted proxies: ${TRUSTED_PROXIES}"
[ -f "${CA_BUNDLE}" ]       && echo "    Node CA bundle:  ${CA_BUNDLE}"
echo ""
echo "  Next: open the URL above and complete the first-run setup wizard to"
echo "  create your administrator account."
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
