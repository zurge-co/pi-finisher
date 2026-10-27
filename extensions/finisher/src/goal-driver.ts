import {
	buildHumanTestNote,
	decideOnce,
	freshAttempts,
	humanCheckNote,
	humanOnly,
	MAX_LOOP_BATCHES,
	recordEvidence,
	renderVerifyReport,
	type VerifyAttempts,
	type VerifyReport,
} from "./verify-loop.ts";
import { appendPhases, currentLap, fixPhases, phaseListLines, planGrewBy, planOf, totalPhases, type GoalPhase } from "./goal-phase.ts";

export interface GoalRunState {
	goal: string;
	confirmedAt: number;
	attempts: VerifyAttempts;
	doneAt?: number;
	outcome?: "verified" | "needs-human" | "halted";
	phases?: GoalPhase[];
	lap?: number;
	lapAt?: number;
	lapMs?: number[];
	cases?: string[];
}

export interface GoalStep {
	action: "finish" | "replan" | "human" | "halt";
	round: number;
	text: string;
	report: VerifyReport;
	state: GoalRunState;
}

export const freshGoalRun = (goal: string, at = Date.now(), cases: string[] = []): GoalRunState => ({
	goal: goal.trim(),
	confirmedAt: at,
	attempts: freshAttempts(),
	phases: [],
	lap: 0,
	lapAt: 0,
	lapMs: [],
	cases,
});

export const goalKey = (goal: string): string => goal.replace(/\s+/g, " ").trim().toLowerCase();

export const resumeOrStart = (prev: GoalRunState | undefined, goal: string, at = Date.now(), cases: string[] = []): GoalRunState => {
	if (prev && !prev.doneAt && goalKey(prev.goal) === goalKey(goal)) return cases.length ? { ...prev, cases } : prev;
	return freshGoalRun(goal, at, cases);
};

export const goalDriverDone = (g: GoalRunState | undefined): boolean => !!g?.doneAt;

export type GoalGateKind = "fresh" | "resume" | "reopen" | "verified" | "changed";

export const goalGateFor = (prev: GoalRunState | undefined, goal: string): GoalGateKind => {
	if (!prev) return "fresh";
	if (goalKey(prev.goal) !== goalKey(goal)) return "changed";
	if (!goalDriverDone(prev)) return "resume";
	return prev.outcome === "verified" ? "verified" : "reopen";
};

export const goalGateAsks = (gate: GoalGateKind): boolean => gate === "fresh" || gate === "changed";

export const casesForGate = (gate: GoalGateKind, cases: string[], confirmed: string[], prior: string[]): string[] =>
	cases.length ? cases : goalGateAsks(gate) ? confirmed : prior;

export const reopenGoal = (prev: GoalRunState, cases: string[] = [], humanAt = 0): GoalRunState => {
	const humanSpokeAfterClose = (humanAt ?? 0) > (prev.doneAt ?? 0);
	return {
		...prev,
		cases: cases.length ? cases : (prev.cases ?? []),
		doneAt: undefined,
		outcome: undefined,
		attempts: humanSpokeAfterClose ? freshAttempts() : prev.attempts,
	};
};

export const nextGoalDriverStep = (state: GoalRunState, report: VerifyReport, maxBatches = MAX_LOOP_BATCHES, at = Date.now()): GoalStep => {
	const decision = decideOnce(report, state.attempts, maxBatches);
	const round = state.attempts.rounds + 1;
	const advanced: GoalRunState = { ...state, attempts: { ...recordEvidence(state.attempts, report), rounds: round } };
	if (decision.kind === "pass")
		return {
			action: "finish",
			round,
			state: { ...advanced, doneAt: at, outcome: "verified" },
			report,
			text: [renderVerifyReport(report), "", `goal reached: ${state.goal}`, "every machine-checkable case is backed by code that was actually run — report this once and stop", ...(humanCheckNote(report) ? ["", humanCheckNote(report)] : [])].join("\n"),
		};
	if (decision.kind === "replan") {
		const human = humanOnly(report).map((c) => c.caseId);
		const before = planOf(state);
		const grown = appendPhases(before, fixPhases(report), round, at);
		const added = planGrewBy(before, grown);
		return {
			action: "replan",
			round,
			state: { ...advanced, phases: grown.phases, lap: grown.lap, lapAt: grown.lapAt, lapMs: grown.lapMs },
			report,
			text: [
				renderVerifyReport(report),
				"",
				`verification failed for: ${state.goal}`,
				`${added} fix lap(s) were added to the plan — work them one lap at a time, then verify once when every lap is closed:`,
				...phaseListLines(grown),
				"",
				`next: LAP ${Math.min(grown.lap, totalPhases(grown))}/${totalPhases(grown)} — ${currentLap(grown)?.text ?? "no lap"}`,
				...(human.length ? ["", buildHumanTestNote(report), "", `do not invent a way to prove ${human.join(", ")} — declare it { id, human: true } in verify and it is reported to the human at the end instead of failing the run.`] : []),
				"",
				`this is verify round ${round} of ${maxBatches} — close every lap with lap done, then call verify once`,
			].join("\n"),
		};
	}
	if (decision.kind === "human")
		return {
			action: "human",
			round,
			state: { ...advanced, doneAt: at, outcome: "needs-human" },
			report,
			text: [renderVerifyReport(report), "", buildHumanTestNote(report)].join("\n"),
		};
	return {
		action: "halt",
		round,
		state: { ...advanced, doneAt: at, outcome: "halted" },
		report,
		text: [renderVerifyReport(report), "", `⛔ stopped: ${decision.reason}`, `goal not proven: ${state.goal}`, "report exactly this to the human once — do not keep spinning"].join("\n"),
	};
};

export const buildGoalToolText = (started: GoalRunState, step: GoalStep, text = step.text): string =>
	[
		started.attempts.rounds === 0 ? `goal confirmed once: ${started.goal}` : `goal still running: ${started.goal}`,
		"",
		text,
	].join("\n");
