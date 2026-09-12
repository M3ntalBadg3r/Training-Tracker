#!/bin/bash
# Static checks for the deploy/ layer: every script parses, and shellcheck is
# clean at the chosen threshold.
#
#   bash scripts/check-deploy-scripts.sh
#   npm run check:deploy
#
# WHY A SEPARATE THRESHOLD IS RECORDED HERE
#
# This layer had never been linted, so the honest question was not "is it
# clean" but "what is it worth changing to make it clean". These scripts run as
# root on customers' machines and a mistake bricks an install or silently stops
# updates; a broad unreviewed rewrite of the root-executed update path to
# satisfy a new linter is a worse trade than the findings it would fix.
#
# The measured answer made the decision easy: at --severity=error there were
# ZERO findings, and at --severity=warning there were FIVE, none of them a live
# defect (three were library variables consumed by sourcing scripts and one
# deliberate word split; the fifth was a redundant `cd` in a rollback path that
# is already guarded at the real entry point). All five are now suppressed at
# their own line with a written reason, so the threshold sits at `warning` with
# no blanket exclusions — which is what keeps it useful. A future SC2164 or
# SC2046 somewhere new will fail this check rather than being pre-forgiven.
#
# `info` and `style` are NOT enabled. The 16 findings beyond `warning` are
# 12x SC1091 ("not following" a sourced file — an artefact of not running with
# `-x`, not a code smell) and 4-5x SC2015 (`A && B || C`). Every SC2015 site was
# read: all are the benign `... || true` form. So the threshold stays where it
# is, but note WHY: it is not that those findings are stylistic noise in
# general, it is that these particular ones are accounted for. If that ever
# changes, raise the threshold deliberately and fix the findings — do not add
# exclusions.
#
# (An earlier version of this comment described those findings as `$(...)`
# preferences, `read -r` and `[` vs `[[`. No such finding exists in this tree.
# The conclusion was right and the stated reason was wrong, which is the more
# misleading of the two failures — a future reader would have trusted a
# characterisation nobody had checked.)

set -u

SEVERITY="${SHELLCHECK_SEVERITY:-warning}"

# GNU coreutils localises `stat -c %F` ("regular file"), and both common.sh and
# the fixtures compare against the English spellings. Pin the locale so a
# developer on a translated system gets the same verdict as CI rather than an
# unexplained red run. (The same exposure exists in common.sh itself on a
# translated host — pre-existing, noted, and not changed here.)
export LC_ALL=C

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

# A plain read loop rather than `mapfile`, which needs bash 4 and so would fail
# on macOS's system bash 3.2. It fails loudly there rather than silently, but
# there is no reason to make a contributor meet that at all.
SCRIPTS=()
while IFS= read -r f; do
    SCRIPTS+=("${f}")
done < <(find deploy -name '*.sh' -type f | sort)

if [ "${#SCRIPTS[@]}" -eq 0 ]; then
    echo "ERROR: no shell scripts found under deploy/. This check would pass vacuously." >&2
    exit 2
fi

echo "deploy/ static checks over ${#SCRIPTS[@]} script(s)"

# --- 1. syntax ---------------------------------------------------------------
# `bash -n` is the cheapest possible guard and it catches the failure that
# matters most: a script that cannot even be parsed is one that aborts at the
# top, as root, halfway through an update.
syntax_failed=0
for f in "${SCRIPTS[@]}"; do
    if ! bash -n "${f}" 2>/dev/null; then
        echo "  SYNTAX ERROR in ${f}:"
        bash -n "${f}" 2>&1 | sed 's/^/    /'
        syntax_failed=$((syntax_failed + 1))
    fi
done
if [ "${syntax_failed}" -ne 0 ]; then
    echo
    echo "${syntax_failed} script(s) do not parse."
    exit 1
fi
echo "  syntax: ok"

# --- 2. shellcheck -----------------------------------------------------------
# Missing shellcheck is a hard failure, not a skip. GitHub's ubuntu-latest
# runners ship it preinstalled, so in CI this cannot be hit by accident — and a
# check that quietly reports success when it did not run is the failure mode
# this whole exercise exists to remove.
if ! command -v shellcheck >/dev/null 2>&1; then
    cat >&2 <<'MSG'
  ERROR: shellcheck is not installed.

  Refusing to report success without running it: these scripts run as root on
  customers' machines, and a lint check that silently does nothing is worse
  than no lint check at all.

  Install it:  apt-get install -y shellcheck   (or: brew install shellcheck)
MSG
    exit 2
fi

if ! shellcheck --severity="${SEVERITY}" --format=gcc "${SCRIPTS[@]}"; then
    cat >&2 <<MSG

shellcheck reported findings at --severity=${SEVERITY}.

Fix the defect if it is one. If it is a false positive, suppress it AT THAT
LINE with a '# shellcheck disable=SCxxxx' comment and a written reason — not by
lowering the threshold or adding a blanket exclusion, which would pre-forgive
every future instance of the same code.
MSG
    exit 1
fi
echo "  shellcheck (--severity=${SEVERITY}): ok"

echo "deploy/ static checks passed"
