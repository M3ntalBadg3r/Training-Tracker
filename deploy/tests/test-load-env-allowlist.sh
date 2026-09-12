#!/bin/bash
# load_env_allowlist — the parser that stands between a group-writable .env and
# a root shell.
#
# .env is 0660 root:<svc-group> by design, because the app rewrites
# UPDATE_CHANNEL when the operator switches release channel. That makes every
# byte of it attacker-chosen after a compromise of the app, and it is read by
# perform-update.sh running as root. `source` would therefore be arbitrary root
# code execution the app can trigger on demand (it can start an update itself by
# writing .update-request).
#
# Two families of property are pinned here:
#   parsing  — only allow-listed keys are assigned, values are assigned and
#              never evaluated, and realistic files (quotes, '=' in the value,
#              CRLF, `export `, comments, no trailing newline) survive intact.
#   checking — a rejected value must not leave the system worse off than no
#              check at all. NODE_EXTRA_CA_CERTS is dropped because it decides
#              which CAs root's Node trusts; DATABASE_URL only warns, because
#              unsetting it makes perform-update.sh skip the pre-update pg_dump
#              and leaves the rollback nothing to restore.
#
# Every case runs in a SUBSHELL: the function exports into the current shell, so
# without that a value would leak into the next assertion and one test could
# make the next one pass.
#
# See CLAUDE.md, "Root never *interprets* anything the service user can write".

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/tests/harness.sh
source "${HERE}/harness.sh"

export APP_DIR="${TEST_APP_DIR:?TEST_APP_DIR must be set by run.sh}"
# shellcheck source=deploy/lib/common.sh
source "${HERE}/../lib/common.sh"
SVC_USER="${TEST_SVC_USER:?}"
SVC_GROUP="${TEST_SVC_GROUP:?}"

ENV_FILE="${APP_DIR}/.env"

# The real CA bundle, discovered once: it is both the accept-path fixture below
# and the only value NODE_EXTRA_CA_CERTS will take, since that key is the one
# whose value is CHECKED rather than merely parsed.
BUNDLE=/etc/ssl/certs/ca-certificates.crt
[ -f "${BUNDLE}" ] || die "${BUNDLE} is absent, so the NODE_EXTRA_CA_CERTS accept path cannot be exercised (it must not be reported as a pass)"
[ "$(stat -c '%U' "${BUNDLE}")" = "root" ] || die "${BUNDLE} is not root-owned on this host; the fixture's premise does not hold"

# Write .env, load it in a subshell, echo one variable's value (or <UNSET>).
# The subshell is the isolation; the parent's environment never changes.
value_of() {
    local var="$1"
    ( load_env_allowlist >/dev/null 2>&1; eval "printf '%s' \"\${${var}-<UNSET>}\"" )
}

# Same, but capture the diagnostics instead of the value.
messages() {
    ( { load_env_allowlist >/dev/null; } 2>&1 )
}

write_env() { printf '%s' "$1" > "${ENV_FILE}"; }

# --- the allow-list is a closed set ------------------------------------------
start_test "an allow-listed key is assigned"
write_env 'UPDATE_CHANNEL=dev
'
assert_eq "dev" "$(value_of UPDATE_CHANNEL)"

start_test "a key that is not on the list is dropped"
write_env 'UPDATE_CHANNEL=dev
NOT_ALLOWED=surprise
'
assert_eq "<UNSET>" "$(value_of NOT_ALLOWED)" "an arbitrary key from .env reached root's environment"

# The keys that make this a security control rather than a convenience: .env
# holds the app's own secrets, and root has no business importing them.
start_test "application secrets in .env are not imported into root's environment"
write_env 'JWT_SECRET=shh
ENCRYPTION_KEY=0123456789abcdef
CRON_SECRET=abc
PATH=/attacker/bin
LD_PRELOAD=/tmp/evil.so
BASH_ENV=/tmp/evil.sh
'
assert_eq "<UNSET>|<UNSET>|<UNSET>|<UNSET>|<UNSET>" \
    "$(value_of JWT_SECRET)|$(value_of ENCRYPTION_KEY)|$(value_of CRON_SECRET)|$(value_of LD_PRELOAD)|$(value_of BASH_ENV)" \
    "a key outside ENV_ALLOWED_KEYS was assigned"

