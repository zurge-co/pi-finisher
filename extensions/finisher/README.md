# finisher

The pi extension behind **pi-finisher**: state the goal once, and the run finishes on its own.

```
goal (confirmed once)
  → lap                     the plan, then one lap closed at a time
  → code                    2+ CODER sub-agents at once, one model per ladder slot, one worktree each
  → verify                  once, at the end: the repo's own checks plus the command named per case
  → goal driver             pass → one report · fail → fix laps · unprovable → tell the human
  → context reset           once, when a lap closes, so the next one starts clean
```

## What it gives the model

| Tool | What it does |
|---|---|
| `goal` | The single confirmation. After that the driver owns the run and reports once at the end. |
| `lap` | Declare the plan, close one lap at a time, read the plan back. `verify` is refused while a lap is open. |
| `verify` | Main verifies itself: the repo's checks through a scoped/cached plan, then one recorded command per case, written to `.finisher/checks`. |
| `code` | CODER sub-agents only: one git worktree + branch per slice, dependencies linked in, merged in slice-id order, overlapping paths never merged silently. Explore and verify are yours alone, so this tool refuses them by name. |
| `steer` | Push a finding into a sub-agent that is still running — no restart. |

There is no tool that asks a human. A worker that hits a fork writes
`DECISION NEEDED: <question>` plus `assumption: <what it chose>`, continues, and the harness collects
those for the single report at the end (also written to `.finisher/decisions.md`).

## Watching an agent work

The HUD under the editor lists one row per live sub-agent. A row is a doorway to that agent's own page:

- **click a row** (fullscreen TUI) or press **`ctrl+_`** — opens the page of that agent, or of the
  first live one when nothing was clicked.
- **←/→** switch agent without closing the page, **1-9** jump straight to one, and the tab strip at the
  top lists every agent with the current one in brackets, so the page always says whose screen it is
  (`2/3 · CODER · ▶ 1m05s · s2 · syn/large`).
- The page itself holds the three things a run is made of: the **task** the sub-agent was given, every
  **steer/follow-up** pushed into it (also appended into its log at the moment it lands), and the
  **live output** (tail-following, scrollable with `g`/`G`/PgUp/PgDn). `Esc` closes the page; the agent
  keeps running either way.

Fan-out work runs as the `coder` role, so the row tag and the page label always say which kind of
agent is on screen (`CODER`, `CODER2`, …). Verification is not an agent at all — you run it yourself.
Outside the TUI the same information degrades to a notification with each agent's task, steer count
and log path.

## Command

`/finisher models` — set the model **priority ladder** (`priority1` … `priority5`). Sub-agents auto-pick
the highest rung that is set; there are no per-role overrides any more, and an old role key is
reported as ignored instead of quietly selecting a model.
Everything else (fresh context, handoff, verification) is automatic; there is nothing to switch.
A plain question-and-answer never compacts: the reset fires once when a confirmed goal closes, and keeps
every entry from the last user message onward so the request and the report stay readable.

## Isolation and speed

- Sub-agents run in the real repo (`ctx.cwd`), as RPC child processes with their own session.
  They boot with `PI_FINISHER_SUBAGENT=1`, which loads only the tool-timeout rule, never the harness.
- Code slices each get their own worktree with `node_modules` symlinked from the repo, so a coder can
  run the project's tests immediately instead of installing anything. A coder must end with
  `TESTS: PASS|FAIL|SKIP` plus `FILES:`; a `FAIL` comes straight back to that coder.
- Every tool call is bounded: `bash` gets a deadline injected, `goal`/`lap`/`code`/`verify`/`steer` are wrapped, every
  RPC call has its own timeout, and every `git` subprocess is capped.

## Files

State lives under `.finisher/` (`handoff.jsonl`, `decisions.md`, `subagents/*.log`, `worktree/`, plus
`models.json` / `config.json`). Session state is persisted with `pi.appendEntry("finisher-state", …)`
and restored on resume.

Every source module stays at or under 500 lines and carries no code comments — both are enforced by
`test/module-budget.test.mjs` and `test/no-comments.test.mjs`.
