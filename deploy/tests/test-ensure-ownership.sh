#!/bin/bash
# ensure_ownership — the carve-out list, which CLAUDE.md calls "the control".
#
# This is the function that decides which parts of the tree the unprivileged
# service account owns. Two classes of path are carved out of the sweep, for two
# different reasons:
#
#   deploy/ .git/ .update-backup/   root EXECUTES or RESTORES FROM these, so
#                                   they must never be service-user-owned at any
#                                   instant. The sweep used to hand them over
#                                   and take them back, and that was a route to
#                                   root: chown changes metadata, not content,
#                                   so bytes written during the window survived
#                                   the re-lock.
#
#   .env .update-status .update-log .auto-update-last-run
#                                   root WRITES these while the app reaches them
#                                   through the group, and the blocks that set
#                                   their ownership run AFTER the sweep — so
#                                   handing them over even transiently let the
#                                   account rename one aside and plant a symlink
#                                   for those later, path-following, chown/chmod
#                                   calls to retarget.
#
# Adding a path to that list is a security decision, not bookkeeping, so the
# list is asserted explicitly rather than inferred.
#
# See CLAUDE.md, "ensure_ownership SKIPS the root-owned paths".

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"
SVC_USER="${TEST_SVC_USER:?}"
SVC_GROUP="${TEST_SVC_GROUP:?}"

d="${APP_DIR}"

# Symlink targets live OUTSIDE APP_DIR on purpose. A target inside the tree is
# chowned by the sweep as an ordinary file, which looks identical to root having
# followed the link — so the fixture could not tell the two apart and would fail
# for the wrong reason.
VICTIMS="$(mktemp -d)"
trap 'rm -rf "${VICTIMS}"' EXIT