start_test "PATH is not overwritten from .env"
write_env 'PATH=/attacker/bin
'
assert_not_contains "$(value_of PATH)" "/attacker/bin" \
    "root's PATH was taken from a service-user-writable file"

# Every key the list names must actually work — a typo in ENV_ALLOWED_KEYS would
# silently drop a setting rather than fail, and CSP_MODE is on the list
# specifically so the operator's way back from a broken CSP survives an update.
start_test "every key on ENV_ALLOWED_KEYS is actually assignable"
expected=""; actual=""
for key in ${ENV_ALLOWED_KEYS}; do
    # NODE_EXTRA_CA_CERTS is the one key whose VALUE is checked and dropped on
    # rejection, so it needs a value that actually passes; a generic probe
    # string would be dropped for the right reason and look like a bug.
    probe="probe-value"
    [ "${key}" = "NODE_EXTRA_CA_CERTS" ] && probe="${BUNDLE}"
    write_env "${key}=${probe}
"
    expected="${expected}${key}=${probe};"
    actual="${actual}${key}=$( ( load_env_allowlist >/dev/null 2>&1; eval "printf '%s' \"\${${key}-<UNSET>}\"" ) );"
done
assert_eq "${expected}" "${actual}" "a key named on ENV_ALLOWED_KEYS was not assigned"

start_test "ENV_ALLOWED_KEYS still names the closed set root needs"
assert_eq "DATABASE_URL GITHUB_TOKEN NODE_EXTRA_CA_CERTS UPDATE_CHANNEL CSP_MODE TT_BUILD_MIN_MB npm_config_cache" \
    "${ENV_ALLOWED_KEYS}" \
    "the allow-list changed; adding a key is a security decision, so update this assertion deliberately"

# --- values are never evaluated ----------------------------------------------
# The whole reason this function exists instead of `source`.
start_test "command substitution in a value is inert text, not executed"
write_env "UPDATE_CHANNEL=\$(touch ${APP_DIR}/PWNED-SUBST)
"
( load_env_allowlist >/dev/null 2>&1 )
assert_eq "no" "$( [ -e "${APP_DIR}/PWNED-SUBST" ] && echo yes || echo no )" \
    "a command substitution in .env ran as root"

start_test "the substitution is preserved verbatim as a string"
assert_eq "\$(touch ${APP_DIR}/PWNED-SUBST)" "$(value_of UPDATE_CHANNEL)"

start_test "backticks in a value are inert"
write_env "UPDATE_CHANNEL=\`touch ${APP_DIR}/PWNED-TICK\`
"
( load_env_allowlist >/dev/null 2>&1 )
assert_eq "no" "$( [ -e "${APP_DIR}/PWNED-TICK" ] && echo yes || echo no )"

start_test "a bare command line in .env is not run"
write_env "touch ${APP_DIR}/PWNED-BARE
UPDATE_CHANNEL=dev
"
( load_env_allowlist >/dev/null 2>&1 )
assert_eq "no|dev" \
    "$( [ -e "${APP_DIR}/PWNED-BARE" ] && echo yes || echo no )|$(value_of UPDATE_CHANNEL)" \
    "a line that is not KEY=VALUE was executed, or aborted the parse"

# --- realistic value shapes --------------------------------------------------
start_test "a double-quoted value has exactly one layer of quotes stripped"
write_env 'DATABASE_URL="postgresql://u:p@localhost:5432/db"
'
assert_eq "postgresql://u:p@localhost:5432/db" "$(value_of DATABASE_URL)"

