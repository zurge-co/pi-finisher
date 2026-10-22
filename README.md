# pi-zense

> **Goal-confirm autonomous runner for pi.** You state the goal and confirm it once; the harness
> then spends every resource you have — many models at once, no token or cost ceiling — until the
> result is *proven*, and reports once at the end.

"Zense" is a pun on the Thai word for *sign*: the signature moved from "approve every step" to
"confirm the goal once".

## The one loop

```
goal (confirmed once)
   └─ zense_goal ──► zense_swarm explore / code   (N agents at once, one model per ladder slot)
                     zense_swarm verify           (verifiers must RUN commands)
                     goal driver                  (evidence-gated rounds, fixed → verify → …)
   └─► ONE report: every case + its evidence, or an honest "not proven"
```

- **No gates.** No spec signing, no ADR approval, no review packet, no gate switch — nothing to
  click between the goal and the result.
- **No budget ceiling.** The run spends what the goal needs; it stops on *evidence*, not on cost.
- **Evidence or it did not happen.** A case with no executed command is `UNVERIFIED`, never `PASS`.
  The loop is bounded: identical evidence stops it, rounds are counted.
- **Five models in parallel.** `priority1..priority5` in `.zense/models.json` are the slots; the
  harness uses as many as you set, all at the same time.

## Quick start

```text
1. Tell the agent the goal                 → zense_goal confirms it once (no approval later)
2. Let it run                              → the widget shows every live agent side by side
3. Read the report                         → per case: PASS / FAIL / UNVERIFIED + the commands run
```

## What you can call

| Tool | What it does |
|---|---|
| `zense_goal` | The single confirmation. Then the driver owns the run: rounds, evidence, fix-or-stop. |
| `zense_swarm` | `explore` (read-only fan-out), `verify` (independent verifiers), `code` (one git worktree + branch per slice, merged back deterministically, overlapping paths never merged silently). |
| `zense_ask` | Multiple-choice picker — only for a goal/UI question the agent genuinely cannot decide. |

## Watching it run

Every concurrent agent gets its own row in the widget — tag, model, slot, elapsed time and live
tail — so five agents look like five lines, not five keypresses:

```
ZENSE ▸ IMPLEMENTATION · turns 12 · tok 84k · 🧪 5 agents live
AGENTS ▸ 5 running
SWA   ▶ swarm   s1 provider/a  42s  fixing the scheduler bound…
SWA2  ▶ swarm   s2 provider/b  41s  reading src/swarm.ts…
GRAD  ▶ grader              12s  running probes
```

## Commands

| Command | What it does |
|---|---|
| `/zense status` | phase, worktree, turns/tokens, flags, escalations |
| `/zense surface` | what this build exposes: tools, commands, ladder, concurrency, ceiling (none) |
| `/zense models` | pick the model ladder slots (priority 1–5) |
| `ctrl+_` / `/zense agents` | live tail of the running sub-agents |
| `/zense memory` | grouped lesson summary (`json` = raw) |
| `/zense distill` | compact `memory.jsonl` into one lesson set (aborts without deleting on failure) |
| `/zense resume` | continue a run found on disk |

## Configuration

`.zense/models.json`

```json
{ "priority": ["anthropic/claude-sonnet", "openai/gpt-5", "google/gemini-pro"] }
```

`.zense/config.json`

```json
{ "swarmConcurrency": 5, "subagentTimeoutMs": { "default": 1200000 } }
```

Unset slots are simply not used; there is no ceiling key anywhere — if one is present it is
reported as ignored, never obeyed.

## Rules the harness enforces on the result

- **No comments in code** (line or block); a load-bearing reason must carry
  `zense-hygiene-allow: <why>`. Violations come straight back to the same turn.
- **A file stays at or under 500 lines** — split it instead of growing past that.
- **Tests are proof, not coverage** — a test that would pass with the logic broken is worse than none.

## Files

```
pi-zense/
├── package.json                     # pi manifest
├── extensions/zense-harness/
│   ├── index.ts                     # pi wiring: hooks, tools, commands, TUI
│   └── src/                         # pure helpers (goal driver, swarm, verify loop, panel, …)
├── test/                            # node:test suites
└── themes/                          # Zense dark theme
```

Theme (optional): `/settings` → theme → `zense`.
