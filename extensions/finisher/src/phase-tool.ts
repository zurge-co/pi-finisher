import { declarePlan, completeLap, currentLap, allLapsDone, lapLabel, phaseListLines, planOf, verifyGate } from "./goal-phase.ts";
import { goalDriverDone, type GoalRunState } from "./goal-driver.ts";
import { type HarnessContext } from "./kit.ts";

export interface PhaseCall {
	plan?: string[];
	done?: string | boolean;
}

export interface PhaseAction {
	text: string;
	action: "declared" | "grew" | "done" | "blocked" | "none";
	plan: ReturnType<typeof planOf>;
}

export const applyPhaseCall = (state: { goalDriver?: GoalRunState }, call: PhaseCall, at = Date.now()): PhaseAction => {
	const driver = state.goalDriver;
	if (!driver || goalDriverDone(driver)) return { text: "finisher_phase: no goal is open — call finisher_goal first.", action: "none", plan: planOf(undefined) };
	const plan = planOf(driver);
	const wanted = (call.plan ?? []).map((p) => p.trim()).filter(Boolean);
	if (wanted.length && plan.phases.length && !allLapsDone(plan))
		return {
			text: [
				`the plan is already declared (${lapLabel(plan)}) — it is not replaced while laps are open, because that would throw away the laps and the time already spent.`,
				...phaseListLines(plan),
				"close the current lap with finisher_phase done, keep working the plan, or let a failing verify append the fix laps for you.",
			].join("\n"),
			action: "blocked",
			plan,
		};
	if (wanted.length) {
		const declared = declarePlan(wanted, at);
		if (!declared.phases.length) return { text: "finisher_phase: plan needs at least one non-empty phase.", action: "none", plan };
		const next = { ...driver, phases: declared.phases, lap: declared.lap, lapAt: declared.lapAt, lapMs: declared.lapMs };
		state.goalDriver = next;
		return {
			text: ["plan declared — work one lap at a time, closest first:", ...phaseListLines(declared), "", `now: ${lapLabel(declared)} · ${currentLap(declared)?.text ?? ""}`, "close each lap with finisher_phase done, then verify ONCE at the end with finisher_swarm mode=verify."].join("\n"),
			action: "declared",
			plan: declared,
		};
	}
	if (call.done === undefined) {
		const gate = verifyGate(plan);
		return {
			text: [
				plan.phases.length ? `plan (${lapLabel(plan)}):` : "no plan yet — declare one with finisher_phase plan=[...]",
				...phaseListLines(plan),
				"",
				call.done === undefined && gate.allowed ? "every lap is closed — call finisher_swarm mode=verify once." : gate.note,
			].join("\n"),
			action: "none",
			plan,
		};
	}
	const ref = typeof call.done === "string" && call.done !== "true" ? call.done.trim() : undefined;
	const next = completeLap(plan, ref || undefined, at);
	if (next === plan) return { text: `finisher_phase: ${ref ? `"${ref}" is not the current lap` : "there is no open lap to close"} — laps close in order, now: ${lapLabel(plan)}`, action: "blocked", plan };
	state.goalDriver = { ...driver, phases: next.phases, lap: next.lap, lapAt: next.lapAt, lapMs: next.lapMs };
	if (allLapsDone(next))
		return {
			text: ["every lap is closed — verification is next.", ...phaseListLines(next), "", "call finisher_swarm mode=verify ONCE. a failing verify appends fix laps; do not add laps you have not been told to add."].join("\n"),
			action: "done",
			plan: next,
		};
	return { text: [`lap closed — now: ${lapLabel(next)}`, ...phaseListLines(next)].join("\n"), action: "done", plan: next };
};

export const registerPhaseTool = (ctx: HarnessContext): void => {
	const state = ctx.state;
	const persist = ctx.persist;
	const updateWidget = ctx.updateWidget;
	ctx.pi.registerTool({
		name: "finisher_phase",
		label: "finisher · phase",
		description:
			"The plan/lap bookkeeping of a confirmed goal. Declare the phase plan once (finisher_phase with plan=[...]), close one lap at a time (finisher_phase with done), and read the plan (no arguments). Verification is gated on every lap being closed, so it happens once instead of per lap.",
		promptSnippet: "Declare the phase plan, then close one lap at a time (verify is gated on all laps)",
		promptGuidelines: [
			"After finisher_goal is confirmed, declare the plan: finisher_phase plan=[\"read the parser\",\"rewrite the retry policy\",\"...\"]. Every entry must be independently workable — one lap, one outcome.",
			"Work exactly one lap at a time. When it is genuinely done, call finisher_phase done (or done=\"<lap id>\"). Never close a lap you have not finished.",
			"The order matters: declare the plan, close laps 1..n, then call finisher_swarm mode=verify ONCE. verify is refused while a lap is still open.",
			"If verify fails, the harness appends fix laps to the plan — work those, then verify again. Never invent laps on your own.",
		],
		parameters: {
			type: "object",
			properties: {
				plan: { type: "array", items: { type: "string" }, description: "the ordered phases of this goal, one workable outcome each — declare it once, right after the goal is confirmed" },
				done: { type: ["string", "boolean"], description: "close the current lap: omit the value or pass true for the current lap, or pass the lap id to close that one" },
			},
		},
		async execute(_id: string, params: PhaseCall) {
			const before = state.goalDriver;
			const action = applyPhaseCall(state, params ?? {});
			if (state.goalDriver !== before) {
				persist();
				updateWidget(ctx as never);
			}
			return { content: [{ type: "text", text: action.text }], details: { action: action.action, lap: action.plan.lap, laps: action.plan.phases.length } };
		},
	} as never);
};
