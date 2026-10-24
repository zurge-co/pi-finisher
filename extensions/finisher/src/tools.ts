import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildGoalToolText, goalDriverDone, goalKey, nextGoalDriverStep, resumeOrStart, type GoalRunState } from "./goal-driver.ts";
import { costCeilingKeysPresent, readConfirmTimeout, surfaceLine } from "./goal-run.ts";
import { GOAL_CHANGE_NOTE, GOAL_CONSENT_WAIT_NOTE, GOAL_DECLINED_NOTE, GOAL_NO_UI_NOTE, GOAL_TIMEOUT_NOTE, GOAL_TOO_MANY_CASES, NON_GOAL_PREFIX, casesOnlyChanged, droppedCases, goalCases, sameCaseSet, tooManyCasesNote, unconfirmedGoalNote, type GoalAskOutcome } from "./goal-confirm.ts";
import { type ArmGoalRound, type LaunchSubagent, type Persist, type RunCodeSwarm, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { effectiveLadder, concurrencyFor, swarmSlots, swarmSummaryLine, buildFanOutPrompt, readModelLadder, type FanOutArgs, type SwarmTask, type SwarmSlot, runSwarm } from "./swarm.ts";
import { buildReport, freshAttempts, judgeCase, repairNote, renderVerifyReport, unusableCases } from "./verify-loop.ts";
import { judgeRecording, type RecordedCall, type RecordedVerdict } from "./evidence-record.ts";
import { type CaseEvidence } from "./verify-loop.ts";
import { appendRecord, doneRecord, gapRecord, journalEnabled, journalPath } from "./lap-journal.ts";
import { gitOk } from "./worktree.ts";
import { type State } from "./types.ts";
import { headOf } from "./pending-apply.ts";
import { reportWithDecisions, writeDecisionsFile } from "./decisions.ts";
import { clearOtherGoals } from "./handoff-stack.ts";
import { handoffOff } from "./handoff-gate.ts";
import { boundWrapper, withTimeout, readToolTimeout, timeoutNote, TOOL_TIMEOUT_LABEL } from "./timeout.ts";
import { budgetNote, capNeededFor, effortFor, SWARM_TOOL, wavesFor } from "./budget.ts";
import { subagentTimeout } from "./subagent-config.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { liveByRole, steerLive, followUpLive } from "./subagent-rpc.ts";
import { recordSteerOnRun } from "./agent-session.ts";
import { planOf, verifyGate } from "./goal-phase.ts";
import { registerPhaseTool } from "./phase-tool.ts";

export const roleForMode = (mode: "explore" | "verify" | "code"): "swarm" | "verifier" => (mode === "verify" ? "verifier" : "swarm");

export const registerTools = (ctx: HarnessContext) => {
	const persist = ctx.persist;
	const pi = ctx.pi;
	const state = ctx.state;
	const updateWidget = ctx.updateWidget;
	const escalate = ctx.escalate;
	const launchSubagent = ctx.launchSubagent;
	const runCodeSwarm = ctx.runCodeSwarm;
	const armGoalRound = ctx.armGoalRound;
	const askGoalConfirm = ctx.askGoalConfirm;

	registerPhaseTool(ctx);

	const repairReports = async <T,>(
		results: { id: string; ok: boolean; output: string }[],
		tasks: SwarmTask<T>[],
		fan: FanOutArgs,
		slots: SwarmSlot[],
		concurrency: number,
		judged: (id: string, output: string, ok: boolean) => CaseEvidence,
		runOne: (promptFor: (task: SwarmTask<T>, attempt: number) => string) => (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => Promise<{ ok: boolean; output: string }>,
	): Promise<void> => {
		const judgeAll = () => buildReport(results.map((r) => judged(r.id, r.output, r.ok)));
		const unusable = unusableCases(judgeAll());
		if (!unusable.length) return;
		const ids = new Set(unusable.map((c) => c.caseId));
		const retryTasks = tasks.filter((t) => ids.has(t.id));
		if (!retryTasks.length) return;
		const note = repairNote(unusable, boundWrapper());
		const again = await runSwarm(retryTasks, {
			slots,
			concurrency,
			maxAttempts: 1,
			stopOnDeclaredAnswer: true,
			run: runOne((task) => `${buildFanOutPrompt(fan, task.payload as { id: string; instruction: string }, 2)}\n\n${note}`),
		});
		for (const r of again) {
			const at = results.findIndex((x) => x.id === r.id);
			if (at >= 0) results[at] = { ...results[at], ok: r.ok, output: r.output };
		}
	};

	const capFor = (name: string, configured: number, cwd: string, params: unknown): number => {
		if (name !== SWARM_TOOL) return configured;
		const p = params as { mode?: "explore" | "verify" | "code"; subtasks?: unknown[]; maxAttempts?: number } | undefined;
		const mode = p?.mode ?? "explore";
		const tasks = Array.isArray(p?.subtasks) ? p.subtasks.length : 0;
		const { ladder } = effectiveLadder(cwd);
		const spread = concurrencyFor(cwd, swarmSlots(ladder).length, tasks);
		const needed = capNeededFor({ subagentMs: subagentTimeout(roleForMode(mode), cwd), attempts: effortFor(mode, p?.maxAttempts), waves: wavesFor(tasks, spread.concurrency) });
		return Math.max(configured, needed);
	};

	const boundedTool = <TParams extends TSchema, TDetails, TState>(def: ToolDefinition<TParams, TDetails, TState>): ToolDefinition<TParams, TDetails, TState> => ({
		...def,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
			const configured = readToolTimeout(cwd, def.name);
			const r = await withTimeout(Promise.resolve(def.execute(toolCallId, params, signal, onUpdate, ctx)), capFor(def.name, configured, cwd, params), TOOL_TIMEOUT_LABEL(def.name));
			if (!r.timedOut) return r.value as never;
			return { content: [{ type: "text", text: timeoutNote(r) }], details: { timedOut: true, tool: def.name }, isError: true } as never;
		},
	});

	pi.registerTool(boundedTool({
		name: "finisher_swarm",
		label: "finisher · swarm",
		description:
			"Run several sub-agents AT THE SAME TIME on your configured model ladder (priority1..priority5 in .finisher/models.json, capped by swarmConcurrency). mode=explore fans a goal out into read-only research slices; mode=verify sends independent verifiers that must prove the goal with real commands; mode=code gives every slice its OWN git worktree + branch so coders write in parallel without touching each other, then merges back in deterministic slice-id order and refuses to merge silently when two slices touched the same path. No token/cost ceiling.",
		promptSnippet: "Fan out parallel sub-agents across the model priority ladder (explore / verify / code in isolated worktrees)",
		promptGuidelines: [
			"The workflow is: finisher_goal (confirm once) → finisher_phase plan=[...] → finisher_phase done for each lap in order → finisher_swarm mode=verify exactly once.",
			"Never call finisher_swarm mode=verify while a lap is still open — it is refused, because verification is one shot at the end of the plan, not per lap.",
			"Use finisher_swarm explore when a goal needs many independent reads (survey, locate, compare) — gives back one merged report instead of serial sub-agent turns.",
			"Use finisher_swarm verify to prove the result against reality: each verifier must RUN commands and end with VERDICT: PASS/FAIL. A claim with no executed command is UNVERIFIED, never PASS. The loop is bounded — fix the real cause and call verify again; identical evidence stops it.",
			"Treat a worker's report as the evidence: do not re-read the files it read, do not re-run the commands it ran, and for verify never re-check a case a verifier already judged — its verdict and its commands are final for that case.",
			"Use finisher_swarm code when the change splits into independent slices: each coder gets its own worktree, so give every slice its scope and let them all run at once. Slices that need the same file must be one slice — overlapping paths are blocked and reported, never merged silently.",
			"Decide library/layout/approach yourself — do not ask the human.",
		],
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("explore"), Type.Literal("verify"), Type.Literal("code")] as const),
			goal: Type.Optional(Type.String({ description: "the outcome the whole fan-out serves (verifiers judge against exactly this)" })),
			subtasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "short stable id, unique within the call (e.g. s1) — used verbatim in the worker's worktree and branch, so lowercase letters/digits/-/_ only" }),
					instruction: Type.String({ description: "self-contained slice: that worker sees only this text" }),
					scope: Type.Optional(Type.Array(Type.String(), { description: "repo-relative paths this slice may touch — two slices sharing a path are a conflict, so split differently" })),
				}),
				{ description: "1–8 independent slices — they run concurrently, so none may depend on another" },
			),
			maxAttempts: Type.Optional(Type.Integer({ description: "attempts per slice before it counts as failed (default 2)" })),
		}),
		async execute(_id, p, sig, _on, ctx) {
			if (!p.subtasks.length) return { content: [{ type: "text", text: "finisher_swarm: subtasks must contain at least one slice" }], details: {}, isError: true };
			if (p.mode === "verify") {
				const gate = verifyGate(planOf(state.goalDriver as { phases?: never; lap?: number } | undefined));
				if (!gate.allowed) return { content: [{ type: "text", text: gate.note }], details: { gated: true }, isError: true };
			}
			if (p.subtasks.length > 8) return { content: [{ type: "text", text: `finisher_swarm: at most 8 slices per call (got ${p.subtasks.length}) — split into several calls` }], details: {}, isError: true };
			const ids = new Set<string>();
			for (const s of p.subtasks) {
				if (!s.id.trim() || ids.has(s.id)) return { content: [{ type: "text", text: `finisher_swarm: subtask id "${s.id}" is empty or duplicated` }], details: {}, isError: true };
				ids.add(s.id);
			}
			const mainPattern = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const { ladder, source } = effectiveLadder(ctx.cwd, mainPattern);
			const slots = swarmSlots(ladder);
			if (!slots.length)
				return {
					content: [{ type: "text", text: "finisher_swarm: no model to run — set priority1..priority5 in .finisher/models.json (each a pi model pattern like \"provider/model\"), or run the swarm from a session whose model resolves; it uses as many slots as are set" }],
					details: { missingLadder: true },
					isError: true,
				};
			const spread = concurrencyFor(ctx.cwd, slots.length, p.subtasks.length);
			const concurrency = spread.concurrency;
			const effort = effortFor(p.mode, p.maxAttempts);
			const budget = budgetNote({
				toolCapMs: readToolTimeout(ctx.cwd, SWARM_TOOL),
				subagentMs: subagentTimeout(roleForMode(p.mode), ctx.cwd),
				attempts: effort,
				waves: wavesFor(p.subtasks.length, concurrency),
			});
			const notes = costCeilingKeysPresent(ctx.cwd).length ? ` ⚠ ignored ceiling key(s): ${costCeilingKeysPresent(ctx.cwd).join(", ")}` : "";
			const recorded = new Map<string, { calls: RecordedCall[]; verdict?: RecordedVerdict }>();
			const runOne = <T,>(promptFor: (task: SwarmTask<T>, attempt: number) => string) => async (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => {
				if (sig?.aborted) return { ok: false, output: "cancelled by user (Esc)" };
				const before = state.subagentRuns.length;
				const pending = launchSubagent(ctx, roleForMode(p.mode), promptFor(task, attempt), undefined, sig, slot.model, { caseId: task.id });
				const started = state.subagentRuns[before];
				if (started) started.slotId = slot.id;
				const r = await pending;
				recorded.set(task.id, { calls: r.calls ?? [], ...(r.verdict ? { verdict: r.verdict } : {}) });
				return { ok: r.ok, output: r.ok ? r.output : `${r.output}\n(log: ${r.logPath})` };
			};
			const treeState = (): string =>
				gitOk(["status", "--porcelain"], ctx.cwd)
					.out.split("\n")
					.map((line) => line.trim())
					.filter((line) => line && !line.includes(".finisher/"))
					.join("\n");
			const treeBefore = p.mode === "verify" ? treeState() : "";
			const judgedCase = (id: string, output: string, ok: boolean) => {
				if (p.mode !== "verify") return judgeCase(id, output, ok ? {} : { exitCode: 1 });
				const rec = recorded.get(id);
				if (!rec)
					return ok
						? { caseId: id, verdict: "UNVERIFIED" as const, commands: [], reason: "the harness recorded nothing for this case — a verdict without a recording proves nothing" }
						: { caseId: id, verdict: "BLOCKED" as const, commands: [], reason: "the verifier run did not finish — nothing was exercised" };
				const treeAfter = treeState();
				if (treeAfter !== treeBefore)
					return { caseId: id, verdict: "BLOCKED" as const, commands: [], reason: "the verifier changed the working tree — a verifier must not write into the repo, so its run is not evidence. Run the same check again from a clean tree." };
				const verdict = judgeRecording(rec.calls, rec.verdict);
				return { caseId: id, verdict: verdict.verdict, commands: [], ...(verdict.reason ? { reason: verdict.reason } : {}) };
			};
			if (p.mode === "code") return await runCodeSwarm(ctx, p.subtasks, { slots, concurrency, maxAttempts: effort, goal: p.goal, sig, ladder, source, notes });
			const fan: FanOutArgs = { mode: p.mode, subtasks: p.subtasks.map((s: { id: string; instruction: string }) => ({ id: s.id.trim(), instruction: s.instruction })), ...(p.goal?.trim() ? { goal: p.goal.trim() } : {}), boundHint: boundWrapper() };
			const tasks = fan.subtasks.map((s) => ({ id: s.id, payload: s }));
			const results = await runSwarm(tasks, {
				slots,
				concurrency,
				maxAttempts: effort,
				stopOnDeclaredAnswer: p.mode === "verify",
				run: runOne((task, attempt) => buildFanOutPrompt(fan, task.payload!, attempt)),
			});
			if (p.mode === "verify") await repairReports(results, tasks, fan, slots, concurrency, judgedCase, runOne);
			const failed = results.filter((r) => !r.ok);
			const body = results
				.map((r) => `## ${r.id} ${r.ok ? "✓" : "✗"}${r.model ? ` [${r.model}]` : ""}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ""}\n${r.output.trim() || "(no output)"}`)
				.join("\n\n");
			if (p.mode === "verify") {
				const report = buildReport(results.map((r) => judgedCase(r.id, r.output, r.ok)));
				const active = state.goalDriver as GoalRunState | undefined;
				const openGoal = !!active && !goalDriverDone(active);
				const verified = `${NON_GOAL_PREFIX}${report.cases.map((c) => c.caseId).join(", ") || "run"}`;
				const driver = active && !active.doneAt ? active : { ...resumeOrStart(undefined, p.goal?.trim() || verified), attempts: freshAttempts() };
				const step = nextGoalDriverStep(driver, report);
				if (!openGoal) {
					persist();
					updateWidget(ctx);
					const summary = buildReport(report.cases);
					return {
						content: [{ type: "text", text: ["verify-only run: " + driver.goal, "", unconfirmedGoalNote(summary.allPass), "", step.text, "", body].join("\n") }],
						details: { mode: p.mode, report, verifiedOnly: true, effort, budget: budget ?? null, results },
						...(summary.allPass ? {} : { isError: true }),
					};
				}
				const finalText = reportWithDecisions(step.text, state.decisions ?? []);
				if (step.action === "finish" || step.action === "human" || step.action === "halt") writeDecisionsFile(ctx.cwd, driver.goal, state.decisions ?? []);
				const before = state.goalDriver as GoalRunState;
				state.goalDriver = step.state;
				persist();
				updateWidget(ctx);
				if (journalEnabled()) {
					const journal = journalPath();
					const plan = (state.goalDriver as GoalRunState).phases ?? [];
					if (step.action === "replan")
						appendRecord(
							journal,
							gapRecord({
								repo: ctx.cwd,
								goal: driver.goal,
								round: step.round,
								lap: Math.min(plan.length, Math.max(1, state.goalDriver.lap ?? 1)),
								laps: plan.length,
								added: plan.slice((before.phases ?? []).length).map((p) => p.text),
								cases: report.cases.map((c) => ({ id: c.caseId, verdict: c.verdict, ...(c.reason ? { reason: c.reason } : {}) })),
								models: results.map((r) => r.model),
								outcome: step.action,
							}),
						);
					if (step.action === "finish" || step.action === "human" || step.action === "halt")
						appendRecord(
							journal,
							doneRecord({
								repo: ctx.cwd,
								goal: driver.goal,
								rounds: step.round,
								laps: plan.length,
								outcome: step.state.outcome ?? "halted",
							}),
						);
				}
				if (step.action === "replan") armGoalRound(step.text);
				return {
					content: [{ type: "text", text: [buildGoalToolText(driver, step, finalText), ...(budget ? ["", budget] : []), "", body].join("\n") }],
					details: { mode: p.mode, report, decision: { kind: step.action }, step: step.action, outcome: step.state.outcome, effort, budget: budget ?? null, results },
					...(report.allPass ? {} : { isError: true }),
				};
			}
			return {
				content: [{ type: "text", text: `${swarmSummaryLine(results)} (concurrency ${concurrency})\n${budget ? `${budget}\n` : ""}\n${body}${failed.length ? `\n\n⚠ ${failed.length} slice(s) failed — re-run just those slices or do them yourself` : ""}` }],
				details: { mode: p.mode, concurrency, concurrencySource: spread.source, effort, budget: budget ?? null, results },
				...(failed.length ? { isError: true } : {}),
			};
		},
	}));

	pi.registerTool(boundedTool({
		name: "finisher_goal",
		label: "finisher · goal",
		description:
			"Confirm a goal ONCE and let the harness drive it: it runs the verify fan-out on your model ladder, judges each case from executed evidence, hands the failures back for another round, and stops with one report when every case is proven or the bound is reached. No per-round approval, no token/cost ceiling. Use it instead of asking the human anything mid-run.",
		promptSnippet: "Confirm the goal once, then let the driver loop verify→fix until proven (bounded, evidence-gated)",
		promptGuidelines: [
			"Call finisher_goal first with the goal and its cases: that single confirmation is the only human input this run needs.",
			"After a 'fix' step, fix the real cause and call finisher_goal again with the same goal — the driver keeps the round count and detects unchanged evidence.",
			"Any case left UNVERIFIED (no executed command) is not progress: run a command that proves it, or report honestly that it cannot be proven here.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "the outcome, in the human's words — one goal per run" }),
			cases: Type.Optional(Type.Array(Type.String(), { description: "the cases that make the goal true (defaults to the spec's own goal cases)" })),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const goal = p.goal.trim();
			if (!goal) return { content: [{ type: "text", text: "finisher_goal: goal is empty — state the outcome the human wants" }], details: {}, isError: true };
			const consent = state.goalConsent;
			if (consent && (state.humanAt ?? 0) <= consent.blockedAt)
				return {
					content: [{ type: "text", text: `${GOAL_CONSENT_WAIT_NOTE}\n(last refusal: ${consent.reason})` }],
					details: { goal, confirmed: false, outcome: "blocked-until-human", reason: consent.reason },
					isError: true,
				};
			const cases = (p.cases ?? []).map((c: string) => c.trim()).filter(Boolean);
			const previous = state.goalDriver as GoalRunState | undefined;
			const openGoal = !!previous && !goalDriverDone(previous);
			const sameOpenGoal = openGoal && goalKey(previous.goal) === goalKey(goal);
			const confirmedBefore = previous?.cases ?? state.spec?.crossCheck ?? [];
			const casesChanged = sameOpenGoal && cases.length > 0 && confirmedBefore.length > 0 && !sameCaseSet(cases, confirmedBefore);

			const askSeconds = Math.round(readConfirmTimeout(ctx.cwd) / 1000);
			const refusal = (outcome: GoalAskOutcome, what: string, extra = "") => {
				const note =
					outcome === "timeout"
						? `${GOAL_TIMEOUT_NOTE(askSeconds)}${extra}`
						: outcome === "declined"
							? `${what === "goal" ? GOAL_DECLINED_NOTE : GOAL_CHANGE_NOTE}${extra}`
							: `${GOAL_NO_UI_NOTE}${extra}`;
				if (outcome === "timeout" || outcome === "declined") {
					state.goalConsent = { blockedAt: Date.now(), reason: outcome };
					const line =
						outcome === "timeout"
							? `⏱ finisher: nobody answered the goal dialog in ${askSeconds}s — nothing was started; the run is stopped until you ask again`
							: "finisher: the goal was declined — nothing was started; the run is stopped until you ask again";
					try {
						escalate(outcome === "timeout" ? "goal-confirm-timeout" : "goal-declined", `${goal} — ${askSeconds}s`, ctx);
					} catch {
					}
					try {
						ctx.ui.notify(line, "warning");
					} catch {
					}
					persist();
					updateWidget(ctx);
				}
				return { content: [{ type: "text" as const, text: note }], details: { goal, confirmed: false, outcome, casesChanged: what !== "goal" }, isError: true };
			};

			const started = resumeOrStart(previous, goal, Date.now(), casesChanged ? [] : confirmedBefore);
			if (casesChanged) {
				const added = casesOnlyChanged(confirmedBefore, cases);
				const gone = droppedCases(confirmedBefore, cases);
				const confirmedNow = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });
				if (confirmedNow.length > GOAL_TOO_MANY_CASES)
					return { content: [{ type: "text", text: tooManyCasesNote(confirmedNow.length) }], details: { goal, confirmed: false, cases: confirmedNow.length }, isError: true };
				const change = await askGoalConfirm(ctx, goal, confirmedNow);
				const diff = `${added.length ? ` · added: ${added.join("; ")}` : ""}${gone.length ? ` · removed: ${gone.join("; ")}` : ""}`;
				if (change !== "confirmed") return refusal(change, "cases", diff);
				state.decisions = [];
			}
			if (!sameOpenGoal) {
				const confirmed = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });
				if (confirmed.length > GOAL_TOO_MANY_CASES)
					return { content: [{ type: "text", text: tooManyCasesNote(confirmed.length) }], details: { goal, confirmed: false, cases: confirmed.length }, isError: true };
				const outcome = await askGoalConfirm(ctx, goal, confirmed);
				if (outcome !== "confirmed") return refusal(outcome, "goal");
				if (handoffOff()) clearOtherGoals(ctx.cwd, goal);
				state.decisions = [];
			}
			state.goalDriver = cases.length || confirmedBefore.length ? { ...started, cases: cases.length ? cases : confirmedBefore } : started;
			state.goalConsent = undefined;
			if (cases.length && !state.spec) {
				state.spec = { version: 1, title: goal.slice(0, 80), intent: goal, crossCheck: cases, approach: [], scope: [], constraints: [], criteria: [], specDebt: [], approved: true, approvedAt: Date.now(), approvedBy: "goal", createdAt: Date.now() } as any;
				state.phase = "implementation";
			}
			if (cases.length && state.spec) state.spec.crossCheck = cases;
			persist();
			updateWidget(ctx);
			const next = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });
			return {
				content: [{ type: "text", text: buildGoalToolText(started, { action: "finish", round: 0, report: { cases: [], allPass: false, unverified: [], failed: [] }, state: started, text: `the goal is confirmed — work until every case holds, then call finisher_swarm mode=verify ONCE at the end:
${next.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}

verification runs once, reading the change and exercising the changed code directly (never the test suite as proof). If a case cannot be exercised, it comes back as UNVERIFIED for a human to test.` }) }],
				details: { goal, cases: next, round: 0 },
			};
		},
	}));

	pi.registerTool(boundedTool({
		name: "finisher_steer",
		label: "finisher · steer",
		description:
			"Push a finding into a sub-agent THAT IS STILL RUNNING, so it corrects course without being restarted. Call it with no arguments to list who is working right now. You decide when this matters — the harness never guesses on your behalf. steer lands after the current turn's tool calls, before the next model request; followUp lands after the agent finishes its current work.",
		promptSnippet: "Send a finding into a running sub-agent (steer or follow-up) instead of restarting it",
		promptGuidelines: [
			"Use this when one worker's result changes what another running worker must know — a shared file, a broken assumption, a constraint it cannot see.",
			"Prefer steer for something it must act on now; use followUp for extra work it should do after finishing.",
			"Call it with no arguments first if you are unsure who is live.",
			"Never use it to restart a worker or undo its work — steer only adds information.",
		],
		parameters: Type.Object({
			role: Type.Optional(Type.String({ description: "which live sub-agent to reach: swarm or verifier. Omit to list who is running" })),
			message: Type.Optional(Type.String({ description: "the finding to inject — self-contained, no references to context the sub-agent cannot see" })),
			mode: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")] as const)),
		}),
		async execute(_id, pp, _s, _o, ctx) {
			const live = liveByRole();
			const now = Date.now();
			if (!pp.role || !pp.message?.trim()) {
				return {
					content: [{ type: "text", text: live.length ? `live sub-agents (pass role + message to reach one):\n${live.map((r) => `  ${r.role} — running ${Math.round((now - r.startedAt) / 1000)}s`).join("\n")}` : "no sub-agent is running — there is nothing to steer. Start one with finisher_swarm, or do the work yourself." }],
					details: { live: live.map((r) => ({ role: r.role, aliveMs: now - r.startedAt })) },
					...(live.length ? { isError: true } : {}),
				};
			}
			const role = pp.role.trim();
			const message = pp.message.trim();
			const how = pp.mode ?? "steer";
			const n = how === "followUp" ? await followUpLive(role, message) : await steerLive(role, message);
			if (n) recordSteerOnRun(state, role, how, message);
			if (!n)
				return {
					content: [{ type: "text", text: `no "${role}" sub-agent is running — nothing was sent. Live right now: ${live.map((r) => r.role).join(", ") || "(none)"}. A steer cannot reach a worker that already finished; its result is in the handoff stack instead.` }],
					details: { sent: 0, role, mode: how, live: live.map((r) => r.role) },
					isError: true,
				};
			return {
				content: [{ type: "text", text: `${how === "followUp" ? "follow-up queued for" : "steered"} ${n} live ${role} agent(s):\n${message}\n\n${how === "followUp" ? "it will be handled after the agent finishes its current work" : "it lands after the current turn's tool calls, before the next model request"}` }],
				details: { sent: n, role, mode: how },
			};
		},
	}));
};
