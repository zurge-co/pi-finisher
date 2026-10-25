import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildGoalToolText, casesForGate, goalGateAsks, goalGateFor, reopenGoal, resumeOrStart, type GoalRunState } from "./goal-driver.ts";
import { costCeilingKeysPresent, readConfirmTimeout, surfaceLine } from "./goal-run.ts";
import { GOAL_ALREADY_VERIFIED_NOTE, GOAL_CONSENT_WAIT_NOTE, GOAL_DECLINED_NOTE, GOAL_NO_UI_NOTE, GOAL_TIMEOUT_NOTE, GOAL_TOO_MANY_CASES, GOAL_UNCHANGED_NOTE, cleanChrome, consentBlocks, goalCases, humanTurnsFrom, sessionIdFrom, tooManyCasesNote, UNKNOWN_HUMAN_TURNS, type GoalAskOutcome, type GoalChromeOverrides } from "./goal-confirm.ts";
import { DEFAULT_GOAL_LANG, goalLanguageNote, languageTag, readableIn, resolveGoalLang } from "./human-language.ts";
import { armGoalStop, goalStopMessage } from "./goal-stop.ts";
import { type LaunchSubagent, type Persist, type RunCodeSwarm, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { effectiveLadder, concurrencyFor, swarmSlots } from "./swarm.ts";
import { planRefusalText, planRefusals, readPlanSlices } from "./swarm-plan.ts";
import { clearOtherGoals } from "./handoff-stack.ts";
import { handoffOff } from "./handoff-gate.ts";
import { withTimeout, readToolTimeout, timeoutNote, TOOL_TIMEOUT_LABEL } from "./timeout.ts";
import { budgetNote, capNeededFor, effortFor, SWARM_TOOL, wavesFor } from "./budget.ts";
import { subagentTimeout } from "./subagent-config.ts";
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema } from "typebox";
import { liveByRole, steerLive, followUpLive } from "./subagent-rpc.ts";
import { recordSteerOnRun } from "./agent-session.ts";
import { countSuite } from "./suite-budget.ts";
import { registerPhaseTool } from "./phase-tool.ts";
import { verifyToolDefinition, VERIFY_TOOL } from "./verify-tool.ts";
import { applyAnswers, clarifyPlan, markClarify, type ClarifyGap } from "./goal-clarify.ts";
import { askClarify, clarifyTargets } from "./clarify-dialog.ts";
import { caseKey } from "./goal-confirm.ts";

export const SWARM_MODES = ["code"] as const;
export const RETIRED_MODES = ["explore", "verify"] as const;
export const retiredModeNote = (mode: string): string =>
	`finisher_swarm mode=${mode} is gone: explore and plan are yours alone (read the files yourself), and verification is ${"finisher_verify"} — the harness records what you actually run, so no sub-agent judges your work. This tool now spawns coders in worktrees and nothing else.`;

const humanTurnsNow = (ctx: ExtensionContext): number => {
	try {
		const entries = ctx.sessionManager?.getEntries();
		return Array.isArray(entries) ? humanTurnsFrom(entries as never) : UNKNOWN_HUMAN_TURNS;
	} catch {
		return UNKNOWN_HUMAN_TURNS;
	}
};

const sessionIdNow = (ctx: ExtensionContext): string => sessionIdFrom(ctx.sessionManager as never);

