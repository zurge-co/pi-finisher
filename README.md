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
| `zense_goal` | The single confirmation. Then the driver owns the run: rounds, evidence, fix-or-stop, and one report at the end. |
| `zense_steer` | Push a finding into a sub-agent that is still running — steer or follow-up, no restart. |
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
| `/zense status` | phase, changes this cycle, turns/tokens, flags, escalations |
| `/zense surface` | what this build exposes: tools, commands, ladder, concurrency (the only source of truth for the command list) |
| `/zense models` | pick the model ladder slots (priority 1–5) |
| `ctrl+_` / `/zense agents` | live tail of the running sub-agents |
| `/zense resume` | continue a run found on disk |
| `/zense fresh-context on/off/status/clear` | the task-boundary context reset and the knowledge stack behind it |

## Configuration

`.zense/models.json`

```json
{ "priority": ["anthropic/claude-sonnet", "openai/gpt-5", "google/gemini-pro"] }
```

`.zense/config.json`

```json
{ "swarmConcurrency": 5, "subagentTimeoutMs": { "default": 1200000 }, "freshContext": true }
```

Unset slots are simply not used; there is no ceiling key anywhere — if one is present it is
reported as ignored, never obeyed.

## Fresh context and the handoff stack

Every finished task resets the main session's context on purpose (`agent_before_settle` → a
retain-none compaction entry). What survives is **not** a transcript or a statistic — it is the
handoff stack in `.zense/handoff.jsonl`:

```
sub-agent finishes
   └─ classify() asks: would this make the NEXT task faster or more correct?
        ├─ no  → dropped (no model call is spent on it)
        └─ yes → condensed to ONE line → stack (deduped, capped at 12)
   └─► next task starts with that stack injected + an empty context
```

Sub-agents run under `RpcClient`, so a finding can be pushed into a **run that is already working**
with `steer()` instead of restarting it. Every role boots with `--exclude-tools zense_*`, so a
sub-agent can never re-enter the harness.

The classifier is the gate: **nothing is carried without a verdict.** If no classifier has
credentials (or it errors), the note is dropped and the harness tells you which one to log in —
it never falls back to "keep everything". Log in one of:

| classifier | credential |
|---|---|
| `typesafe/jev-latest` | `TYPESAFE_API_KEY` |
| `cloudflare-workers-ai/@cf/cloudflare/clef(-flash)` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| `openai/gpt-6-luna` | `OPENAI_API_KEY` |

Turn the reset off with `/zense fresh-context off`; inspect the stack with `/zense fresh-context status`.

## Coders prove their own slice

Each `zense_swarm mode=code` slice gets its own git worktree **with your dependencies linked in**
(`node_modules` is symlinked from the repo and excluded from the slice's diff), so a coder runs your
test command immediately instead of installing anything. A coder must end with two lines:

```
TESTS: PASS|FAIL|SKIP <reason>
FILES: <paths it changed>
```

A `FAIL` comes straight back to that coder to fix before its slice is accepted.

## No one asks you mid-run

There is no picker and no question tool: a worker that hits a fork declares it in one line instead.

```
DECISION NEEDED: should the cache be per-tenant?
assumption: yes, keyed by tenant id
```

The worker continues with that assumption, the harness collects every declaration, and the single
report at the end lists them (`decisions made without asking you`) plus `.zense/decisions.md`.

## Choosing the handoff model

The handoff gate needs a model; you pick it in the same ladder file as a slot of its own:

```json
{ "priority1": "anthropic/claude-sonnet", "handoff": "openai/gpt-5-mini" }
```

- **unset (default)** → the harness detects whichever classifier your providers expose and uses it; if you have none, handoff simply stays off — nothing to configure, no nagging
- a **classifier** model (`typesafe/jev-latest`, `cf/clef`, `openai/gpt-6-luna`) → uses `classify()`
- any **chat** model → asked `KEEP`/`DROP` with one short call

The `handoff` slot is never counted as a fan-out rung.

## Where the work happens

The agent writes **in your repo**. There is no shadow checkout to get lost in: what `zense` edits is
what `git status` shows, so a review always looks at the same tree the agent worked in. The only
worktrees left are the per-slice ones that `zense_swarm mode=code` gives each parallel coder, so
two coders can never overwrite each other; they are merged back deterministically by slice id.

Rollback is per cycle: `/zense discard` returns every path the cycle touched to the commit the goal
was confirmed on (files created during the cycle are removed). `/zense accept commit` commits the
cycle with a prepared message; plain `/zense accept` closes the cycle and leaves your working tree
alone.

## Every tool call is bounded

A `bash` call that carries no `timeout` runs **forever** in pi — the tool simply waits. The harness
closes that hole for the main agent *and* for every sub-agent: a `tool_call` hook injects a deadline
whenever one is missing or invalid.

| call | bound |
|---|---|
| `bash` | injected if absent (default 900 s, override with `toolTimeoutMs` in `.zense/config.json`) |
| `zense_goal` / `zense_swarm` / `zense_steer` / `zense_ask` | wrapped, reports `⏱ … exceeded its Ns limit` instead of hanging |
| every RPC call to a sub-agent (`start`, `promptAndWait`, `steer`, `getMessages`, …) | its own deadline |
| every `git` subprocess | 120 s, `SIGKILL` on expiry |

```json
{ "toolTimeoutMs": { "bash": 900000, "zense_swarm": 1800000 } }
```

A broken config falls back to the default rather than failing a tool call.

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
