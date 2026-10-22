import { MAX_VERIFY_ROUNDS, advanceLoop, buildFixPrompt, evidenceFingerprint, nextVerifyRound, renderVerifyReport, type VerifyLoopState, type VerifyReport } from "./verify-loop.ts";

export interface GoalRunState {
	goal: string;
	confirmedAt: number;
	loop: VerifyLoopState;
	doneAt?: number;
	outcome?: "verified" | "stopped" | "exhausted";
}

export interface GoalStep {
	action: "finish" | "fix" | "stop";
	round: number;
	text: string;
	report: VerifyReport;
	state: GoalRunState;
}

export const freshGoalRun = (goal: string, at = Date.now()): GoalRunState => ({ goal: goal.trim(), confirmedAt: at, loop: { round: 0, fingerprints: [], caseRounds: {} } });

export const goalKey = (goal: string): string => goal.replace(/\s+/g, " ").trim().toLowerCase();

export const resumeOrStart = (prev: GoalRunState | undefined, goal: string, at = Date.now()): GoalRunState => {
	if (prev && !prev.doneAt && goalKey(prev.goal) === goalKey(goal)) return prev;
	return freshGoalRun(goal, at);
};

export const goalDriverDone = (g: GoalRunState | undefined): boolean => !!g?.doneAt;

export const nextGoalDriverStep = (state: GoalRunState, report: VerifyReport, maxRounds = MAX_VERIFY_ROUNDS, at = Date.now()): GoalStep => {
	const decision = nextVerifyRound(state.loop, report, maxRounds);
	const advanced: GoalRunState = { ...state, loop: advanceLoop(state.loop, report) };
	if (decision.kind === "pass")
		return {
			action: "finish",
			round: advanced.loop.round,
			state: { ...advanced, doneAt: at, outcome: "verified" },
			report,
			text: [renderVerifyReport(report, advanced.loop), "", `goal reached: ${state.goal}`, "every case is backed by executed evidence — report this once and stop"].join("\n"),
		};
	if (decision.kind === "retry")
		return {
			action: "fix",
			round: advanced.loop.round,
			state: advanced,
			report,
			text: [renderVerifyReport(report, advanced.loop), "", buildFixPrompt(report, decision.round, maxRounds), "", "after fixing, call zense_swarm mode=verify again — the driver, not the human, decides when this ends"].join("\n"),
		};
	const exhausted = decision.halt;
	const stoppedLoop: VerifyLoopState = { ...state.loop, fingerprints: [...state.loop.fingerprints, evidenceFingerprint(report)] };
	return {
		action: "stop",
		round: state.loop.round,
		state: { ...state, loop: stoppedLoop, doneAt: at, outcome: exhausted ? "exhausted" : "stopped" },
		report,
		text: [renderVerifyReport(report, stoppedLoop), "", `⛔ stopped: ${decision.reason}`, `goal not proven: ${state.goal}`, "report exactly this to the human once — do not keep spinning"].join("\n"),
	};
};

export const buildGoalToolText = (started: GoalRunState, step: GoalStep): string =>
	[
		started.loop.round === 0 ? `goal confirmed once: ${started.goal}` : `goal still running: ${started.goal}`,
		"",
		step.text,
	].join("\n");

export const goalFingerprint = (report: VerifyReport): string => evidenceFingerprint(report);
