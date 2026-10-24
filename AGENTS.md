# AGENTS.md — working effectively in this repo

pi-finisher: a **goal-confirm autonomous runner** shipped as a **pi extension** (`extensions/finisher/`) plus a dark theme (`themes/`). Confirm the goal once; the harness then fans work out over the model ladder, judges every case from executed evidence, drives fix→verify rounds, and reports once. Tests are plain `node:test` files importing the extension.

## Non-negotiable code rules

1. **No comments in code.** No `//` and no `/* */` in `.ts`/`.mjs`/`.sh`. Names and structure carry the intent. The only exception is a load-bearing reason that carries the marker `finisher-hygiene-allow: <why>` — a bare marker is itself a violation.
2. **Every file stays at or under 500 lines.** Split instead of growing. `extensions/finisher/index.ts` is a thin entry point (hooks + wiring) and must stay well under that.
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
   `grep -rn "^export .*<name>" extensions/finisher/src extensions/finisher/index.ts`
3. **Tests import named exports from the entry point** (`../extensions/finisher/index.ts`), which re-exports all of `src/`. Add new helpers to the right `src/` module and they are importable from `index.ts` automatically.
4. Source-guard tests must point at the file that actually owns the code (they were retargeted from `index.ts` to `src/gui.ts`, `src/tools.ts`, `src/commands.ts`, `src/panel-widget.ts`, `src/subagent-rpc.ts` in the splits) — never re-broaden them to `index.ts`.

## Repo map

| Path | Contents |
| --- | --- |
| `extensions/finisher/index.ts` | Entry point: the `HarnessContext` wiring, session hooks, the tool-timeout `tool_call` hook, hygiene `tool_result` check |
| `extensions/finisher/src/` | All helpers — one concern per file (map below) |
| `test/*.test.mjs` | `node:test` suites; named imports from the entry point; a few read module source for regression guards |
| `themes/` | The finisher dark theme (violet / cyan / mint on graphite) |
| `scripts/release.sh` | Release script (`npm run release`) |

## `extensions/finisher/src/` module map