start_test "a single-quoted value has exactly one layer of quotes stripped"
write_env "DATABASE_URL='postgresql://u:p@localhost:5432/db'
"
assert_eq "postgresql://u:p@localhost:5432/db" "$(value_of DATABASE_URL)"

start_test "an '=' inside the value survives (only the first splits key from value)"
write_env 'DATABASE_URL="postgresql://u:p=w@localhost:5432/db?sslmode=require&x=1"
'
assert_eq "postgresql://u:p=w@localhost:5432/db?sslmode=require&x=1" "$(value_of DATABASE_URL)" \
    "the value was split on the wrong '='; a password containing '=' would be truncated"

start_test "an unquoted value with spaces survives"
write_env 'TT_BUILD_MIN_MB=2048 
'
assert_eq "2048 " "$(value_of TT_BUILD_MIN_MB)"

# The CRLF case has a specific ordering bug behind it: strip the quotes first and
# KEY="v"<CR> never matches the quote pattern, leaving the quotes embedded in the
# value. That produced a path nothing could use, silently.
start_test "CRLF line endings are handled (unquoted)"
printf 'UPDATE_CHANNEL=stable\r\nTT_BUILD_MIN_MB=1024\r\n' > "${ENV_FILE}"
assert_eq "stable|1024" "$(value_of UPDATE_CHANNEL)|$(value_of TT_BUILD_MIN_MB)"

start_test "CRLF and quotes together: the CR is stripped BEFORE the quotes"
printf 'UPDATE_CHANNEL="dev"\r\n' > "${ENV_FILE}"
assert_eq "dev" "$(value_of UPDATE_CHANNEL)" \
    "quote stripping ran before CR stripping, leaving quote characters in the value"

start_test "a trailing blank line is ignored"
printf 'UPDATE_CHANNEL=dev\n\n' > "${ENV_FILE}"
assert_eq "dev" "$(value_of UPDATE_CHANNEL)"

start_test "a trailing CRLF blank line is ignored"
printf 'UPDATE_CHANNEL=dev\r\n\r\n' > "${ENV_FILE}"
assert_eq "dev" "$(value_of UPDATE_CHANNEL)"

start_test "a final line with no trailing newline is still read"
printf 'UPDATE_CHANNEL=dev\nCSP_MODE=report-only' > "${ENV_FILE}"
assert_eq "report-only" "$(value_of CSP_MODE)" \
    "the last line of a file with no trailing newline was dropped"

start_test "comments, blanks, indentation and 'export ' are tolerated"
printf '# a comment\n\n   export UPDATE_CHANNEL=dev\n' > "${ENV_FILE}"
assert_eq "dev" "$(value_of UPDATE_CHANNEL)"

start_test "a commented-out allow-listed key is not assigned"
printf '#UPDATE_CHANNEL=dev\n' > "${ENV_FILE}"
assert_eq "<UNSET>" "$(value_of UPDATE_CHANNEL)"

start_test "malformed lines are skipped without aborting the parse"
printf 'not a kv line\n=novalue\n9BAD=x\nBAD-KEY=x\nUPDATE_CHANNEL=dev\n' > "${ENV_FILE}"
assert_eq "dev" "$(value_of UPDATE_CHANNEL)" \
    "a malformed line stopped the parse, silently dropping every later setting"

start_test "an absent .env is not an error"
rm -f "${ENV_FILE}"
( load_env_allowlist >/dev/null 2>&1 )
assert_eq "0" "$?"

# --- value checking: the asymmetry that matters ------------------------------
# The exact line install.sh writes must be accepted. If it were not, every
# install behind an SSL-inspecting proxy would lose its CA bundle on update.
start_test "the CA bundle line install.sh writes is accepted"
write_env "NODE_EXTRA_CA_CERTS=${BUNDLE}
"
assert_eq "${BUNDLE}" "$(value_of NODE_EXTRA_CA_CERTS)" \
    "the value install.sh itself writes was rejected; updates behind an SSL-inspecting proxy would break"

