# finisher

The pi extension behind **pi-finisher**: state the goal once, and the run finishes on its own.

```
goal (confirmed once)
  → finisher_swarm explore / code     many agents at once, one model per ladder slot
  → finisher_swarm verify             once, at the end: reads the change and runs the code
  → goal driver                       pass → one report · fail → plan another loop · unprovable → tell the human
  → context reset                     each loop starts empty; only vetted knowledge carries over
```

## What it gives the model

| Tool | What it does |
|---|---|
| `finisher_goal` | The single confirmation. After that the driver owns the run and reports once at the end. |
| `finisher_swarm` | `explore` (read-only fan-out), `verify` (once, at the end, running the changed code rather than the test suite), `code` (one git worktree + branch per slice, dependencies linked in, merged in slice-id order, overlapping paths never merged silently). |
| `finisher_steer` | Push a finding into a sub-agent that is still running — no restart. |

There is no tool that asks a human. A worker that hits a fork writes
`DECISION NEEDED: <question>` plus `assumption: <what it chose>`, continues, and the harness collects
those for the single report at the end (also written to `.finisher/decisions.md`).

## Command

`/finisher models` — choose which model each sub-agent role (`swarm`, `verifier`) runs on.
Everything else (fresh context, handoff, verification) is automatic; there is nothing to switch.

## Isolation and speed

- Sub-agents run in the real repo (`ctx.cwd`), as RPC child processes with their own session.
  They boot with `PI_FINISHER_SUBAGENT=1`, which loads only the tool-timeout rule, never the harness.
- Code slices each get their own worktree with `node_modules` symlinked from the repo, so a coder can
  run the project's tests immediately instead of installing anything. A coder must end with
  `TESTS: PASS|FAIL|SKIP` plus `FILES:`; a `FAIL` comes straight back to that coder.
- Every tool call is bounded: `bash` gets a deadline injected, `finisher_*` tools are wrapped, every
  RPC call has its own timeout, and every `git` subprocess is capped.

## Files

State lives under `.finisher/` (`handoff.jsonl`, `decisions.md`, `subagents/*.log`, `worktree/`, plus
`models.json` / `config.json`). Session state is persisted with `pi.appendEntry("finisher-state", …)`
and restored on resume.

Every source module stays at or under 500 lines and carries no code comments — both are enforced by
`test/module-budget.test.mjs` and `test/no-comments.test.mjs`.
