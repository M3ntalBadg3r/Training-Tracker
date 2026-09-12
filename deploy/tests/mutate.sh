#!/bin/bash
# Mutation check: prove the fixtures can actually fail.
#
#   bash deploy/tests/mutate.sh     (as root)
#   npm run test:deploy:mutate
#
# A fixture that cannot detect a regression is decoration, and a suite of them
# is worse than decoration because it reports green. This script breaks
# deploy/lib/common.sh on purpose, one property at a time, in a COPY of the
# tree, and requires the named suite to go red. A mutation the suite does not
# notice is reported as a gap — that is the finding, not the pass.
#
# It never touches the real deploy/ directory: everything happens in a scratch
# copy that is removed on exit.
#
# To add a mutation, add a line to MUTATIONS below:
#     <suite-file>|<description>|<sed expression>
# The sed must actually change the file — a typo that matched nothing would
# otherwise "prove" the property was tested when nothing was broken at all, so
# a no-op edit is an error here, not a skip.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${HERE}/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: mutate.sh must run as root (it drives the same fixtures as run.sh)." >&2
    exit 2
fi

if [ -t 1 ]; then
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_OFF=$'\033[0m'
else
    C_RED=""; C_GREEN=""; C_OFF=""
fi

# suite|description|sed expression
MUTATIONS=(
# --- ensure_state_file -------------------------------------------------------
"test-ensure-state-file.sh|drop the link count from the stat that makes the decision|s/%F|%U:%G|%a|%h/%F|%U:%G|%a/"
"test-ensure-state-file.sh|replace a plain file instead of repairing it in place|s|# A plain file. Repair it IN PLACE|rm -f -- \"\${f}\"; : > \"\${f}\"; # |"
"test-ensure-state-file.sh|stop replacing non-plain files (leave a symlink or FIFO in place)|s|^            rm -f -- \"\${f}\" 2>/dev/null .*|            :|"
"test-ensure-state-file.sh|establish the files 0644 instead of 0664|s/set_file_mode_nofollow \"\${f}\" 0664/set_file_mode_nofollow \"\${f}\" 0644/"
"test-ensure-state-file.sh|give the state files to the service user instead of root|s/chown -h \"root:\${SVC_GROUP}\" -- \"\${f}\"/chown -h \"\${SVC_USER}:\${SVC_GROUP}\" -- \"\${f}\"/g"
# --- the nofollow primitives -------------------------------------------------
"test-nofollow-primitives.sh|drop O_NOFOLLOW, so a planted symlink is followed|s/fs.constants.O_NOFOLLOW | //g"
"test-nofollow-primitives.sh|drop O_NONBLOCK, so a FIFO at the name hangs a root process|s/ | fs.constants.O_NONBLOCK//g"
"test-nofollow-primitives.sh|drop the nlink guard, so a hardlink is modified through|s/|| st.nlink !== 1//"
"test-nofollow-primitives.sh|ignore the size cap when reading|s/Math.min(st.size, max)/st.size/"
"test-nofollow-primitives.sh|stop checking that the descriptor is a plain file|s/if (!st.isFile()) { fs.closeSync(fd); process.exit(1); }//"
# --- load_env_allowlist ------------------------------------------------------
"test-load-env-allowlist.sh|drop the allow-list, importing every key from .env|s/            \\*) continue ;;/            *) : ;;/"
"test-load-env-allowlist.sh|evaluate values instead of assigning them|s|printf -v \"\${key}\" '%s' \"\${value}\"|eval \"\${key}=\${value}\"|"
"test-load-env-allowlist.sh|strip quotes before the trailing CR instead of after|s/value=\"\${value%\$'\\\\r'}\"//"
"test-load-env-allowlist.sh|unset DATABASE_URL on rejection instead of warning|s|echo \"WARNING: DATABASE_URL in \${APP_DIR}/.env does not look like a postgres:// connection string. Using it anyway.\" >\&2|unset DATABASE_URL|"
"test-load-env-allowlist.sh|keep an untrustworthy CA bundle instead of dropping it|s/^            unset NODE_EXTRA_CA_CERTS/            :/"
# --- ensure_ownership --------------------------------------------------------
"test-ensure-ownership.sh|drop the sticky bit from APP_DIR|s/    chmod 1775 \"\${APP_DIR}\"/    chmod 0775 \"\${APP_DIR}\"/"
"test-ensure-ownership.sh|stop re-locking deploy/, .git and .update-backup to root|s/        chown -Rh root:root -- \"\${APP_DIR}\/\${locked}\"/        :/"
"test-ensure-ownership.sh|leave deploy/ group-writable|s/        chmod -R go-w \"\${APP_DIR}\/\${locked}\"/        :/"
"test-ensure-ownership.sh|make .env 0664 instead of 0660|s/                chmod 0660 \"\${APP_DIR}\/.env\"/                chmod 0664 \"\${APP_DIR}\/.env\"/"
"test-ensure-ownership.sh|drop the symlink guard on the .env chown\/chmod|s/            if \[ -e \"\${APP_DIR}\/.env\" \] \&\& \[ ! -L \"\${APP_DIR}\/.env\" \]; then/            if [ -e \"\${APP_DIR}\/.env\" ]; then/"
"test-ensure-ownership.sh|delete an operator's root-owned .env symlink too|s/       \[ \"\$(stat -c '%U' \"\${APP_DIR}\/.env\" 2>\/dev\/null || echo root)\" = \"\${SVC_USER}\" \]; then/       true; then/"
)

