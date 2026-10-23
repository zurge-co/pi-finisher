# pi-finisher

> **Goal-confirm autonomous runner for pi.** You state the goal and confirm it once; the harness
> then spends every resource you have — many models at once, no token or cost ceiling — until the
> result is *proven*, and reports once at the end.

## The one loop

```
goal (confirmed once)
   └─ finisher_goal ──► finisher_swarm explore / code   (N agents at once, one model per ladder slot)
                     finisher_swarm verify           (verifiers must RUN commands)
                     goal driver                  (evidence-gated rounds, fixed → verify → …)
   └─► ONE report: every case + its evidence, or an honest "not proven"
```

- **No gates.** No spec signing, no ADR approval, no review packet, no gate switch — nothing to
  click between the goal and the result.
- **No budget ceiling.** The run spends what the goal needs; it stops on *evidence*, not on cost.
- **Evidence or it did not happen.** A case with no executed command is `UNVERIFIED`, never `PASS`.
  The loop is bounded: identical evidence stops it, rounds are counted.
- **Five models in parallel.** `priority1..priority5` in `.finisher/models.json` are the slots; the
  harness uses as many as you set, all at the same time.

## Quick start

```text
1. Tell the agent the goal                 → finisher_goal confirms it once (no approval later)
2. Let it run                              → the widget shows every live agent side by side
3. Read the report                         → per case: PASS / FAIL / UNVERIFIED + the commands run
```

## What you can call

| Tool | What it does |
|---|---|
| `finisher_goal` | The single confirmation. Then the driver owns the run: rounds, evidence, fix-or-stop, and one report at the end. |
| `finisher_steer` | Push a finding into a sub-agent that is still running — steer or follow-up, no restart. |
| `finisher_swarm` | `explore` (read-only fan-out), `verify` (independent verifiers), `code` (one git worktree + branch per slice, merged back deterministically, overlapping paths never merged silently). |
| `finisher_ask` | Multiple-choice picker — only for a goal/UI question the agent genuinely cannot decide. |

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
| `/finisher models` | choose which model each sub-agent role (`swarm`, `verifier`) runs on |

There is nothing else to switch: fresh context, handoff and verification are automatic.

## Configuration

`.finisher/models.json`

```json
{ "priority": ["anthropic/claude-sonnet", "openai/gpt-5", "google/gemini-pro"] }
```

`.finisher/config.json`

```json
{ "swarmConcurrency": 5, "subagentTimeoutMs": { "default": 1200000 }, "freshContext": true }
```

Unset slots are simply not used; there is no ceiling key anywhere — if one is present it is
reported as ignored, never obeyed.

## Verification runs once, at the end

`finisher_swarm mode=verify` is not a loop. After the implementation loops are done, it runs **once**:
the verifier reads the change and exercises the changed code directly — it is explicitly told **not**
to run the test suite as proof. Three outcomes:

| outcome | what happens |
|---|---|
| every case exercised and holds | one report, done |
| a case failed | the main agent is told to plan the next loop itself, then verify once at the end again (bounded, then it halts) |
| nothing could be exercised directly | the verifier runs nothing else and tells you to test by hand |

## Fresh context and the handoff stack

Every finished task resets the main session's context on purpose (`agent_before_settle` → a
retain-none compaction entry). There is no switch: it always happens.

What survives is **not** a transcript or a statistic — it is the handoff stack in
`.finisher/handoff.jsonl`, and it is scoped to **one goal**: notes carry the goal they were learned
in, so loops inside a goal share knowledge while a new goal starts from an empty stack.

```
sub-agent finishes
   └─ classify() asks: would this make the NEXT task faster or more correct?
        ├─ no  → dropped (no model call is spent on it)
        └─ yes → condensed to ONE line → stack (deduped, capped at 12)
   └─► next task starts with that stack injected + an empty context
```