| Module | What lives here |
| --- | --- |
| `types.ts` | Core interfaces (`Criterion`, `Spec`, `State`, `SubagentRun`, `Worktree`, `PendingApply`, `Tracker`) + `finisherDir` |
| `kit.ts` | `HarnessContext` — the shared plumbing type every kit receives |
| `state-box.ts` | Mutable state holder (`createStateBox`) so kits see one live `State` |
| `panel-widget.ts` | Wires the HUD into pi: `updateWidget` pushes a render component (pi supplies the real width) below the editor, deduped by `hudSignature`; the same component handles a **click**: a row opens that run's page (`openAgentSession`), the goal row (`GOAL_HIT`) opens the goal page (`openGoalPage`); `rescheduleTicker`, `widgetVisible`, `activeRun` |
| `goal-page.ts` | The goal page a click on the HUD's goal row opens (`GOAL_HIT`): `goalPageLines` (every lap, its mark, its own spent time), `goalPageTitle`/`goalPageSummary` (lap position + total goal clock), `goalPageWindow`/`goalPageMaxOffset` (a bounded, scrollable view), `GOAL_PAGE_KEYS` |
| `hud.ts` | Pure HUD: `hudFrames`/`hudLines` (framed box while a goal/agents are live, one idle line otherwise), `hudPaint` (palette by frame kind, text unchanged), `hudSignature` (change detection), `hudRowEntries`/`hudRows`, `hudRender`/`hudHitMap` (each painted line → the run index it draws, `GOAL_HIT` for the goal row), `boxTop`/`boxLine`/`boxBottom` |
| `agent-panel.ts` | Pure row rendering shared by the HUD and the tail viewer: `panelRowEntries`/`panelRows`/`panelLines`/`panelTickMs`, `clip`, `elapsedLabel`, `streamTail` |
| `subagent-launch.ts` | `launchSubagent`: one RPC sub-agent per role (timeout, cancel, live tail, model override) + handoff capture + provider-missing auto-heal |
| `subagent-config.ts` | Per-role sub-agent argv: exclude-tools, strip flags, timeouts, ext includes, provider diagnosis |
| `code-swarm.ts` | `runCodeSwarm`: one worktree per slice, coder run, hygiene gate, deterministic merge |
| `swarm.ts` | Scheduler: ladder reading (`priority`), `clampConcurrency`, `concurrencyFor` (says whether config/slots/tasks limited it), `pickSlot`, `readyTasks`/`runSwarm` (dependency-aware ready frontier, failover, blocked dependents, per-result timing), `swarmMetrics`/`metricsLine` |
| `swarm-code.ts` | Slice planning/ids, worker prompt, `FILES:` parse, overlap detection, merge plan |
| `swarm-plan.ts` | The plan-before-spawn contract: `readPlanSlices`, `planRefusals` (missing files, overlapping ownership, unknown/self/cyclic `depends_on`), `planOrder`/`blockedBy` for the dependency scheduler |
| `evidence.ts` | Reading a verifier's output: `extractCommands` (each command bound to *its own* exit status), `anchoredCommand` (a real command must sit at column 0 or after a `$`/`>` prompt), `pastedSource`/`statusInCode` (a numbered, tab-indented or code-shaped line supplies no status and lends none to a command above it), `cellExitCode`, `declaredVerdict`, `stripFences`/`unclaimedStatus` |
| `verify-loop.ts` | Evidence-gated verdicts (`judgeCase`), the bounded loop (`decideOnce`, `evidenceFingerprint`, `recordEvidence`, `MAX_LOOP_BATCHES`), report render — plus the `HUMAN` verdict (`humanOnly`: a case only the human can check is reported apart and never fails the run) and `repairableCases` (a case that merely named no command is a bounded fix lap, not a closed goal) |
| `verify-tool.ts` | `finisher_verify` — main-only verification: `detectChecks`/`runChecks` run the repo's own typecheck/lint/test first, `caseClaims`/`bindClaims` bind each claim to exactly one case (a truncated or re-spaced id still binds; an ambiguous or unknown one proves nothing) and `human: true` claims become the human-check list, `judgeDeterministic` judges each case from the harness recording, and the goal loop (`nextGoalDriverStep`, `armGoalRound`) is driven from here |
| `command-record.ts` | The harness recording of main's own shell calls: `recordedCommand`/`appendCommand` (normalised, bounded) — the evidence `finisher_verify` judges |

