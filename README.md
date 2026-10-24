# pi-finisher

> **Goal-confirm autonomous runner for pi.** You state the goal and confirm it once; the harness
> then spends every resource you have — many models at once, no token or cost ceiling — until the
> result is *proven*, and reports once at the end.

## The one loop

```
goal (confirmed once)
   └─ finisher_goal        confirm the goal + its cases, once
   └─ finisher_phase       declare the plan, then close one lap at a time: LAP 1/n → LAP n/n
   └─ finisher_swarm       code             (N coders at once, one git worktree each)
   └─ finisher_verify      verify           (ONE shot, refused while a lap is still open; main verifies)
   └─ a failing verify appends fix laps, never a fresh plan: the work and time already spent stay
   └─► ONE report: every case + its evidence, or an honest "not proven"
```

Nothing verifies itself from prose: the harness **records** every shell command you run and the
status it really got, and a case is proven only by the command you named for it. Verification is
deterministic first — your repo's own `typecheck`, `lint` and `test` scripts run before any case is
judged, and a failing check fails every case immediately.
Every extra lap is journaled to `~/.pi/finisher/laps.jsonl`; `/finisher gaps` ranks what was
missing most often, so the plan can be made better instead of guessed.

- **No gates.** No spec signing, no ADR approval, no review packet, no gate switch — nothing to
  click between the goal and the result.
- **A quiet HUD.** No cost counters, no warning tally, no brand name and no "total time" label: the
  top border is the lights, the lap position (`LAP 2/5`) and the clock of the whole goal; the idle line
  is the lights and the phase (and, for a finished goal, the total, the lap count and the pit split).
  Hygiene and trajectory findings still block or flag the work itself — they just never cost you a column.
- **The plan is one click away.** Click the goal row in the HUD and every lap opens in full — no lap
  text is ever truncated there — with the lap position and the total goal clock on its header.
- **No budget ceiling.** The run spends what the goal needs; it stops on *evidence*, not on cost.
- **Nobody answers, nothing starts.** Every goal dialog has a deadline
  (`confirmTimeoutMs` in `.finisher/config.json`, `FINISHER_CONFIRM_TIMEOUT_MS`, default 120s, `0` = wait
  forever). A timeout is a refusal: the run stops, complains once, and refuses any further `finisher_goal`
  until the human writes again — it never starts on a guess and never re-opens the dialog by itself.
- **The goal is the human's.** A goal and its case list can only change through the confirm dialog:
  the same goal with the same cases resumes silently, a new case list re-opens the dialog, and a
  declined or unavailable dialog leaves the confirmed goal byte-identical. A verify run can never
  name or re-case a goal, and an open plan is never replaced behind your back.
- **Evidence or it did not happen.** A case with no executed command is `UNVERIFIED`, never `PASS`.
  The loop is bounded: identical evidence stops it, rounds are counted.
- **Five models in parallel.** `priority1..priority5` in `.finisher/models.json` are the slots; the
  harness uses as many as you set, all at the same time.

## Quick start

```text
1. Tell the agent the goal                 → a confirm dialog: the goal + every case, y/enter = yes
2. Let it run                              → the widget shows every live agent side by side
3. Read the report                         → per case: PASS / FAIL / UNVERIFIED + the commands run
```

The dialog is the one gate and it always appears before a new goal starts: nothing runs on a goal
that was not confirmed. It shows the goal and **every** case in it — nothing is hidden behind a cap,
so the human is never asked to approve a list they cannot read; a list too long to weigh (more than
24 cases) is refused before anyone is shown anything. Declining (`n` / `Esc`) starts nothing and tells
the agent why; a session with no dialog at all (headless/print mode) is reported as unconfirmable
instead of self-confirming. A goal is asked once while it is open — the fix→verify rounds never
re-ask — and asked again once it has closed, because a finished goal's yes cannot start new work.

**The dialog speaks the human's language, not the agent's.** The script the human actually typed
(Thai, Japanese, Chinese, Korean, Arabic, Hebrew, Cyrillic, Devanagari, Greek) is detected on every
message and remembered; Latin text never overrides it, and a `lang` tag the agent passes only refines
it within the same script (`pt-BR` vs `es`). Every turn the system prompt names that language, so the
goal, the cases and the report are written in it — no translation step, no second copy of the goal to
drift from the evidence. The dialog chrome (title, header, note, key hints) comes from the agent's own
`chrome` strings in the same language, falling back to English. A goal that carries no letters of the
human's script is **refused before the dialog opens**, with a note telling the agent to write it again,
and long lines are wrapped between graphemes so a Thai or Devanagari mark is never orphaned.

## What you can call