Sub-agents run under `RpcClient`, so a finding can be pushed into a **run that is already working**
with `steer()` instead of restarting it. Every role boots with `--exclude-tools finisher_*`, so a
sub-agent can never re-enter the harness.

The classifier is the gate: **nothing is carried without a verdict.** pi ships classifier models
across many providers — a few examples:

| classifier | credential |
|---|---|
| `typesafe/jev-latest` | `TYPESAFE_API_KEY` |
| `cloudflare-workers-ai/@cf/cloudflare/clef(-flash)` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| `openrouter/typesafe/jev-1.14`, `opencode/jev-1.13` | that provider's key |

That table is **not** the list of what the harness accepts — it prefers `jev` first, then `clef`, and
otherwise takes whichever classifier `getAvailableOfType("classifier")` returns. With none available
the gate switches itself off: notes are dropped, no nagging, and the run continues.

There is no switch to turn the context reset off — it always happens at a task boundary.

## Coders prove their own slice

Each `finisher_swarm mode=code` slice gets its own git worktree **with your dependencies linked in**
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
report at the end lists them (`decisions made without asking you`) plus `.finisher/decisions.md`.

## Choosing the handoff model

The handoff gate needs a model; you pick it in the same ladder file as a slot of its own:

```json
{ "priority1": "anthropic/claude-sonnet", "handoff": "openai/gpt-5-mini" }
```

- **unset (default)** → the harness detects whichever classifier your providers expose and uses it; if you have none, handoff simply stays off — nothing to configure, no nagging
- a **classifier** model (for example `typesafe/jev-latest` or `cf/clef` — pi lists dozens from many providers) → uses `classify()`
- any **chat** model → asked `KEEP`/`DROP` with one short call

The `handoff` slot is never counted as a fan-out rung.

## Where the work happens

The agent writes **in your repo**. There is no shadow checkout to get lost in: what `finisher` edits is
what `git status` shows, so a review always looks at the same tree the agent worked in. The only
worktrees left are the per-slice ones that `finisher_swarm mode=code` gives each parallel coder, so
two coders can never overwrite each other; they are merged back deterministically by slice id.

Undo: There is no accept/discard command: when you want a change undone, ask the agent to undo it (or use
`git`). Nothing in the harness records a rollback point for you.

## Every tool call is bounded

A `bash` call that carries no `timeout` runs **forever** in pi — the tool simply waits. The harness
closes that hole for the main agent *and* for every sub-agent: a `tool_call` hook injects a deadline
whenever one is missing or invalid.

| call | bound |
|---|---|
| `bash` | injected if absent (default 900 s, override with `toolTimeoutMs` in `.finisher/config.json`) |
| `finisher_goal` / `finisher_swarm` / `finisher_steer` / `finisher_ask` | wrapped, reports `⏱ … exceeded its Ns limit` instead of hanging |
| every RPC call to a sub-agent (`start`, `promptAndWait`, `steer`, `getMessages`, …) | its own deadline |
| every `git` subprocess | 120 s, `SIGKILL` on expiry |

```json
{ "toolTimeoutMs": { "bash": 900000, "finisher_swarm": 1800000 } }
```

A broken config falls back to the default rather than failing a tool call.

## Rules the harness enforces on the result

- **No comments in code** (line or block); a load-bearing reason must carry
  `finisher-hygiene-allow: <why>`. Violations come straight back to the same turn.
- **A file stays at or under 500 lines** — split it instead of growing past that.
- **Tests are proof, not coverage** — a test that would pass with the logic broken is worse than none.

## Files

```
pi-finisher/
├── package.json                     # pi manifest
├── extensions/finisher/
│   ├── index.ts                     # pi wiring: hooks, tools, commands, TUI
│   └── src/                         # pure helpers (goal driver, swarm, verify loop, panel, …)
├── test/                            # node:test suites
└── themes/                          # Zense dark theme
```

Theme (optional): `/settings` → theme → `finisher`.
