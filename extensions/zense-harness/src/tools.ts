import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askPolicyError, askQuestionScan, formatAskAnswers, ASK_NO_UI_TEXT, type AskAnswer } from "./ask.ts";
import { buildGoalToolText, nextGoalDriverStep, resumeOrStart, type GoalRunState } from "./goal-driver.ts";
import { costCeilingKeysPresent, surfaceLine } from "./goal-run.ts";
import { goalCases } from "./goal-confirm.ts";
import { type ArmGoalRound, type AskClarify, type LaunchSubagent, type Learn, type Persist, type RunCodeSwarm, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { effectiveLadder, readSwarmConcurrency, swarmSlots, swarmSummaryLine, buildFanOutPrompt, readModelLadder, type FanOutArgs, type SwarmTask, type SwarmSlot, runSwarm } from "./swarm.ts";
import { MAX_VERIFY_ROUNDS, advanceLoop, buildFixPrompt, buildReport, freshVerifyLoop, judgeCase, nextVerifyRound, renderVerifyReport } from "./verify-loop.ts";
import { type State } from "./types.ts";
import { withTimeout, readToolTimeout, timeoutNote, TOOL_TIMEOUT_LABEL } from "./timeout.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { liveByRole, steerLive, followUpLive } from "./subagent-rpc.ts";

export const registerTools = (ctx: HarnessContext) => {
	const learn = ctx.learn;
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
		name: "zense_ask",
		label: "Zense Ask Human",
		description:
			"Ask the human GOAL-ONLY questions through the harness multiple-choice picker (search-filtered TUI with an 'Other (type your own)' free-text option). Callable in ANY phase — prefer this over dumping a '1. a 2. b 3. c' numbered list as chat text. Ask ONLY about the product/UI outcome the human wants (what the result should be or do), each question carrying 2–6 pickable choices. NEVER ask internal technical/detail questions — library choice, module split, file layout, naming, test approach, data shape, refactor structure, error-handling style — or ask the human to pick an implementation strategy: decide those yourself from the repo/context, proceed, and record the decision as an explicit assumption plus a specDebt entry the human reviews at signing. Choices may be omitted only for a genuine product/UI question with no guessable options, and then the question MUST set freeText:true. In non-UI (RPC/print) sessions it returns guidance to ask in plain text instead — it never hangs.",
		promptSnippet: "Ask the human a product/UI-goal question with a multiple-choice picker (choices required; never ask what you should decide yourself)",
		promptGuidelines: [
			"Ask ONLY product/UI-outcome questions — what the human wants the result to be or do. If a wrong guess would be cheap, do not ask at all: decide, proceed, and note the assumption.",
			"Never ask the human an internal technical/detail decision: library, module split, file layout, naming, test approach, data shape, refactor structure, error handling, or any implementation strategy — decide those from the repo/context yourself and record an explicit assumption plus a specDebt entry instead.",
			"Attach 2–6 plausible choices to EVERY question; the human can also pick 'Other (type your own)' to answer freely. Esc = that question is skipped (reported as such — never infer an answer from a skip).",
			"Choices may be omitted only for a genuine product/UI-outcome question that has no guessable options, and that question must set freeText:true (the harness rejects a choice-less question otherwise).",
			"Keep it to the few decision-critical questions (max 5 per call); this is an interactive check-in, not batch form-filling.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String(),
					choices: Type.Optional(Type.Array(Type.String(), { description: "pickable options (2–6). Required for every question except a product/UI-outcome question that genuinely has no guessable options — that one sets freeText:true instead" })),
					freeText: Type.Optional(Type.Boolean({ description: "true ONLY for a product/UI-outcome question with no guessable options (the picker then renders a plain input). A question with neither choices nor freeText is rejected" })),
				}),
				{ description: "questions asked in order, each with its own picker (max 5)" },
			),
		}),
		async execute(_id, p, _s, _o, ctx) {
			if (!state.gateEnabled)
				return {
					content: [{ type: "text", text: "gate is OFF — human questions are disabled. Decide from the repo/context yourself, record the decision as an explicit assumption + specDebt entry, and proceed (no picker was opened)." }],
					details: { gateOff: true, asked: 0 },
				};
			const { questions: qsAll, violations } = askQuestionScan(p.questions);
			if (violations.length) return { content: [{ type: "text", text: askPolicyError(violations) }], details: { violations }, isError: true };
			if (!qsAll.length) return { content: [{ type: "text", text: "zense_ask: no usable question — pass at least one non-empty question text" }], details: {}, isError: true };
			const qs = qsAll;
			if (!ctx.hasUI) return { content: [{ type: "text", text: ASK_NO_UI_TEXT }], details: { noUi: true } };
			const answers: AskAnswer[] = [];
			for (const q of qs)
				answers.push({ question: q.question, answer: await askClarifyQuestion(ctx as ExtensionContext, q) });
			learn(ctx as ExtensionContext, `zense_ask: ${qs.length} question(s), ${answers.filter((a) => a.answer === undefined).length} skipped`);
			return { content: [{ type: "text", text: formatAskAnswers(answers) }], details: { answers } };
		},
	}));

	pi.registerTool(boundedTool({
		name: "zense_swarm",
		label: "Zense Swarm",
		description:
			"Run several sub-agents AT THE SAME TIME on your configured model ladder (priority1..priority5 in .zense/models.json, capped by swarmConcurrency). mode=explore fans a goal out into read-only research slices; mode=verify sends independent verifiers that must prove the goal with real commands; mode=code gives every slice its OWN git worktree + branch so coders write in parallel without touching each other, then merges back in deterministic slice-id order and refuses to merge silently when two slices touched the same path. No token/cost ceiling.",
		promptSnippet: "Fan out parallel sub-agents across the model priority ladder (explore / verify / code in isolated worktrees)",
		promptGuidelines: [
			"Use zense_swarm explore when a goal needs many independent reads (survey, locate, compare) — gives back one merged report instead of serial sub-agent turns.",
			"Use zense_swarm verify to prove the result against reality: each verifier must RUN commands and end with VERDICT: PASS/FAIL. A claim with no executed command is UNVERIFIED, never PASS. The loop is bounded — fix the real cause and call verify again; identical evidence stops it.",
			"Use zense_swarm code when the change splits into independent slices: each coder gets its own worktree, so give every slice its scope and let them all run at once. Slices that need the same file must be one slice — overlapping paths are blocked and reported, never merged silently.",
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
			if (!p.subtasks.length) return { content: [{ type: "text", text: "zense_swarm: subtasks must contain at least one slice" }], details: {}, isError: true };
			if (p.subtasks.length > 8) return { content: [{ type: "text", text: `zense_swarm: at most 8 slices per call (got ${p.subtasks.length}) — split into several calls` }], details: {}, isError: true };
			const ids = new Set<string>();
			for (const s of p.subtasks) {
				if (!s.id.trim() || ids.has(s.id)) return { content: [{ type: "text", text: `zense_swarm: subtask id "${s.id}" is empty or duplicated` }], details: {}, isError: true };
				ids.add(s.id);
			}
			const mainPattern = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const { ladder, source } = effectiveLadder(ctx.cwd, mainPattern);
			const slots = swarmSlots(ladder);
			if (!slots.length)
				return {
					content: [{ type: "text", text: "zense_swarm: no model to run — set priority1..priority5 in .zense/models.json (each a pi model pattern like \"provider/model\"), or run the swarm from a session whose model resolves; it uses as many slots as are set" }],
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
			learn(ctx, `swarm ${p.mode}: ${swarmSummaryLine(results)} — ladder ${ladder.join(" > ")} (${source})${notes}`);
			if (p.mode === "verify") {
				const report = buildReport(results.map((r) => judgeCase(r.id, r.output, r.ok ? {} : { exitCode: 1 })));
				const active = state.goalDriver as GoalRunState | undefined;
				const driver = active && !active.doneAt ? active : undefined;
				const loop = driver ? driver.loop : state.verifyLoop ?? freshVerifyLoop();
				const decision = nextVerifyRound(loop, report);
				if (driver) {
					const step = nextGoalDriverStep({ ...driver, loop }, report);
					state.goalDriver = step.state;
					state.verifyLoop = step.state.loop;
					persist();
					updateWidget(ctx);
					learn(ctx, `goal driver: ${step.action} round ${step.round}/${MAX_VERIFY_ROUNDS} — ${step.state.outcome ?? "running"}`);
					if (step.action === "fix") armGoalRound(step.text);
					return {
						content: [{ type: "text", text: [buildGoalToolText({ ...driver, loop }, step), "", body].join("\n") }],
						details: { mode: p.mode, report, decision, step: step.action, outcome: step.state.outcome, results },
						...(report.allPass ? {} : { isError: true }),
					};
				}
				state.verifyLoop = advanceLoop(loop, report);
				persist();
				learn(ctx, `verify: ${report.allPass ? "PASS" : "not verified"} round ${state.verifyLoop.round}/${MAX_VERIFY_ROUNDS} — ${report.cases.map((c) => `${c.caseId}:${c.verdict}`).join(", ")}`);
				const fix = decision.kind === "retry" ? buildFixPrompt(report, decision.round, MAX_VERIFY_ROUNDS) : decision.kind === "stop" ? `⛔ verify stopped (${decision.halt ? "bound" : "no new evidence"}): ${decision.reason}` : "";
				return {
					content: [{ type: "text", text: [renderVerifyReport(report, state.verifyLoop), fix, "", body].filter(Boolean).join("\n") }],
					details: { mode: p.mode, report, decision, results },
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
		name: "zense_goal",
		label: "Zense Goal",
		description:
			"Confirm a goal ONCE and let the harness drive it: it runs the verify fan-out on your model ladder, judges each case from executed evidence, hands the failures back for another round, and stops with one report when every case is proven or the bound is reached. No per-round approval, no token/cost ceiling. Use it instead of asking the human anything mid-run.",
		promptSnippet: "Confirm the goal once, then let the driver loop verify→fix until proven (bounded, evidence-gated)",
		promptGuidelines: [
			"Call zense_goal first with the goal and its cases: that single confirmation is the only human input this run needs.",
			"After a 'fix' step, fix the real cause and call zense_goal again with the same goal — the driver keeps the round count and detects unchanged evidence.",
			"Any case left UNVERIFIED (no executed command) is not progress: run a command that proves it, or report honestly that it cannot be proven here.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "the outcome, in the human's words — one goal per run" }),
			cases: Type.Optional(Type.Array(Type.String(), { description: "the cases that make the goal true (defaults to the spec's own goal cases)" })),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const goal = p.goal.trim();
			if (!goal) return { content: [{ type: "text", text: "zense_goal: goal is empty — ctx.state the outcome the human wants" }], details: {}, isError: true };
			const cases = (p.cases ?? []).map((c: string) => c.trim()).filter(Boolean);
			const started = resumeOrStart(state.goalDriver as GoalRunState | undefined, goal);
			state.goalDriver = started;
			if (cases.length && !state.spec) {
				state.spec = { version: 1, title: goal.slice(0, 80), intent: goal, crossCheck: cases, approach: [], scope: [], constraints: [], criteria: [], specDebt: [], approved: true, approvedAt: Date.now(), approvedBy: "goal", createdAt: Date.now() } as any;
				state.phase = "implementation";
			}
			if (cases.length && state.spec) state.spec.crossCheck = cases;
			persist();
			updateWidget(ctx);
			learn(ctx, `goal confirmed once: ${goal.slice(0, 160)}${cases.length ? ` (${cases.length} case(s))` : ""} — round ${started.loop.round}`);
			const next = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });
			return {
				content: [{ type: "text", text: buildGoalToolText(started, { action: "fix", round: started.loop.round, report: { cases: [], allPass: false, unverified: [], failed: [] }, state: started, text: `the goal is confirmed — work until every case holds, then prove it:
${next.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}

prove it with real commands (zense_swarm mode=verify or your own runs); no further approval will be asked.` }) }],
				details: { goal, cases: next, round: started.loop.round },
			};
		},
	}));

	pi.registerTool(boundedTool({
		name: "zense_steer",
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
					content: [{ type: "text", text: live.length ? `live sub-agents (pass role + message to reach one):\n${live.map((r) => `  ${r.role} — running ${Math.round((now - r.startedAt) / 1000)}s`).join("\n")}` : "no sub-agent is running — there is nothing to steer. Start one with zense_swarm, or do the work yourself." }],
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
			learn(ctx, `steer: ${how} sent to ${n} live ${role} agent(s) — ${message.slice(0, 160)}`);
			return {
				content: [{ type: "text", text: `${how === "followUp" ? "follow-up queued for" : "steered"} ${n} live ${role} agent(s):\n${message}\n\n${how === "followUp" ? "it will be handled after the agent finishes its current work" : "it lands after the current turn's tool calls, before the next model request"}` }],
				details: { sent: n, role, mode: how },
			};
		},
	}));
};
