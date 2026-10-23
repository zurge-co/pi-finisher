# AGENTS.md — working effectively in this repo

pi-zense: a **goal-confirm autonomous runner** shipped as a **pi extension** (`extensions/zense-harness/`) plus a dark theme (`themes/`). Confirm the goal once; the harness then fans work out over the model ladder, judges every case from executed evidence, drives fix→verify rounds, and reports once. Tests are plain `node:test` files importing the extension.

## Non-negotiable code rules

1. **No comments in code.** No `//` and no `/* */` in `.ts`/`.mjs`/`.sh`. Names and structure carry the intent. The only exception is a load-bearing reason that carries the marker `zense-hygiene-allow: <why>` — a bare marker is itself a violation.
2. **Every file stays at or under 500 lines.** Split instead of growing. `extensions/zense-harness/index.ts` is a thin entry point (hooks + wiring) and must stay well under that.
3. **Tests are proof, not coverage.** Write the few that establish a real property — a bound holds for every input, an ordering is total, a boundary is exact, an invariant survives. A test that would still pass with the logic broken is worse than no test. Do not add ceremony assertions to raise the count.
4. After any edit: `npm run typecheck && npm test`. Both are fast. `test/module-budget.test.mjs` and `test/no-comments.test.mjs` enforce rules 1–2 on the real tree.

## How the harness is put together

`index.ts` builds one `HarnessContext` (see `src/kit.ts`) holding the shared plumbing — state box, `persist`, `learn`/`flag`/`escalate`, and the cross-module functions — then hands that same object to each kit:

```
index.ts  →  createGui / createViewers / createPanelWidget / createSubagentLaunch
          →  createCodeSwarm / createSpecFlow / createHygieneHook
          →  registerTools / registerCommands
```

Each `create…` returns its public members; `index.ts` assigns them back onto the context with `Object.assign`, so a kit may use anything a previous kit provided. Session hooks (`session_start`, `tool_call`, `before_agent_start`, `turn_end`, `agent_end`) stay in `index.ts` — that is the only thing it should contain besides the wiring.

## Golden rules for exploration (read code cheaply)

1. **Do not read `index.ts` end-to-end** — it is wiring. Find the concern in the module map and read that one file; every module is sized to fit in a single read.
2. **Find a symbol by grepping, then read only the owning module:**
   `grep -rn "^export .*<name>" extensions/zense-harness/src extensions/zense-harness/index.ts`
3. **Tests import named exports from the entry point** (`../extensions/zense-harness/index.ts`), which re-exports all of `src/`. Add new helpers to the right `src/` module and they are importable from `index.ts` automatically.
4. Source-guard tests must point at the file that actually owns the code (they were retargeted from `index.ts` to `src/gui.ts`, `src/tools.ts`, `src/commands.ts`, `src/panel-widget.ts`, `src/subagent-rpc.ts` in the splits) — never re-broaden them to `index.ts`.

## Repo map

| Path | Contents |
| --- | --- |
| `extensions/zense-harness/index.ts` | Entry point: the `HarnessContext` wiring, session hooks, worktree redirect, hygiene `tool_result` check |
| `extensions/zense-harness/src/` | All helpers — one concern per file (map below) |
| `test/*.test.mjs` | `node:test` suites; named imports from the entry point; a few read module source for regression guards |
| `themes/` | Zense dark theme |
| `scripts/release.sh` | Release script (`npm run release`) |

## `extensions/zense-harness/src/` module map