export const registerTools = (ctx: HarnessContext) => {
	const persist = ctx.persist;
	const pi = ctx.pi;
	const state = ctx.state;
	const updateWidget = ctx.updateWidget;
	const runCodeSwarm = ctx.runCodeSwarm;
	const askGoalConfirm = ctx.askGoalConfirm;
	const askClarifyQuestion = ctx.askClarifyQuestion;

	registerPhaseTool(ctx);

	const capFor = (name: string, configured: number, cwd: string, params: unknown): number => {
		if (name !== SWARM_TOOL) return configured;
		const p = params as { subtasks?: unknown[]; maxAttempts?: number } | undefined;
		const tasks = Array.isArray(p?.subtasks) ? p.subtasks.length : 0;
		const { ladder } = effectiveLadder(cwd);
		const spread = concurrencyFor(cwd, swarmSlots(ladder).length, tasks);
		const needed = capNeededFor({ subagentMs: subagentTimeout("swarm", cwd), attempts: effortFor(p?.maxAttempts), waves: wavesFor(tasks, spread.concurrency) });
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

	pi.registerTool(boundedTool(verifyToolDefinition(ctx)));

	pi.registerTool(boundedTool({
		name: "finisher_swarm",
		label: "finisher · swarm",
		description:
			"Run coder sub-agents in parallel on your configured model ladder (priority1..priority5 in .finisher/models.json, capped by swarmConcurrency). Every slice gets its OWN git worktree + branch, so coders write at the same time without touching each other; the harness then merges the slices back in deterministic order and refuses to merge silently when two slices touched the same path. Explore, plan and verify are NOT this tool — you do those yourself, and verification is finisher_verify.",
		promptSnippet: "Fan out parallel CODERS across the model priority ladder (one worktree per slice)",
		promptGuidelines: [
			"This tool only codes. Do the exploring and the planning yourself first — decide the slices, the files each one owns and the interface they share — because every slice you add is paid for by a coder reading context you already have.",
			"Give every slice its scope (repo-relative paths): two slices sharing a path are a conflict, so split differently. Keep slices independent — they run concurrently, so a slice that needs another's interface must have that interface decided in your plan, not discovered by the coder.",
			"Use as many slices as the work genuinely splits into and no more: fewer coders is faster when the work serialises. Do not spend the whole ladder because it is there.",
			"Verification is finisher_verify, not this tool: you run the deterministic checks and name the command that proves each case, so no sub-agent grades your work.",
			"Treat a worker's report as the evidence: do not re-read the files it read or re-run the commands it ran.",
			"Decide library/layout/approach yourself — do not ask the human.",
		],
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "code (the only mode this tool still has; explore/plan/verify are yours alone)" })),
			goal: Type.Optional(Type.String({ description: "the outcome the whole fan-out serves" })),
			shared_contract: Type.Optional(Type.String({ description: "the interface every slice must follow (types, signatures, response shapes) — decided by you before any coder starts, so no coder has to guess another's API" })),
			subtasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "short stable id, unique within the call (e.g. s1) — used verbatim in the worker's worktree and branch, so lowercase letters/digits/-/_ only" }),
					instruction: Type.String({ description: "self-contained slice: that worker sees only this text" }),
					files: Type.Array(Type.String(), { description: "repo-relative paths this slice OWNS — required. Two slices sharing a path are refused before anything is spawned, so give each path to exactly one slice" }),
					acceptance: Type.Optional(Type.Array(Type.String(), { description: "what makes this slice done, checkable by the coder itself" })),
					depends_on: Type.Optional(Type.Array(Type.String(), { description: "ids of slices that must succeed before this one starts. The interface they share belongs in shared_contract, not in a coder's guesswork" })),
				}),
				{ description: "1–8 slices — files must not overlap; depends_on is refused if it names an unknown id or forms a cycle" },
			),
			maxAttempts: Type.Optional(Type.Integer({ description: "attempts per slice before it counts as failed (default 2)" })),
		}),
		async execute(_id, p, sig, _on, ctx) {
			const mode = (p.mode ?? "code").trim();
			if (mode !== "code") return { content: [{ type: "text", text: retiredModeNote(mode) }], details: { refused: true, mode }, isError: true };
			if (!p.subtasks.length) return { content: [{ type: "text", text: "finisher_swarm: subtasks must contain at least one slice" }], details: {}, isError: true };
			if (p.subtasks.length > 8) return { content: [{ type: "text", text: `finisher_swarm: at most 8 slices per call (got ${p.subtasks.length}) — split into several calls` }], details: {}, isError: true };
			const plan = readPlanSlices(p.subtasks as never[]);
			const refusals = planRefusals(plan);
			if (refusals.length) return { content: [{ type: "text", text: planRefusalText(refusals, "no worktree, no coder, no command was run") }], details: { refused: true, refusals }, isError: true };
			const sharedContract = p.shared_contract?.trim();
			const slices = plan.map((sl) => ({
				id: sl.id,
				instruction: sl.instruction,
				...(sl.files.length ? { scope: sl.files } : {}),
				...(sl.acceptance.length ? { acceptance: sl.acceptance } : {}),
				...(sl.dependsOn.length ? { dependsOn: sl.dependsOn } : {}),
				...(sharedContract ? { sharedContract } : {}),
			}));
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
			const effort = effortFor(p.maxAttempts);
			const budget = budgetNote({
				toolCapMs: readToolTimeout(ctx.cwd, SWARM_TOOL),
				subagentMs: subagentTimeout("swarm", ctx.cwd),
				attempts: effort,
				waves: wavesFor(p.subtasks.length, spread.concurrency),
			});
			const notes = costCeilingKeysPresent(ctx.cwd).length ? ` ⚠ ignored ceiling key(s): ${costCeilingKeysPresent(ctx.cwd).join(", ")}` : "";
			return await runCodeSwarm(ctx, slices, { slots, concurrency: spread.concurrency, maxAttempts: effort, goal: p.goal, sig, ladder, source, notes, budget });
		},
	}));

	pi.registerTool(boundedTool({
		name: "finisher_goal",
		label: "finisher · goal",
		description:
			"Confirm a goal ONCE and let the harness drive it: after every lap you verify it yourself with finisher_verify, the harness judges each case from the commands it watched you run, hands the failures back for another round, and stops with one report when every case is proven or the bound is reached. The goal is the human's decision and the cases are yours: an unchanged goal is never re-confirmed, and only a changed goal opens the dialog again. No per-round approval, no token/cost ceiling. Use it instead of asking the human anything mid-run.",
		promptSnippet: "Confirm the goal once, then let the driver loop verify→fix until proven (bounded, evidence-gated)",
		promptGuidelines: [
			"Call finisher_goal first with the goal and its cases: that single confirmation is the only human input this run needs.",
			"The same goal is never confirmed twice: calling it again with an unchanged goal resumes the run without a dialog, even if the cases changed or the goal was closed by a verify round.",
			"Write the goal and every case in the language the human writes in, and pass that language as lang: the dialog they confirm is in their language, never yours. Paths, identifiers and commands stay verbatim.",
			"After a 'fix' step, fix the real cause and call finisher_goal again with the same goal — the driver keeps the round count and detects unchanged evidence.",
			"Any case left UNVERIFIED (no executed command) is not progress: run a command that proves it, or declare it { human: true } in finisher_verify when only the human can check it.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "the outcome, in the human's words — one goal per run" }),
			cases: Type.Optional(Type.Array(Type.String(), { description: "the cases that make the goal true (defaults to the spec's own goal cases)" })),
			lang: Type.Optional(Type.String({ description: "the language the human writes in (e.g. th, ja, pt-BR) — the confirm dialog uses it" })),
			chrome: Type.Optional(
				Type.Object({
					title: Type.Optional(Type.String()),
					header: Type.Optional(Type.String()),
					note: Type.Optional(Type.String()),
					keys: Type.Optional(Type.String()),
					keysLine: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const goal = p.goal.trim();
			if (!goal) return { content: [{ type: "text", text: "finisher_goal: goal is empty — state the outcome the human wants" }], details: {}, isError: true };
			const lang = resolveGoalLang(languageTag(p.lang), state.humanLang);
			state.goalLang = lang;
			const chrome = cleanChrome(p.chrome as GoalChromeOverrides | undefined);
			state.goalChrome = Object.keys(chrome).length ? chrome : undefined;
			if (!readableIn(lang, goal))
				return {
					content: [{ type: "text", text: goalLanguageNote(lang) }],
					details: { goal, confirmed: false, outcome: "unreadable-goal", lang },
					isError: true,
				};
			const cases = (p.cases ?? []).map((c: string) => c.trim()).filter(Boolean);
			const previous = state.goalDriver as GoalRunState | undefined;
			const before = previous?.cases ?? state.spec?.crossCheck ?? [];
			const gate = goalGateFor(previous, goal);
			if (gate === "verified")
				return {
					content: [{ type: "text", text: GOAL_ALREADY_VERIFIED_NOTE }],
					details: { goal, confirmed: true, outcome: "already-verified", cases: before },
				};
			const asks = goalGateAsks(gate);
			const humanTurns = humanTurnsNow(ctx);
			const sessionId = sessionIdNow(ctx);
			const consent = state.goalConsent;
			if (asks && consentBlocks(consent, { humanTurns, sessionId }))
				return {
					content: [{ type: "text", text: `${GOAL_CONSENT_WAIT_NOTE}\n(last refusal: ${consent?.reason})` }],
					details: { goal, confirmed: false, outcome: "blocked-until-human", reason: consent?.reason },
					isError: true,
				};
			const confirmed = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });

			let askGoal = goal;
			let askCases = confirmed;
			let sharpened: string[] | undefined;
			let clarifyNotes: string[] = [];
			const clarify: { gaps: ClarifyGap[]; asked: number } = { gaps: [], asked: 0 };
			const plan = clarifyPlan({ goal, cases: confirmed }, state, caseKey(goal), { targets: clarifyTargets(ctx.cwd) }, lang);
			if (asks && plan.ask && typeof askClarifyQuestion === "function" && Boolean(ctx.hasUI)) {
				const asked = await askClarify((question) => askClarifyQuestion(ctx, { question: question.question, choices: question.options }), plan.questions, lang);
				markClarify(state, caseKey(goal), Date.now());
				clarify.gaps = plan.gaps;
				clarify.asked = asked.asked;
				if (Object.keys(asked.answers).length) {
					const applied = applyAnswers({ goal, cases: confirmed }, asked.answers, lang);
					askGoal = applied.goalText;
					askCases = applied.cases;
					sharpened = applied.cases;
					clarifyNotes = applied.notes;
				}
				persist();
			}

			const askSeconds = Math.round(readConfirmTimeout(ctx.cwd) / 1000);
			const refusal = (outcome: GoalAskOutcome, extra = "") => {
				if (outcome !== "timeout" && outcome !== "declined")
					return { content: [{ type: "text" as const, text: `${GOAL_NO_UI_NOTE}${extra}` }], details: { goal, confirmed: false, outcome }, isError: true };
				state.goalConsent = { humanTurns, reason: outcome, sessionId };
				const stop = armGoalStop(state, outcome, askSeconds);
				state.escalations.push({ kind: outcome === "timeout" ? "goal-confirm-timeout" : "goal-declined", detail: `${goal} — ${askSeconds}s`, at: Date.now() });
				try {
					ctx.ui.notify(goalStopMessage(stop, lang), "warning");
				} catch {
				}
				persist();
				updateWidget(ctx);
				const note = `${outcome === "timeout" ? GOAL_TIMEOUT_NOTE(askSeconds) : GOAL_DECLINED_NOTE}${extra}\n\n${goalStopMessage(stop, lang)}`;
				return { content: [{ type: "text" as const, text: note }], details: { goal, confirmed: false, outcome, stop }, isError: true, terminate: true };
			};

			if (asks) {
				if (askCases.length > GOAL_TOO_MANY_CASES)
					return { content: [{ type: "text", text: tooManyCasesNote(askCases.length) }], details: { goal, confirmed: false, cases: askCases.length, clarify }, isError: true };
				const outcome = await askGoalConfirm(ctx, askGoal, askCases);
				if (outcome !== "confirmed") return refusal(outcome);
				if (handoffOff()) clearOtherGoals(ctx.cwd, goal);
				state.decisions = [];
				if (clarifyNotes.length) state.decisions = clarifyNotes.map((note) => ({ at: Date.now(), from: "clarify", question: "the human made the intent concrete", assumption: note }));
			}
			const started = gate === "reopen" ? reopenGoal(previous as GoalRunState, cases, state.humanAt ?? 0) : resumeOrStart(previous, goal, Date.now(), cases);
			const adopted = casesForGate(gate, sharpened ?? cases, sharpened ?? confirmed, started.cases ?? before);
			state.goalDriver = adopted.length ? { ...started, cases: adopted } : started;
			if (gate !== "resume" || !state.suiteAtStart) state.suiteAtStart = countSuite(ctx.cwd);
			state.goalConsent = undefined;
			state.goalStop = undefined;
			state.preGoalCalls = 0;
			state.lastModifiedAt = Date.now();
			if (adopted.length && !state.spec) {
				state.spec = { version: 1, title: goal.slice(0, 80), intent: goal, crossCheck: adopted, approach: [], scope: [], constraints: [], criteria: [], specDebt: [], approved: true, approvedAt: Date.now(), approvedBy: "goal", createdAt: Date.now() } as any;
				state.phase = "implementation";
			}
			if (adopted.length && state.spec) state.spec.crossCheck = adopted;
			persist();
			updateWidget(ctx);
			const next = adopted.length ? adopted : confirmed;
			return {
				content: [
					{
						type: "text",
						text: buildGoalToolText(started, {
							action: "finish",
							round: 0,
							report: { cases: [], allPass: false, unverified: [], failed: [] },
							state: started,
							text: [
								...(gate === "reopen" ? [GOAL_UNCHANGED_NOTE, ""] : []),
								"the goal is confirmed — work until every case holds, then call finisher_verify ONCE at the end:",
								...next.map((c, i) => `  ${i + 1}. ${c}`),
								...(clarifyNotes.length ? ["", "kept from the human's own answer, so they are never guessed again:", ...clarifyNotes.map((note) => `  ${note}`)] : []),
								"",
								"verification runs once: the repo's checks run scoped, parallel and cached, every case is judged from a command the harness recorded, and each case's result lands in .finisher/checks — never in a new test file.",
								"changing or adding a case never reopens the dialog — the human confirmed the goal, not the plan for proving it.",
								"a case only a human can check is separated, never failed: declare it in finisher_verify as { id, human: true, note } and it is listed for them in the final report.",
							].join("\n"),
						}),
					},
				],
				details: { goal, cases: next, round: 0, resumed: gate === "reopen" ? "goal-unchanged" : gate, clarify },
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
			role: Type.Optional(Type.String({ description: "which live sub-agent to reach: swarm. Omit to list who is running" })),
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
