# zense-harness

Goal-confirm autonomous runner for pi: **confirm the goal ONCE, then the harness owns the run.**

```
goal (one confirmation)
  → zense_swarm explore / code   (many agents at once, one model per ladder slot)
  → zense_swarm verify           (verifiers must run real commands)
  → goal driver                  (evidence-gated rounds: fix → verify → … , bounded)
  → ONE report: every case with its evidence, or an honest "not proven"
```

There is no spec signing, no ADR approval, no review packet and no gate switch: the only human
input in a run is the goal confirmation. The harness never caps tokens or cost — it spends what
the goal needs, and stops on evidence, not on budget.

### What the agent can call

| Tool | What it does |
|---|---|
| `zense_goal` | Confirm the goal once, then drive it: keeps the round counter, judges each case from executed evidence, hands failures back for another round, and stops with one report when every case is proven or the bound is reached. |
| `zense_swarm` | Parallel sub-agents on the model ladder (`priority1..priority5` in `.zense/models.json`, capped by `swarmConcurrency`). `explore` = read-only fan-out, `verify` = independent verifiers that must run real commands, `code` = one git worktree + branch per slice, merged back in deterministic slice-id order and refusing to merge overlapping paths silently. |
| `zense_ask` | Multiple-choice picker for goal/UI questions, only when a question truly cannot be decided by the agent. |

### Rules the harness enforces on the result

- **Evidence or it did not happen** — a case with no executed command is `UNVERIFIED`, never `PASS`.
- **No comments in code**, and a file stays at or under 500 lines; violations come back to the
  same turn as a tool error until they are fixed.
- **Nobody approves mid-run** — the loop is bounded by rounds and by unchanged evidence.

### Watching it run

Every concurrent agent gets its own row in the widget (`AGENTS ▸ N running`): tag, model, slot,
elapsed and the live tail — no keypress, no per-agent viewer.

## Agent-facing tools

| Tool | What it does |
|---|---|
| `zense_goal` | The goal-confirm driver: one confirmation, then the harness owns the run. It keeps the round counter, reads each verdict from executed evidence, hands failures back for another round, and stops with ONE report when every case is proven or the bound is reached. No approval prompt between rounds, no token/cost ceiling. |
| `zense_swarm` | Parallel sub-agents on the model ladder (`priority1..priority5` in `.zense/models.json`, capped by `swarmConcurrency`). `explore` = read-only fan-out, `verify` = independent verifiers that must run real commands, `code` = one git worktree + branch per slice, merged back in deterministic slice-id order and refusing to merge overlapping paths silently. |
| `zense_ask` | Multiple-choice picker for goal/UI questions — skipped entirely when the gate is off. |

Every tool above delegates the heavy work to isolated sub-agent runs of pi itself (guarded by
`PI_ZENSE_SUBAGENT=1` so sub-agents never recurse into the harness). Sub-agents spawn with stdin
ignored (pi print mode blocks on stdin EOF otherwise) and stream stdout/stderr live to
`.zense/subagents/<stamp>-<role>.log`.

## State

Persisted in-session via `pi.appendEntry("zense-state", …)` (restored on
resume/reload) and on disk under `.zense/` (memory.jsonl, subagents/, worktree/)
so a run survives across sessions and the model ladder / concurrency settings stay diffable.