total=0; undetected=0
UNDETECTED_LIST=()

for entry in "${MUTATIONS[@]}"; do
    suite="${entry%%|*}"; rest="${entry#*|}"
    desc="${rest%%|*}"; expr="${rest#*|}"
    total=$((total + 1))

    work="$(mktemp -d)"
    cp -a "${DEPLOY_DIR}" "${work}/deploy"

    if ! sed -i "${expr}" "${work}/deploy/lib/common.sh"; then
        echo "${C_RED}ERROR${C_OFF}  sed failed for: ${desc}" >&2
        rm -rf "${work}"; exit 2
    fi

    # A mutation that changed nothing proves nothing. Treat it as a broken
    # mutation definition rather than as a passing check.
    if cmp -s "${DEPLOY_DIR}/lib/common.sh" "${work}/deploy/lib/common.sh"; then
        echo "${C_RED}ERROR${C_OFF}  mutation matched nothing (the sed is stale): ${desc}" >&2
        echo "       expression: ${expr}" >&2
        rm -rf "${work}"; exit 2
    fi

    # The mutated library must still parse; a syntax error would fail the suite
    # for a reason that has nothing to do with the property under test.
    if ! bash -n "${work}/deploy/lib/common.sh" 2>/dev/null; then
        echo "${C_RED}ERROR${C_OFF}  mutation produced invalid bash: ${desc}" >&2
        rm -rf "${work}"; exit 2
    fi

    appdir="${work}/app"; mkdir -p "${appdir}"
    grp="ttmut-grp-$$"; usr="ttmut-svc-$$"
    groupadd "${grp}" 2>/dev/null || true
    useradd -M -N -g "${grp}" -s /usr/sbin/nologin "${usr}" 2>/dev/null || true

    if TEST_APP_DIR="${appdir}" TEST_SVC_USER="${usr}" TEST_SVC_GROUP="${grp}" \
        timeout 120 bash "${work}/deploy/tests/${suite}" >/dev/null 2>&1; then
        printf '%sNOT DETECTED%s  %s\n' "${C_RED}" "${C_OFF}" "${desc}"
        undetected=$((undetected + 1))
        UNDETECTED_LIST+=("${suite}: ${desc}")
    else
        printf '%scaught%s        %s\n' "${C_GREEN}" "${C_OFF}" "${desc}"
    fi

    rm -rf "${appdir}" 2>/dev/null || true
    userdel "${usr}" 2>/dev/null || true
    groupdel "${grp}" 2>/dev/null || true
    rm -rf "${work}"
done

echo
echo "Mutations: ${total}, undetected: ${undetected}"
if [ "${undetected}" -ne 0 ]; then
    echo
    echo "These breakages would ship unnoticed:"
    for u in "${UNDETECTED_LIST[@]}"; do echo "  - ${u}"; done
    exit 1
fi
echo "Every mutation was caught: the fixtures have teeth."