| Tool | What it does |
|---|---|
| `finisher_goal` | Asks the human to confirm the goal and its cases once, then the driver owns the run: rounds, evidence, fix-or-stop, and one report at the end. `lang` + `chrome` make the dialog the human's language. |
| `finisher_steer` | Push a finding into a sub-agent that is still running — steer or follow-up, no restart. |
| `finisher_swarm` | **coders only**: one git worktree + branch per slice, merged back in dependency order, overlapping declared files never merged silently. Every slice names the `files` it owns and the `depends_on` slices it waits for. |
| `finisher_verify` | **main verifies itself**: it runs the repo's `typecheck`/`lint`/`test` scripts, then judges each case from the commands the harness recorded. No sub-agent is spawned to grade your work. |

Explore and planning are yours alone: read the files yourself and decide the slices, the files each
one owns and the interface they share (`shared_contract`). A plan that overlaps files, names an
unknown dependency or contains a cycle is refused **before any worktree is created**.

## Watching it run

One framed HUD, drawn below the editor and measured against the real terminal width (pi hands the
width to the render, so the box never overflows). While a goal is open or an agent is working it is a
box: one line for the goal, one row per live agent (tag, model, slot, elapsed, live tail). When
nothing is running it collapses to a single idle line, so a quiet session costs one row, not a panel.

```
╭─ ▚ ●●○○○ LAP 4/5 4:12 ─ 2 live · click a row · ctrl+_ pages                 ─╮
│ ▸ make the scheduler prove its bound, not assert it                          │
│ SWA   ▶ swarm slot1 provider/a 42s fixing the scheduler bound                │
│ SWA   ▶ swarm slot2 provider/b 41s reading src/swarm.ts                      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The top border is the whole race: the mark, the lane lights, the **lap position** (`LAP 2/5`) and the
**clock of the entire goal** — no brand name on it, and no "total time" wording anywhere. Below it is
the goal row, then one row per live agent.

Idle:

```
▚ ○○○○○ READY
```

A finished goal closes back to one line, keeping its total, the lap count and the pit split:

```
▚ ●●●●● P1 12:36 · 5 laps · pit 0:41
```

### The goal page

**Click the goal row** in the HUD and the whole plan opens — every lap in full, never truncated, with
the lap position and the total goal clock on the header. Lap marks are `✓` done, `▶` current, `·` todo;
`↑↓` scrolls, `PgUp/PgDn` pages, `g`/`G` jumps to the ends, `Esc` closes.

```
▚ LAP 4/5 4:12
3/5 laps closed · laps 3:11 · pit 1:01
make the scheduler prove its bound, not assert it
  ✓ 1/5  read the ladder and the scheduler  (0:32)
  ✓ 2/5  rewrite the retry policy so the bound holds  (2:00)
  ✓ 3/5  prove it with a command that can fail  (0:39)
  ▶ 4/5  wire the report
  · 5/5  close the goal
Esc close · ↑↓ scroll · PgUp/PgDn page · g/G top/bottom
```

A lap that has closed carries the time it spent in parentheses; the header keeps the position
(`LAP 4/5`) and the clock of the whole goal, the second line splits the run into laps, verify and pit.
A plan longer than the terminal pages instead of clipping: no lap text is ever cut in half.

### The report page

The moment a goal closes, `finisher_verify` writes the report it just gave you to
**`.finisher/report.md`** — verdict first, then the goal, the lap count, the round, when it was written,
and every case with the command that proved it. The HUD always advertises it: a `📄 report` row while a
closed goal is still boxed, and a tail on the idle line otherwise.

```
▚ ○○○○○ READY · 📄 report
╭─ ▚ ●●●●● P1 1:01 · 1 laps ─ 1 live · click a row ─╮
│ ▸ ship the report row                              │
│ 📄 report · verified · 2 laps · click to read      │
╰───────────────────────────────────────────────────╯
```

**Click it** and the whole file opens as a page — every line, wrapped rather than cut, `↑↓` scrolls,
`PgUp/PgDn` pages, `g`/`G` jumps to the ends, `Esc` closes. The page re-reads the file on every frame and
falls back to what is on disk, so a report written by an earlier session still offers itself with
nothing in memory; a file that has since been deleted says so instead of opening an empty page. While a
goal is still open there is no report yet, so the row is hidden rather than lying about one.

### One page per sub-agent

**Click a row in the HUD** (or press **`ctrl+_`**) and you are inside a sub-agent's own session — not a
status row: the **task it was given** (input), everything **steered into it** while it ran, and its
**live output** (model text, every tool call with its **full command**, and each tool's own output).
**`t`** folds or unfolds the tool output — the command itself is always on screen, so a folded page still
tells you exactly what the agent ran. **←/→** moves between sub-agents (live ones first, then finished
ones), **1-9** jumps straight to one, and the tab strip plus the header always say which one you are
looking at:

```
▚ sub-agent session — 2/3 · VERIFIER · ▶ 12s · provider/c · c2 · 1 steer
▚ pages 1:SWARM s1 provider/a ▶ · [2:VERIFIER c2 provider/c ▶] · 3:SWARM s3 ✓
.finisher/subagents/…-verifier.log • live — closing this page never interrupts the run
  ▸ task — what this agent was told
    prove case c1: the scheduler bound holds for every input
  ▸ steered (1) — what was pushed in while it ran
    → steer: the bound is 16, not 5
  ▸ session — live output · 3 tool call(s) · t = show tool output
  ────────────────────────
  reading src/swarm.ts
  ✓ bash — npm test -- swarm-scheduler 412ms
      ▸ 6 line(s) of output hidden — press t to show
  ✓ read — extensions/finisher/src/swarm.ts 22ms
      ▸ 1 line(s) of output hidden — press t to show