| Module | What lives here |
| --- | --- |
| `types.ts` | Core interfaces (`Criterion`, `Spec`, `State`, `SubagentRun`, `Worktree`, `PendingApply`, `Tracker`) + `zenseDir` |
| `kit.ts` | `HarnessContext` — the shared plumbing type every kit receives |
| `state-box.ts` | Mutable state holder (`createStateBox`) so kits see one live `State` |
| `panel-widget.ts` | The live widget: `updateWidget` (status line + one row per running agent), `rescheduleTicker`, `applyRedirect` into the session worktree |
| `agent-panel.ts` | Pure panel rendering: `panelRows`/`panelLines`/`panelTickMs`, `clip`, `elapsedLabel`, `streamTail` |
| `subagent-launch.ts` | `launchSubagent`: one RPC sub-agent per role (timeout, cancel, live tail, model override) + handoff capture + provider-missing auto-heal |
| `subagent-runner.ts` | `runSubagent`: spawn `pi --mode json`, stream/kill/timeout, JSONL log under `.zense/subagents/` (+ `fmtTok`) |
| `subagent-config.ts` | Per-role sub-agent argv: exclude-tools, strip flags, timeouts, ext includes, provider diagnosis |
| `code-swarm.ts` | `runCodeSwarm`: one worktree per slice, coder run, hygiene gate, deterministic merge |
| `swarm.ts` | Scheduler: ladder reading (`priority`), `clampConcurrency`, `pickSlot`, `runSwarm` retry/failover |
| `swarm-code.ts` | Slice planning/ids, worker prompt, `FILES:` parse, overlap detection, merge plan |
| `verify-loop.ts` | Evidence-gated verdicts (`judgeCase`), bounded rounds (`nextVerifyRound`), report render |
| `goal-driver.ts` | The confirmed-goal driver: finish / fix / stop, round bookkeeping |
| `goal-run.ts` | Surface + config contract (`SURFACE_TOOLS`, `readConfigSurface`, `surfaceLine`), ignored ceiling keys |
| `goal-confirm.ts` | Goal confirmation contract (`goalGate`, `goalCases`, the one-shot confirm prompt) |
| `code-hygiene.ts` | Comment/length scanner (string- and regex-aware) + the rule text given to agents |
| `hygiene-hook.ts` | The `tool_result` enforcement hook |
| `gui.ts` | TUI dialogs: `zenseCustom`, overlay sizes, `zensePick`, ext-config checkbox, clarify questions |
| `viewers.ts` | Live sub-agent tail viewer + `openAgentsViewer` |
| `tools.ts` | `zense_ask`, `zense_swarm`, `zense_goal` registration |
| `commands.ts` | `/zense …` command + per-role ext-config commands, `runDistill`, `resumeZense` |
| `spec-flow.ts` | `commitSpec`, `approveCurrentSpec`, pending-apply accept |
| `spec-changes.ts` | Spec diff → change summary, spec markdown, `syncApprovedSpecFiles`, `applyFullscreenDefault` |
| `worktree.ts` | Git worktree isolation: path/command rewrite, `gitOk`, create/reuse, git exclude |
| `pending-apply.ts` | Apply-back: commit/snapshot messages, `applyWorktreeBack`, `discardPendingApply`, `acceptPendingApply` |
| `resume.ts` | `/zense resume` disk discovery |
| `cycle.ts` | Cycle closure: `resetCycleState`, one-shot bulletins, `freshState` |
| `evidence.ts` | Check probes, repo facts, git change summary, `lintSpecChecks` |
| `eval-review.ts` | Grader/reviewer contracts (still used by the verify path's prompts) |
| `spec-draft.ts` | Requirements-output parsing + quality gate (used by the compile path) |
| `memory.ts` | `memory.jsonl` summary + `/zense distill` |
| `models.ts` | Per-role model config, picker choices, `panelize` |
| `esc-guard.ts` | Terminal-input ESC guard so dialogs close without aborting the agent |
| `adr-deny.ts` | ADR `DENY:` parsing (kept; no longer on the write path) |
| `decompose.ts` | Planner subtasks / draft merge (kept for the compile path) |
| `ask.ts` | `zense_ask` policy scanning + answer formatting |
| `handoff-stack.ts` | The cross-task knowledge stack: what survives a context reset (dedupe, cap, one-line condensation) |
| `handoff-classify.ts` | `classify()` keep/drop verdict + LLM condensation for the items it keeps |
| `fresh-context.ts` | The task-boundary reset: config switch, retain-none summary, status line |
| `subagent-rpc.ts` | `RpcClient` sub-agents: live registry, `steer`/`followUp` mid-run, timeout/abort |
| `subagent-log.ts` | Sub-agent log paths + `fmtTok` |
| `ladder-model.ts` | The `zense/auto` virtual model that routes each request across the priority ladder |
| `timeout.ts` | The timeout rule: bash deadline injection, `withTimeout`/`settleWithTimeout`, `readToolTimeout` |

## Commands

- `npm test` — full suite. Single file: `node --no-warnings --test test/<file>.test.mjs`
- `npm run typecheck` — `tsc --noEmit` over the extension entry (checks all `src/` transitively)

## Conventions

- **Relative imports between TS modules carry explicit `.ts` extensions** (Node type-stripping in tests + jiti in pi both accept this; `typecheck` passes `--allowImportingTsExtensions`).
- **Kits receive one `HarnessContext`**; never import `index.ts` from `src/`.
- **Keep the entry point thin**: new behaviour belongs in a kit or a pure module, wired from `index.ts` in one line.
