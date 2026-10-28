---
name: verify-checks
description: Prove a confirmed goal's cases with scoped, parallel, cached checks and the state home's check file instead of adding tests. Use before calling verify, and whenever a case needs evidence.
---

# Verify with checks, not with more tests

A case is proven by a check that runs and whose exit status the harness records. The two words you
use for it are **check** (what runs) and **result** (what it came to).

## The checks are the repo's own

`npm run typecheck`, `npm run lint`, `npm run test` — whatever `package.json` already defines. Run
them scoped to what changed, in parallel, and cached:

- **Scoped**: a check whose paths no changed file touches is skipped. An empty change set runs
  everything, so an unknown scope is never silently skipped.
- **Parallel**: independent checks run at the same time; results keep the task order whatever the
  completion order is.
- **Cached**: the same check with the same fingerprint of what changed returns the recorded result
  instead of running again. Re-running a green suite to learn nothing is the slowest thing a run does.

## A missing toolchain is not a broken repo

A check whose toolchain is absent (command not found, module missing) is `infra`; a check cut off by
its deadline is `deadline`. Both are reported as `SKIP` and never fail a case. Only a check that
really ran and really failed is `FAIL` — that one fails every case immediately.

## The check file is the evidence

Evidence lives in `~/.pi/finisher/<project>/checks/checks.jsonl` — the state home, never the repo —
with one JSON record per line: the case, the status,
the command, the time. Per case the newest record wins, and a case with no record is `UNVERIFIED`,
never `PASS`. The human-readable view is one line per case:

```
PASS        the widget renders below the editor
FAIL        the report survives a cleared context
SKIP        the typecheck toolchain is installed
UNVERIFIED  the goal dialog speaks Thai
```

So proof never means adding another unit test to the repo. The suite has a growth ceiling for exactly
that reason: a run that needs a new assertion records it in the check file instead, and the repo's
test suite stays the size the repo wants.

## Order of work

1. Close every lap with `lap done` — `verify` is refused while a lap is open.
2. Run the checks once, scoped, and read the results.
3. Call `verify` with one command per case. A case left out stays `UNVERIFIED`.
4. If it comes back failing, fix the real cause and verify again — the round is bounded, and the same
   evidence twice stops the loop instead of spinning.
