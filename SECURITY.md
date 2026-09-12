# Security

Training Tracker holds personal data about real people — names, email addresses,
training histories — for multiple tenants in one database, and it updates itself
unattended on machines nobody is watching. Both of those shape how security is
handled here.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[security advisory form](https://github.com/M3ntalBadg3r/Training-Tracker/security/advisories/new),
which is visible only to the maintainer until a fix ships.

Useful reports say what an attacker can do, which version it was found on, and
enough detail to reproduce it. A proof-of-concept is welcome but not required —
a clear description of the mechanism is worth more than a working exploit.

**What happens next**: a confirmed finding is fixed on the `dev` channel first
and promoted to stable once verified. Findings are held privately until the fix
is released — and, because installations update on their own schedule, a
reproduction stays sensitive after the fix ships. Release notes describe the
outcome, never the vector.

## Supported versions

Only the latest stable release receives fixes. There are no long-term support
branches; the update path is forward. Two channels exist:

| Channel | Gets | Who should use it |
|---|---|---|
| `stable` | Full releases | Production installs |
| `dev` | Pre-releases | Test installs, early verification |

## How security is kept current

The honest finding from the last full review was structural rather than
technical: **controls decayed because they had been recorded as completed work
rather than as standing rules.** Three fixes from an earlier round had silently
reverted, and nothing was tracking whether they had survived. So the framework
below exists to make that failure mode visible, and most of it is enforced by CI
rather than by memory.

### What runs on every change

| Check | What it prevents |
|---|---|
| `check:routes` | An API endpoint that authenticates nobody. Fails if a handler carries no recognised guard and is not on an explicit, commented allow-list. |
| `check:deploy` | Regressions in the root-executed install and update scripts, and drift in the two literals that must stay byte-identical between the app and those scripts. |
| `lint` / `typecheck` / `build` | The build step catches what type-checking cannot, including a server-only module reached from client code. |
| `check:deid` | Email addresses and home-directory paths in added lines. It catches *shapes* only — real customer, partner, product and program names remain a human check. |
| `check:release` | Version, lockfile and release-notes hygiene. |

**Passing these is not a security review.** They encode the failures already
found; they cannot find new ones.

### When a full audit happens

Audits are scheduled against a **trigger**, not a date, because the decay
observed between the last two rounds tracked feature growth rather than elapsed
time — seven new API areas is what outran the previous review, not the months
that passed.

**An audit is due when any of these lands:**

- a **new authentication or authorisation mechanism**, or a change to an
  existing one (a new token type, a new guard, a new role, a change to session
  lifetime or revocation)
- a **new externally reachable surface** — an API that can be called from
  outside the session cookie, a new webhook, a new public route
- a **new privilege boundary**, or a change to one: anything that crosses
  between the unprivileged application and root, or between tenants
- a **new sink**: filesystem writes, shell execution, outbound requests,
  template or HTML rendering, or a new export format
- a **dependency with runtime reach** being added or majored

**Backstop**: if no trigger has fired, a lightweight review runs **every 25
releases** regardless — enough to notice a control that has quietly stopped
holding, without becoming a ritual that finds nothing.

### What an audit covers

Every round re-checks the standing obligations rather than only hunting new
bugs, because the obligations are what decay:

1. **Every handler authenticates.** Machine-checked, but the *allow-list* needs
   a human: each entry asserts a route is safe to expose with no credentials.
2. **Errors are generic.** No `err.message` to a client. Message text from a
   network or filesystem error is an oracle.
3. **Every input reaching a sink is validated** — filesystem paths through the
   containment helper, bulk bodies through the size-capped reader, ids
   intersected with the caller's company scope.
4. **Anything accepting a credential is rate-limited**, with the limiter beside
   the verification rather than in each caller.
5. **Tenant scoping fails closed.** An empty scope must match nothing.
6. **Session revocation still bites** — suspension, deletion, password change,
   role change, and forced-MFA enrolment, each at the shared chokepoint rather
   than at the edge alone.
7. **The privilege boundary holds.** Root never interprets what the application
   can write; no path the service account controls is followed by a root
   operation.
8. **Secrets at rest and in archives.** What each backup shape contains, and
   what must never leave the machine unencrypted.
9. **Dependencies.** Advisories triaged by whether they have runtime reach, with
   accepted exceptions recorded with the reasoning and a re-check trigger.
10. **The controls from previous rounds still hold.** Sampled and re-verified,
    not assumed.

### How findings are verified

Two rules, both learned the hard way:

- **Reproduce before fixing, with a control run against the unfixed code.** A
  finding that has never been made to fire is a hypothesis; a fix that has never
  been made to fire is decoration. Several past findings changed severity — in
  both directions — once someone actually ran them.
- **Someone other than the implementer checks the work.** In recent rounds this
  found problems in most changes it examined, including regressions introduced
  by the security fixes themselves. Check what the documentation claims against
  what was measured, every time.

### Where findings live

Findings are kept in a durable document **outside this repository** until
remediated, and the reproductions stay confidential afterwards, because
installations update on their own schedule. This file — the process — is public;
the findings are not.

## Security-relevant design

The security-relevant architecture is documented in `CLAUDE.md`: the guard
model, session revocation, tenant scoping, the privilege split in the deployment
scripts, and the Content-Security-Policy. Those notes name mechanisms
deliberately — they are how a control survives the next refactor, and they are
only useful to someone who already has the source.
