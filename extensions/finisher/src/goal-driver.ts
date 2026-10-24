import {
	buildHumanTestNote,
	decideOnce,
	freshAttempts,
	MAX_LOOP_BATCHES,
	needsHuman,
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
}

export interface GoalStep {
	action: "finish" | "replan" | "human" | "halt";
	round: number;
	text: string;
	report: VerifyReport;
	state: GoalRunState;
}

export const freshGoalRun = (goal: string, at = Date.now()): GoalRunState => ({ goal: goal.trim(), confirmedAt: at, attempts: freshAttempts(), phases: [], lap: 0, lapAt: 0, lapMs: [] });

export const goalKey = (goal: string): string => goal.replace(/\s+/g, " ").trim().toLowerCase();

export const resumeOrStart = (prev: GoalRunState | undefined, goal: string, at = Date.now()): GoalRunState => {
	if (prev && !prev.doneAt && goalKey(prev.goal) === goalKey(goal)) return prev;
	return freshGoalRun(goal, at);
};

export const goalDriverDone = (g: GoalRunState | undefined): boolean => !!g?.doneAt;

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
			text: [renderVerifyReport(report), "", `goal reached: ${state.goal}`, "every case is backed by code that was actually run — report this once and stop"].join("\n"),
		};
	if (decision.kind === "replan") {
		const human = needsHuman(report);
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
				...(human.length ? ["", buildHumanTestNote(report), "", `do not invent a way to prove ${human.join(", ")} — if it cannot be exercised from a command, say so and hand it to the human instead of forcing it.`] : []),
				"",
				`this is verify round ${round} of ${maxBatches} — close every lap with finisher_phase done, then call finisher_swarm mode=verify once`,
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