# A tree shaped like a real install, built in a state that is WRONG IN BOTH
# DIRECTIONS. That mixture is the whole point of this fixture and it is easy to
# get wrong — the first version of this file chowned everything to the service
# account, which made the precondition identical to the postcondition for the
# "ordinary tree contents are owned by the service user" assertion. Deleting the
# sweep's chown — the function's primary job — left the suite green.
#
# So, deliberately:
#
#   the carve-outs (deploy/, .git/, .update-backup/) start SERVICE-USER-owned
#   and group-writable, so the re-lock has to move them back to root and strip
#   the group bit;
#
#   everything else (src/, package.json, node_modules/) starts ROOT-owned, so
#   the sweep has to hand it over.
#
# Neither assertion can now pass by accident: each starts from the state the
# other one ends in.
build_tree() {
    rm -rf "${d:?}"/* "${d:?}"/.[!.]* 2>/dev/null || true
    mkdir -p "${d}/deploy/lib" "${d}/.git/refs" "${d}/.update-backup" "${d}/src" "${d}/node_modules/pkg"
    printf 'root runs this\n' > "${d}/deploy/perform-update.sh"
    printf 'root runs this too\n' > "${d}/deploy/lib/common.sh"
    : > "${d}/.git/config"
    : > "${d}/.update-backup/db-pre-update.sql"
    : > "${d}/src/app.ts"
    : > "${d}/package.json"
    : > "${d}/node_modules/pkg/index.js"
    : > "${d}/.env"

    # Ordinary tree: root-owned, so the sweep must hand it over.
    chown -R root:root "${d}"

    # Carve-outs: service-user-owned AND group-writable, so the re-lock must
    # take them back and `chmod -R go-w` must strip the bit. Starting them at
    # root:root 0644 would make both of those lines no-ops and the assertions
    # decoration.
    chown -R "${SVC_USER}:${SVC_GROUP}" "${d}/deploy" "${d}/.git" "${d}/.update-backup"
    chmod -R u+w,g+w "${d}/deploy" "${d}/.git" "${d}/.update-backup"

    # A recognisable, deliberately wrong mode on APP_DIR itself, so the
    # missing-account fixture below can tell "left alone" from "1775 applied".
    chmod 0700 "${d}"
}

owner_of() { stat -c '%U:%G' "$1" 2>/dev/null || echo missing; }
mode_of()  { stat -c '%a' "$1" 2>/dev/null || echo missing; }

build_tree
ensure_ownership >/dev/null 2>&1

# --- APP_DIR itself ----------------------------------------------------------
# The sticky bit is the thing: without it the service account could rename
# deploy/ aside and substitute the scripts root executes, however the contents
# were owned.
start_test "APP_DIR is root-owned, group-writable and STICKY (1775)"
assert_eq "root:${SVC_GROUP}|1775" "$(owner_of "${d}")|$(mode_of "${d}")" \
    "without the sticky bit the service account can replace root-owned entries by renaming them"

# --- the executed/restored-from carve-outs -----------------------------------
for locked in deploy .git .update-backup; do
    start_test "${locked}/ is root-owned after the sweep"
    assert_eq "root:root" "$(owner_of "${d}/${locked}")" \
        "root executes or restores from this path; the service account must never own it"
done

start_test "deploy/ contents are root-owned recursively"
assert_eq "root:root|root:root" \
    "$(owner_of "${d}/deploy/perform-update.sh")|$(owner_of "${d}/deploy/lib/common.sh")" \
    "an RCE in the app could rewrite the scripts root executes"

# `chmod -R go-w` is what enforces this, and it is the second half of the
# control: root-owned but group-writable would be no protection at all.
start_test "deploy/ is not group- or world-writable"
mode="$(mode_of "${d}/deploy/perform-update.sh")"
assert_eq "0" "$(( 8#${mode} & 8#22 ))" \
    "deploy/perform-update.sh is writable by group or other (mode ${mode}); root executes it"

start_test "deploy/ directory itself is not group- or world-writable"
dmode="$(mode_of "${d}/deploy")"
assert_eq "0" "$(( 8#${dmode} & 8#22 ))" \
    "write permission on the directory governs renaming its entries (mode ${dmode})"

start_test "the restore source .update-backup/ stays root-owned"
assert_eq "root:root" "$(owner_of "${d}/.update-backup/db-pre-update.sql")" \
    "the rollback would restore from a file the app controls"

# --- everything else genuinely IS handed over --------------------------------
# The carve-out must be a carve-out, not a refusal to do the job at all. These
# entries were built root-owned (see build_tree), so this can only pass if the
# sweep actually ran — which the first version of this fixture could not tell.
start_test "the fixture really does start root-owned (guards the assertion below)"
build_tree
assert_eq "root:root|root:root|root:root" \
    "$(owner_of "${d}/src/app.ts")|$(owner_of "${d}/package.json")|$(owner_of "${d}/node_modules/pkg/index.js")" \
    "build_tree no longer establishes the wrong starting state, so the next assertion would be vacuous"

ensure_ownership >/dev/null 2>&1

start_test "ordinary tree contents are handed to the service user"
assert_eq "${SVC_USER}:${SVC_GROUP}|${SVC_USER}:${SVC_GROUP}|${SVC_USER}:${SVC_GROUP}" \
    "$(owner_of "${d}/src/app.ts")|$(owner_of "${d}/package.json")|$(owner_of "${d}/node_modules/pkg/index.js")" \
    "the sweep did not hand the application tree to the service account"

start_test "the hand-over reaches nested contents, not just the top level"
assert_eq "${SVC_USER}:${SVC_GROUP}" "$(owner_of "${d}/node_modules/pkg/index.js")" \
    "the sweep is not recursive"

# --- the shared state files --------------------------------------------------
start_test ".env is root:group 0660"
assert_eq "root:${SVC_GROUP}|660" "$(owner_of "${d}/.env")|$(mode_of "${d}/.env")" \
    "root must own .env and reach the app through the group; 0660 keeps it as private as 0600 was"

start_test "the shared state files are created root:group 0664"
assert_eq "root:${SVC_GROUP} 664|root:${SVC_GROUP} 664|root:${SVC_GROUP} 664" \
    "$(stat -c '%U:%G %a' "${d}/.update-status")|$(stat -c '%U:%G %a' "${d}/.update-log")|$(stat -c '%U:%G %a' "${d}/.auto-update-last-run")" \
    "root writes these as owner and the app writes through the group; getting this wrong froze the update UI on step 0 in 2.70/2.71"

# --- the .env symlink rules --------------------------------------------------
# A symlink the SERVICE ACCOUNT owns is attacker-planted by construction — it is
# the only identity that could have created one — so it is removed.
start_test "a service-user-owned .env symlink is removed, not followed"
build_tree
rm -f "${d}/.env"
printf 'SENSITIVE\n' > "${VICTIMS}/symlink-victim"; chown root:root "${VICTIMS}/symlink-victim"; chmod 0600 "${VICTIMS}/symlink-victim"
ln -s "${VICTIMS}/symlink-victim" "${d}/.env"; chown -h "${SVC_USER}:${SVC_GROUP}" "${d}/.env"
ensure_ownership >/dev/null 2>&1
assert_eq "no" "$( [ -L "${d}/.env" ] && echo yes || echo no )" \
    "a planted .env symlink survived"

start_test "the planted symlink's victim is left untouched"
assert_eq "SENSITIVE|root:root|600" \
    "$(cat "${VICTIMS}/symlink-victim")|$(owner_of "${VICTIMS}/symlink-victim")|$(mode_of "${VICTIMS}/symlink-victim")" \
    "root chowned/chmodded a file of the attacker's choosing through a symlink"

# A ROOT-owned symlink is an operator pointing .env at a config-managed secrets
# directory. Deleting it would take DATABASE_URL and JWT_SECRET away from both
# the app and the updater, and re-creating it is futile — so it is left alone.
start_test "a root-owned .env symlink is left in place (an operator's choice)"
build_tree
rm -f "${d}/.env"
printf 'OPERATOR CONFIG\n' > "${VICTIMS}/operator-env"; chown root:root "${VICTIMS}/operator-env"; chmod 0600 "${VICTIMS}/operator-env"
ln -s "${VICTIMS}/operator-env" "${d}/.env"; chown -h root:root "${d}/.env"
ensure_ownership >/dev/null 2>&1
assert_eq "yes" "$( [ -L "${d}/.env" ] && echo yes || echo no )" \
    "an operator's deliberate .env symlink was deleted; the app and updater would lose their configuration"

start_test "the root-owned symlink's target is still not chmodded through"
assert_eq "OPERATOR CONFIG|root:root|600" \
    "$(cat "${VICTIMS}/operator-env")|$(owner_of "${VICTIMS}/operator-env")|$(mode_of "${VICTIMS}/operator-env")" \
    "the [ ! -L ] guard on the chown/chmod did not hold"

# --- idempotency -------------------------------------------------------------
start_test "ensure_ownership is idempotent and silent on a healthy tree"
build_tree
ensure_ownership >/dev/null 2>&1
first="$(stat -c '%U:%G %a' "${d}/deploy/perform-update.sh" "${d}/.env" "${d}/src/app.ts" "${d}" 2>/dev/null)"
second_out="$( { ensure_ownership >/dev/null; } 2>&1 )"
second="$(stat -c '%U:%G %a' "${d}/deploy/perform-update.sh" "${d}/.env" "${d}/src/app.ts" "${d}" 2>/dev/null)"
assert_eq "${first}|" "${second}|${second_out}" \
    "a second run changed the tree or emitted a warning"

# --- it must not run at all without a service account ------------------------
# Better to do nothing than to chown the tree to a uid that does not exist.
# Observing src/app.ts's owner is NOT enough and was the original mistake here:
# `chown -R nosuchuser:grp` fails before touching anything, so that file is
# unchanged whether or not the guard exists. The things that DO differ are the
# directory's own mode and whether the state files get created, so those are
# what this asserts.
start_test "a missing service account leaves APP_DIR's mode untouched"
build_tree
mode_before="$(mode_of "${d}")"
( SVC_USER="tt-definitely-no-such-user-$$"
  ensure_ownership >/dev/null 2>&1 )
assert_eq "${mode_before}" "$(mode_of "${d}")" \
    "ensure_ownership applied 1775 to APP_DIR despite the service account not existing — it is not the no-op it claims to be"

start_test "a missing service account creates no state files"
assert_eq "absent|absent|absent" \
    "$( for f in .update-status .update-log .auto-update-last-run; do
          printf '%s' "$( [ -e "${d}/${f}" ] && echo present || echo absent )"
          [ "${f}" = ".auto-update-last-run" ] || printf '|'
        done )" \
    "state files were created for a group that does not exist; the early return is missing"

# NOTE: there is deliberately no assertion here on src/app.ts's owner. build_tree
# leaves it root:root, and a recursive chown naming a user that does not exist
# fails atomically without touching anything — so such an assertion holds whether
# or not the guard exists. It was here, it could not fail, and a false marker of
# coverage is worse than an obvious gap. The two assertions above are the ones
# that distinguish the guarded case from the unguarded one.

finish_suite "ensure_ownership"