# checked_ca_bundle applies four independent rules, and the first version of
# this fixture exercised only one of them. Its bundle was SERVICE-USER-OWNED, so
# the owner check rejected it before the group, world-writable and
# path-punctuation rules were ever reached — all three could be deleted and the
# fixture stayed green. Each rule now gets a bundle that reaches exactly it.
#
# The accept direction matters as much as the reject direction here. common.sh
# deliberately ACCEPTS a root:root 0664 bundle — the artefact a configuration
# management system leaves behind — because the threat is the application
# account rewriting the file, not the group-write bit as such. A "tightening"
# that refused it would cost every install behind an SSL-inspecting proxy its CA
# bundle on the next update, which is a worse outage than the one it prevents.

start_test "a bundle the SERVICE GROUP can write is dropped (the group rule)"
GRP_WRITABLE="${APP_DIR}/root-owned-svc-group-writable.crt"
: > "${GRP_WRITABLE}"; chown "root:${SVC_GROUP}" "${GRP_WRITABLE}"; chmod 0664 "${GRP_WRITABLE}"
# Root-owned, so it gets past the owner check and the group rule is what has to
# reject it. That is the whole point of this fixture.
[ "$(stat -c '%U:%G %a' "${GRP_WRITABLE}")" = "root:${SVC_GROUP} 664" ] ||
    die "the group-writable bundle fixture is not root:${SVC_GROUP} 0664, so it would not reach the group rule"
write_env "NODE_EXTRA_CA_CERTS=${GRP_WRITABLE}
"
assert_eq "<UNSET>" "$(value_of NODE_EXTRA_CA_CERTS)" \
    "the application account could rewrite this file, and so choose which certificate authorities root's Node trusts"

start_test "dropping the CA bundle is reported loudly"
assert_contains "$(messages)" "NODE_EXTRA_CA_CERTS"

start_test "a root:root group-writable bundle is ACCEPTED (the deliberate carve-out)"
CFG_MANAGED="${APP_DIR}/root-root-group-writable.crt"
: > "${CFG_MANAGED}"; chown root:root "${CFG_MANAGED}"; chmod 0664 "${CFG_MANAGED}"
write_env "NODE_EXTRA_CA_CERTS=${CFG_MANAGED}
"
assert_eq "${CFG_MANAGED}" "$(value_of NODE_EXTRA_CA_CERTS)" \
    "a root:root 0664 bundle was rejected; every install behind an SSL-inspecting proxy would lose its CA bundle on the next update"

start_test "a world-writable bundle is dropped (the world rule)"
WORLD_WRITABLE="${APP_DIR}/root-owned-world-writable.crt"
: > "${WORLD_WRITABLE}"; chown root:root "${WORLD_WRITABLE}"; chmod 0666 "${WORLD_WRITABLE}"
# root:root, so neither the owner nor the service-group rule applies: only the
# world-writable rule can reject this one.
write_env "NODE_EXTRA_CA_CERTS=${WORLD_WRITABLE}
"
assert_eq "<UNSET>" "$(value_of NODE_EXTRA_CA_CERTS)" \
    "anyone on the host could choose which certificate authorities root's Node trusts"

start_test "a service-user-owned bundle is dropped (the owner rule)"
SVC_OWNED="${APP_DIR}/svc-owned-bundle.crt"
: > "${SVC_OWNED}"; chown "${SVC_USER}:${SVC_GROUP}" "${SVC_OWNED}"; chmod 0644 "${SVC_OWNED}"
write_env "NODE_EXTRA_CA_CERTS=${SVC_OWNED}
"
assert_eq "<UNSET>" "$(value_of NODE_EXTRA_CA_CERTS)"

