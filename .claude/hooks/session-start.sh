#!/bin/bash
# SessionStart hook — start every session from a known-good state.
#
# The container clones this repo when the container is CREATED, not when a
# session starts, so a session routinely opens on a checkout that is several
# releases behind `dev`. Two things then go wrong, and both have:
#
#   1. Work gets written against old code. The mistake surfaces at version-bump
#      time — the one moment the rules force a look at what is actually
#      released — which is *after* the change is written and validated. One
#      session opened at 2.96 while dev was at 3.20: 24 releases. That rebase
#      happened to be clean; a conflict in a file the stale copy also touched
#      would not have been.
#   2. The version gets bumped from the stale package.json, producing a number
#      that is not the successor of the latest release. `release-hygiene`
#      catches that on the PR, but only after the branch is pushed.
#
# It also installs dependencies, because a fresh container has no node_modules
# and nothing — lint, typecheck, build, the CI scripts — can run until it does.
#
# Deliberately NOT `set -e`: this runs before the session does anything, so a
# network blip on the fetch must degrade to a warning, never a session that
# fails to start. Every step reports what it did and the script always exits 0.
set -uo pipefail

TRUNK="dev"
line() { printf '  %s\n' "$1"; }

printf '\n──────────── Training Tracker · session start ────────────\n'

# ── 1. Freshness ─────────────────────────────────────────────────────────
# Read-only except for one fast-forward that is only taken when it cannot
# lose anything: on the trunk branch, clean tree, no local commits.

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  line "not a git checkout — skipping freshness check"
else
  if ! git fetch --quiet origin "$TRUNK" 2>/dev/null; then
    line "‼ could not reach origin — freshness UNKNOWN, verify before branching"
  else
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
    behind=$(git rev-list --count "HEAD..origin/${TRUNK}" 2>/dev/null || echo 0)
    ahead=$(git rev-list --count "origin/${TRUNK}..HEAD" 2>/dev/null || echo 0)
    # `-uno`: only TRACKED modifications make a fast-forward unsafe. Counting
    # untracked files too meant one stray scratch file left by an earlier
    # session — or the log files the deploy layer writes — silently downgraded
    # every session to the warning path, which is the branch least likely to be
    # noticed if it is wrong. Git refuses a fast-forward that would clobber an
    # untracked file by itself, and that refusal is handled below.
    dirty=$(git status --porcelain -uno 2>/dev/null | head -1)

    if [ "$behind" = "0" ]; then
      line "✔ up to date with origin/${TRUNK} (branch ${branch})"
    elif [ "$branch" = "$TRUNK" ] && [ "$ahead" = "0" ] && [ -z "$dirty" ]; then
      if git merge --ff-only "origin/${TRUNK}" --quiet 2>/dev/null; then
        line "✔ ${TRUNK} was ${behind} commit(s) behind — fast-forwarded to origin/${TRUNK}"
      else
        line "‼ ${TRUNK} is ${behind} behind and the fast-forward failed — branch from origin/${TRUNK}"
      fi
    else
      # Anything else is the session's own state to reason about: a feature
      # branch, local commits, or uncommitted edits. Say so rather than guess.
      why="branch ${branch}"
      [ "$ahead" != "0" ] && why="${why}, ${ahead} local commit(s)"
      [ -n "$dirty" ] && why="${why}, uncommitted changes"
      line "‼ HEAD is ${behind} commit(s) behind origin/${TRUNK} (${why})"
      line "  START NEW WORK FROM THE REMOTE, not from HEAD:"
      line "      git checkout -B claude/<topic> origin/${TRUNK}"
    fi

    # The number the one-step version bump must build on. Read from the remote
    # ref, never from the working tree, because a stale tree is the whole
    # problem this hook exists for.
    remote_version=$(git show "origin/${TRUNK}:package.json" 2>/dev/null \
      | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)
    [ -n "$remote_version" ] && line "origin/${TRUNK} is at version ${remote_version} — bump from this"
  fi
fi

# ── 2. Dependencies ──────────────────────────────────────────────────────
# Remote only: a local checkout manages its own node_modules, and a surprise
# install on someone's machine is not this hook's business.

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

  # After the fast-forward above, so a pulled package.json is the one installed.
  # `npm install` rather than `npm ci` so the cached container layer is reused.
  if npm install --no-audit --no-fund --loglevel=error >/tmp/tt-npm.log 2>&1; then
    line "✔ dependencies installed"
  else
    line "‼ npm install failed — see /tmp/tt-npm.log; run it by hand before building"
  fi

  # Generates the Prisma client that gives tsc the model types. It does not
  # connect, so the dummy URL CI uses is enough — but the variable must exist
  # or the datasource block fails to parse.
  if DATABASE_URL="postgresql://ci:ci@localhost:5432/ci" \
      npx prisma generate >/tmp/tt-prisma.log 2>&1; then
    line "✔ prisma client generated"
  else
    line "‼ prisma generate failed — see /tmp/tt-prisma.log; typecheck will report missing model types"
  fi
fi

printf '──────────────────────────────────────────────────────────\n\n'
exit 0