```

Press `t` and those blocks unfold in place:

```
  ✓ bash — npm test -- swarm-scheduler 412ms
      ℹ tests 8
      ℹ pass 8
      ℹ fail 0
  ✗ bash — npm run typecheck 903ms
      src/tools.ts(15,24): error TS2305: has no exported member
```

A tool call that failed is marked `✗`, a finished one `✓`, a live one `⚙` — and a large output keeps its
newest lines with `… N earlier line(s) hidden`, so one noisy command can never push the page off screen.

↑↓ scroll, `PgUp`/`PgDn` page, `g`/`G` jump, `t` folds tool output, `space` peeks at the chat, `Esc` closes — the agent keeps
running. Outside the TUI the same page degrades to a notification listing every agent with its task,
steer count and log path.

## Commands

| Command | What it does |
|---|---|
| `/finisher models` | set the **model priority ladder** (`priority1` … `priority5`) — there are no per-role overrides: every sub-agent auto-picks from the ladder |

There is nothing else to switch: fresh context, handoff and verification are automatic.

## Configuration

`.finisher/models.json` — the priority ladder. Rung 1 is what a sub-agent runs; later rungs are
failover, and a gap is skipped:

```json
{ "priority1": "anthropic/claude-sonnet", "priority2": "openai/gpt-5", "priority3": "google/gemini-pro" }
```

An explicit slot model (a swarm slot) outranks the ladder; with no ladder at all a sub-agent falls
back to the main session model. A leftover per-role key (`swarm`, `verifier`, …) never selects a
model any more — it is reported as ignored.

`.finisher/config.json`

```json
{ "swarmConcurrency": 5, "subagentTimeoutMs": { "default": 1200000 }, "freshContext": true }
```

Unset slots are simply not used; there is no ceiling key anywhere — if one is present it is
reported as ignored, never obeyed.

## Verification runs once, at the end

`finisher_verify` is not a loop. After the implementation loops are done, it runs **once**, in two
stages:

1. **deterministic** — the repo's own `typecheck`, `lint` and `test` scripts run with a real
   deadline and a real exit code. A failing check fails every case straight away, so no model is
   spent re-reading what the exit code already said.
2. **evidence** — each case must name the command that exercises it. A case whose command the
   harness never watched succeed is `UNVERIFIED`, never `PASS`. A green suite alone proves nothing.

| outcome | what happens |
|---|---|
| every case holds | one report, done |
| a case failed | the main agent gets the next loop back: fix it, use `finisher_swarm` to get coders working in parallel, then verify again (bounded, then it halts) |
| no command can prove a case | it says so and hands that case to you instead of guessing |

A verify run **never creates a goal**. If no confirmed goal is open, it reports its evidence and
says so — it cannot mark a goal confirmed, so verifying first is never a way around the dialog.

## Fresh context and the handoff stack

A context reset happens at exactly one moment: when a **confirmed goal closes** (`agent_before_settle`
→ one compaction entry, only once per goal). Asking the agent a question, getting an answer, or any
other reply that is not the end of a goal run never compacts anything — the transcript you just read
stays there.

When a goal does close, the compaction keeps every entry from the **last user message onward**, so the
request and the report that answered it remain readable (and in context) while the noisy middle is
summarized. Everything before that is replaced by the handoff stack below.

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

There is no switch to turn the context reset off — it fires once per closed goal, and never on a plain
reply.

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
| `finisher_goal` / `finisher_swarm` / `finisher_steer` | wrapped, reports `⏱ … exceeded its Ns limit` instead of hanging |
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
└── themes/                          # finisher dark theme (violet / cyan / mint on graphite)
```

Theme (optional): `/settings` → theme → `finisher`.