start_test "a path containing shell punctuation is dropped (the path rule)"
# Rejected on the path's characters alone, before anything is stat'd — a
# certificate bundle path has no punctuation of this kind and a value that does
# is not one. The file deliberately does not exist: if the punctuation rule were
# removed, the value would still be rejected for not existing, so the fixture
# creates it to make the punctuation the only thing standing in the way.
PUNCT="${APP_DIR}/bundle;rm -rf.crt"
: > "${PUNCT}"; chown root:root "${PUNCT}"; chmod 0644 "${PUNCT}"
write_env "NODE_EXTRA_CA_CERTS=${PUNCT}
"
assert_eq "<UNSET>" "$(value_of NODE_EXTRA_CA_CERTS)" \
    "a path carrying shell punctuation was accepted into root's environment"

start_test "a relative CA bundle path is dropped"
write_env "NODE_EXTRA_CA_CERTS=relative/bundle.crt
"
assert_eq "<UNSET>" "$(value_of NODE_EXTRA_CA_CERTS)"

# The counter-rule, and the one most likely to be "tidied" into symmetry by
# someone making the checks consistent. It must stay asymmetric.
start_test "an implausible DATABASE_URL is kept, not unset"
write_env 'DATABASE_URL=notaurl
'
assert_eq "notaurl" "$(value_of DATABASE_URL)" \
    "DATABASE_URL was unset by its own validator; perform-update.sh would skip the pre-update pg_dump and the rollback would have nothing to restore"

start_test "an implausible DATABASE_URL still warns"
assert_contains "$(messages)" "DATABASE_URL"

start_test "the DATABASE_URL warning does not echo the value (it carries a password)"
write_env 'DATABASE_URL=notaurl-s3cr3t-p4ssw0rd
'
assert_not_contains "$(messages)" "s3cr3t" "a diagnostic printed the database password"

start_test "an implausible npm_config_cache is kept, not unset"
write_env 'npm_config_cache=relative/path
'
assert_eq "relative/path" "$(value_of npm_config_cache)"

start_test "an implausible npm_config_cache still warns"
assert_contains "$(messages)" "npm_config_cache"

# Only values the FILE supplied are checked, so a legitimate one-off override
# such as `NODE_EXTRA_CA_CERTS=/path bash update.sh` is left alone.
start_test "a value already in the environment but absent from .env is not checked"
write_env 'UPDATE_CHANNEL=dev
'
assert_eq "${GRP_WRITABLE}" "$( NODE_EXTRA_CA_CERTS="${GRP_WRITABLE}" bash -c '
    set -u
    export APP_DIR="$1"
    source "$2"
    load_env_allowlist >/dev/null 2>&1
    printf "%s" "${NODE_EXTRA_CA_CERTS-<UNSET>}"' _ "${APP_DIR}" "${HERE}/../lib/common.sh" )" \
    "an operator's one-off environment override was dropped by a check meant for the file"

# Reading the value back in the same subshell cannot tell an assignment from an
# export, and it is the EXPORT that matters: root's children — npm, prisma,
# pg_dump — are what actually need DATABASE_URL. This reads it from a child
# process instead.
start_test "values are exported, not merely assigned (root's children must see them)"
write_env 'DATABASE_URL=postgresql://u:p@localhost:5432/db
'
assert_eq "postgresql://u:p@localhost:5432/db" \
    "$( ( load_env_allowlist >/dev/null 2>&1; bash -c 'printf "%s" "${DATABASE_URL-<UNSET>}"' ) )" \
    "the value was assigned but not exported; npm, prisma and pg_dump would not see it"

start_test "a healthy .env produces no diagnostics at all"
write_env "UPDATE_CHANNEL=dev
DATABASE_URL=postgresql://u:p@localhost:5432/db
NODE_EXTRA_CA_CERTS=${BUNDLE}
"
assert_eq "" "$(messages)" "a valid configuration emitted a warning"

finish_suite "load_env_allowlist"
