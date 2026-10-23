import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildGoalToolText, goalKey, nextGoalDriverStep, resumeOrStart, type GoalRunState } from "./goal-driver.ts";
import { costCeilingKeysPresent, surfaceLine } from "./goal-run.ts";
import { goalCases } from "./goal-confirm.ts";
import { type ArmGoalRound, type LaunchSubagent, type Persist, type RunCodeSwarm, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { effectiveLadder, readSwarmConcurrency, swarmSlots, swarmSummaryLine, buildFanOutPrompt, readModelLadder, type FanOutArgs, type SwarmTask, type SwarmSlot, runSwarm } from "./swarm.ts";
import { buildReport, decideOnce, freshAttempts, judgeCase, renderVerifyReport } from "./verify-loop.ts";
import { type State } from "./types.ts";
import { headOf } from "./pending-apply.ts";
import { reportWithDecisions, writeDecisionsFile } from "./decisions.ts";
import { clearOtherGoals } from "./handoff-stack.ts";
import { withTimeout, readToolTimeout, timeoutNote, TOOL_TIMEOUT_LABEL } from "./timeout.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { liveByRole, steerLive, followUpLive } from "./subagent-rpc.ts";

export const registerTools = (ctx: HarnessContext) => {
	const persist = ctx.persist;
	const pi = ctx.pi;
	const state = ctx.state;
	const updateWidget = ctx.updateWidget;
	const launchSubagent = ctx.launchSubagent;
	const runCodeSwarm = ctx.runCodeSwarm;
	const armGoalRound = ctx.armGoalRound;
	const askClarifyQuestion = ctx.askClarifyQuestion;

	const boundedTool = <TParams extends TSchema, TDetails, TState>(def: ToolDefinition<TParams, TDetails, TState>): ToolDefinition<TParams, TDetails, TState> => ({
		...def,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
			const r = await withTimeout(Promise.resolve(def.execute(toolCallId, params, signal, onUpdate, ctx)), readToolTimeout(cwd, def.name), TOOL_TIMEOUT_LABEL(def.name));
			if (!r.timedOut) return r.value as never;
			return { content: [{ type: "text", text: timeoutNote(r) }], details: { timedOut: true, tool: def.name }, isError: true } as never;
		},
	});

	pi.registerTool(boundedTool({
		name: "finisher_swarm",
		label: "Zense Swarm",
		description:
			"Run several sub-agents AT THE SAME TIME on your configured model ladder (priority1..priority5 in .finisher/models.json, capped by swarmConcurrency). mode=explore fans a goal out into read-only research slices; mode=verify sends independent verifiers that must prove the goal with real commands; mode=code gives every slice its OWN git worktree + branch so coders write in parallel without touching each other, then merges back in deterministic slice-id order and refuses to merge silently when two slices touched the same path. No token/cost ceiling.",
		promptSnippet: "Fan out parallel sub-agents across the model priority ladder (explore / verify / code in isolated worktrees)",
		promptGuidelines: [
			"Use finisher_swarm explore when a goal needs many independent reads (survey, locate, compare) — gives back one merged report instead of serial sub-agent turns.",
			"Use finisher_swarm verify to prove the result against reality: each verifier must RUN commands and end with VERDICT: PASS/FAIL. A claim with no executed command is UNVERIFIED, never PASS. The loop is bounded — fix the real cause and call verify again; identical evidence stops it.",
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
			const concurrency = readSwarmConcurrency(ctx.cwd, slots.length);
			const notes = costCeilingKeysPresent(ctx.cwd).length ? ` ⚠ ignored ceiling key(s): ${costCeilingKeysPresent(ctx.cwd).join(", ")}` : "";
			const runOne = <T,>(promptFor: (task: SwarmTask<T>, attempt: number) => string) => async (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => {
				if (sig?.aborted) return { ok: false, output: "cancelled by user (Esc)" };
				const before = state.subagentRuns.length;
				const pending = launchSubagent(ctx, "swarm", promptFor(task, attempt), undefined, sig, slot.model);
				const started = state.subagentRuns[before];
				if (started) started.slotId = slot.id;
				const r = await pending;
				return { ok: r.ok, output: r.ok ? r.output : `${r.output}\n(log: ${r.logPath})` };
			};
			if (p.mode === "code") return await runCodeSwarm(ctx, p.subtasks, { slots, concurrency, maxAttempts: p.maxAttempts ?? 2, goal: p.goal, sig, ladder, source, notes });
			const fan: FanOutArgs = { mode: p.mode, subtasks: p.subtasks.map((s: { id: string; instruction: string }) => ({ id: s.id.trim(), instruction: s.instruction })), ...(p.goal?.trim() ? { goal: p.goal.trim() } : {}) };
			const tasks = fan.subtasks.map((s) => ({ id: s.id, payload: s }));
			const results = await runSwarm(tasks, { slots, concurrency, maxAttempts: p.maxAttempts ?? 2, run: runOne((task, attempt) => buildFanOutPrompt(fan, task.payload!, attempt)) });
			const failed = results.filter((r) => !r.ok);
			const body = results
				.map((r) => `## ${r.id} ${r.ok ? "✓" : "✗"}${r.model ? ` [${r.model}]` : ""}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ""}\n${r.output.trim() || "(no output)"}`)
				.join("\n\n");
			if (p.mode === "verify") {
				const report = buildReport(results.map((r) => judgeCase(r.id, r.output, r.ok ? {} : { exitCode: 1 })));
				const active = state.goalDriver as GoalRunState | undefined;
				const driver = active && !active.doneAt ? active : { ...resumeOrStart(undefined, p.goal?.trim() || "goal"), attempts: freshAttempts() };
				const step = nextGoalDriverStep(driver, report);
				const finalText = reportWithDecisions(step.text, state.decisions ?? []);
				if (step.action === "finish" || step.action === "human" || step.action === "halt") writeDecisionsFile(ctx.cwd, driver.goal, state.decisions ?? []);
				state.goalDriver = step.state;
				persist();
				updateWidget(ctx);
				if (step.action === "replan") armGoalRound(step.text);
				return {
					content: [{ type: "text", text: [buildGoalToolText(driver, step, finalText), "", body].join("\n") }],
					details: { mode: p.mode, report, decision: decideOnce(report, driver.attempts), step: step.action, outcome: step.state.outcome, results },
					...(report.allPass ? {} : { isError: true }),
				};
			}
			return {
				content: [{ type: "text", text: `${swarmSummaryLine(results)} (concurrency ${concurrency})\n\n${body}${failed.length ? `\n\n⚠ ${failed.length} slice(s) failed — re-run just those slices or do them yourself` : ""}` }],
				details: { mode: p.mode, concurrency, results },
				...(failed.length ? { isError: true } : {}),
			};
		},
	}));

	pi.registerTool(boundedTool({
		name: "finisher_goal",
		label: "Zense Goal",
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
			if (!goal) return { content: [{ type: "text", text: "finisher_goal: goal is empty — ctx.state the outcome the human wants" }], details: {}, isError: true };
			const cases = (p.cases ?? []).map((c: string) => c.trim()).filter(Boolean);
			const previous = state.goalDriver as GoalRunState | undefined;
			const isNewGoal = !previous || goalKey(previous.goal) !== goalKey(goal);
			const started = resumeOrStart(previous, goal);
			if (isNewGoal) {
				clearOtherGoals(ctx.cwd, goal);
				state.decisions = [];
			}
			state.goalDriver = started;
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
		label: "Zense Steer",
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