The workflow the harness enforces: `finisher_goal` (confirm once) → `finisher_phase` (declare the plan, close one lap at a time) → `finisher_swarm` for coders when the work really splits → `finisher_verify` once, after every lap is closed. Explore and planning are the main agent's own work; verification never spawns a child.
| `goal-driver.ts` | The confirmed-goal driver: finish / fix / stop, round bookkeeping — plus `goalGateFor`/`reopenGoal`: an unchanged goal resumes (and reopens when a verify round closed it) without a dialog and without a fresh round budget unless the human spoke after the close |
| `goal-phase.ts` | The lap plan: `declarePlan`/`appendPhases` (appending to a fully closed plan opens the first added lap)/`completeLap`, `lapLabel`, `allLapsDone`, and `verifyGate` (verify is refused while a lap is open) |
| `phase-tool.ts` | `finisher_phase` — declare the plan, close one lap at a time, read the plan |
| `evidence-record.ts` | The harness recording: `recordCall` (bash calls as they finish, with their real status), `finalStatus`/`recordedFailures`, `judgeChecks` (a case is proven only by the command named for it) |
| `lap-journal.ts` | The global extra-lap journal: `journalPath` (`~/.pi/finisher/laps.jsonl`), `gapRecord`/`doneRecord`, `parseJournal`/`readJournal`, `themeOf`, `summarizeGaps`/`summaryLines` |
| `race-state.ts` | Pure race read: `raceState` (phase/lap/lights/lap clock/total clock/pit time), `raceLoaderFrames`, `raceSegment` (the HUD's top border: mark + lights + `LAP n/m` + the clock of the whole goal, never a brand name), `raceIdleLine` (no name either), `clockLabel` |
| `goal-run.ts` | Surface + config contract (`SURFACE_TOOLS`, `readConfigSurface`, `surfaceLine`), ignored ceiling keys, and `readConfirmTimeout`/`DEFAULT_CONFIRM_TIMEOUT_MS`/`MAX_TIMER_MS` (the dialog deadline: env → config → 120s, `0` = wait forever) |
| `human-language.ts` | The human's language: `languageVote`/`scriptVotes` (the script the human actually typed decides), `languageTag`/`baseLang`/`scriptKey`/`resolveGoalLang` (a declared tag only refines within that script), `readableIn` + `goalLanguageNote` (a goal the human cannot read is refused, not confirmed), `languageGuideline` (the per-turn directive), `graphemes`/`breakGraphemes` (a line never breaks through a grapheme) |
| `system-prompt.ts` | Composition of the per-turn system prompt: `HARNESS_GUIDELINES` (hygiene, swarm routing, timeout, the human's language) + `harnessSystemPrompt(base, lang, bulletin)` — the host prompt first, the language directive last |
| `goal-confirm.ts` | Goal confirmation contract (`goalGate`, `goalCases`, `goalConfirmLines(goal, cases, lang, chrome)` + `goalChrome`/`cleanChrome` — the dialog chrome is the human's language, the goal and cases are never translated, the declined/no-UI/too-many-cases/unconfirmed-verify notes) plus the goal contract: `caseKey`, `humanTurnsFrom`/`consentBlocks` (a refusal blocks only the human turn that refused it) and the unchanged-goal/already-verified notes — a confirmed goal is never asked twice, only a CHANGED goal opens the dialog, and its cases are the agent's own plan |
| `goal-dialog.ts` | The confirm dialog the human actually sees: an inline overlay (no scrolling, so every case stays visible) with the goal + every case (y/enter confirms, n/esc declines), `ctx.ui.confirm` in non-TUI sessions, `unavailable` when a session has no dialog at all; `createGoalPicker` hands `askGoalConfirm` to the context |
| `code-hygiene.ts` | Comment/length scanner (string- and regex-aware) + the rule text given to agents |
| `test-quality.ts` | Filler-test detector (`no-assertion` / `tautology` / `shape-only`) used by the hygiene gate |
| `review-file.ts` | One written file's review: hygiene violations + weak tests in a single message |
| `hygiene-hook.ts` | The `tool_result` enforcement hook |
| `gui.ts` | TUI dialogs: `finisherCustom`, overlay sizes, `finisherPick`, ext-config checkbox, clarify questions |
| `viewers.ts` | The sub-agent session page: one page per run (task input + steers + live output), ←/→ paging, 1-9 jumps, ↑↓ scroll, tab strip of every agent, `openAgentSession`/`openAgentsViewer`, non-TUI text fallback — plus `openGoalPage`, the same overlay for the goal's own page (every lap wrapped in full, scrollable, non-TUI text fallback) |
| `agent-session.ts` | Pure paging + page text: `orderedSessionRuns`, `stepSessionIndex`, `sessionLabel`/`sessionTitle`/`sessionTabs`, `sessionBody`, `recordSteerOnRun`, `sessionSummaryLine` |
| `tools.ts` | `finisher_goal`, `finisher_swarm` (coders only — explore/verify are refused by name), `finisher_verify`, `finisher_steer` registration (every tool wrapped in a timeout bound) |
| `commands.ts` | `/finisher models` (ladder editor, `setSlot`, `ladderRows`, `ladderSummaryLine`), `/finisher gaps` (the extra-lap digest), and the `ctrl+_` live-tail shortcut |
| `worktree.ts` | Bounded `gitOk`, `excludeFromGitStatus`, `linkDeps` (slice deps), `excludeInWorktree` |
| `pending-apply.ts` | Cycle bookkeeping: `changePathsSince`, `discardSinceBaseline`, `commitWorkingTree` |
| `cycle.ts` | Cycle closure: `resetCycleState`, one-shot bulletins, `freshState` |
| `models.ts` | The model contract: `readLadderSlots`/`writeLadderSlot` (priority1..5), `resolveSubagentModel` (**ladder first, no per-role keys**), `ignoredModelKeys`, `availableModelChoices` (the virtual ladder model is filtered out), `panelize` |
| `esc-guard.ts` | Terminal-input ESC guard so dialogs close without aborting the agent |
| `handoff-stack.ts` | The cross-task knowledge stack: what survives a context reset (dedupe, cap, one-line condensation) |
| `handoff-classify.ts` | The keep/drop verdict (classifier or chat ask) |
| `handoff-model.ts` | The `handoff` ladder slot: read it, route it to classify() or an ask |
| `decisions.ts` | `DECISION NEEDED` capture + the report at goal done |
| `fullscreen.ts` | `tuiMode` default helper (was inside the deleted spec-changes) |
| `fresh-context.ts` | The boundary reset: `freshResetDecision` (fires once per closed goal, never on a plain reply), `freshLapDecision`/`lapBoundaryOpen` (fires once per closed lap — a lap with nothing closed yet is not a boundary), `lapCompactionSummary` (the directive + the tracker, capped so it cannot be clipped mid-tracker), `trackerEntryDraft`/`isTrackerEntry`, `lastUserEntryId` (keeps the human's tail), `shouldReset`, summary/directive, status line |
| `lap-tracker.ts` | The lap tracker that survives a cleared context: `buildLapTracker` (goal, cases, every lap with its `done`/`current`/`todo` state, the next laps, the latest status per recorded command), `stepWindow`/`renderLapTracker` (a bounded text that always leads with the goal and the lap position), `readLapTracker`/`writeLapTracker`/`clearLapTracker` at `.finisher/tracker.json` — written while a goal is open, removed the moment it closes |
| `subagent-rpc.ts` | `RpcClient` sub-agents: live registry, `steer`/`followUp` mid-run, timeout/abort, `toolEventFrom` (args + result, not just a name); the run waits on `waitForRun` (settle **or** child exit **or** deadline), auto-aborts, and always reports the child's stderr |
| `rpc-events.ts` | The wait contract behind a sub-agent run: `waitForRun` races `agent_settled` against a child-exit probe and the deadline, `childExitReason`, `outcomeLabel`, `exitEvent`/`isChildExitEvent`/`isSettledEvent`, `promptRefused` (a `handled` prompt started no run, so nothing must be waited on) |
| `tool-log.ts` | The sub-agent page's tool blocks: `toolTarget` (full command / path / pattern), `toolHeadline`, log encoding (`encodeToolEvent`), `parseLogItems` + `renderLogItems` (fold/unfold, bounded output) |
| `budget.ts` | One verify pass vs the tool cap: `effortFor` (verify always 1 attempt), `wavesFor`, `swarmWallMs`, `budgetFits`, `budgetNote` |
| `compaction-guard.ts` | `compactionHold`/`reportUnread`: an unread `halted`/`needs-human` report is never compacted away before the human replies |
| `handoff-gate.ts` | The handoff stack is parked: `HANDOFF_ENABLED = false`, `handoffStackFor` returns `[]`, `handoffInjectionFor` returns `undefined` |
| `subagent-log.ts` | Sub-agent log paths + `fmtTok` |
| `ladder-model.ts` | The `finisher/auto` virtual model that routes each request across the priority ladder |
| `timeout.ts` | The timeout rule: bash deadline injection, `withTimeout`/`settleWithTimeout`, `readToolTimeout` |

## Commands

- `npm test` — full suite. Single file: `node --no-warnings --test test/<file>.test.mjs`
- `npm run typecheck` — `tsc --noEmit` over the extension entry (checks all `src/` transitively)

## Conventions

- **Relative imports between TS modules carry explicit `.ts` extensions** (Node type-stripping in tests + jiti in pi both accept this; `typecheck` passes `--allowImportingTsExtensions`).
- **Kits receive one `HarnessContext`**; never import `index.ts` from `src/`.
- **Keep the entry point thin**: new behaviour belongs in a kit or a pure module, wired from `index.ts` in one line.
