import { type Spec } from "./types.ts";

export type GoalGateState = "unconfirmed" | "confirmed";

export interface GoalConfirmState {
	goal: string;
	confirmedAt?: number;
	signature?: string;
}

export const goalGate = (g: GoalConfirmState | undefined): GoalGateState => (g?.confirmedAt ? "confirmed" : "unconfirmed");

export const confirmGoal = (g: GoalConfirmState, at = Date.now()): GoalConfirmState => ({
	...g,
	confirmedAt: at,
	signature: `${g.goal.trim().toLowerCase()}@${at}`,
});

export const goalCases = (spec: Pick<Spec, "crossCheck" | "outcomes" | "intent">): string[] => {
	const cases = (spec.crossCheck ?? []).map((c) => c.trim()).filter(Boolean);
	if (cases.length) return cases;
	const legacy = (spec.outcomes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
	if (legacy.length) return legacy;
	return [spec.intent.trim()];
};

export const buildGoalConfirmPrompt = (goal: string, cases: string[]): string =>
	[
		`Confirm this goal once — after confirming, no further approval is asked for: ${goal.trim() || "(no goal stated)"}`,
		"",
		"The goal is met when every case below is true of the real result:",
		...cases.map((c, i) => `  ${i + 1}. ${c}`),
		"",
		"After confirming: the agent picks its own approach, verifies the result itself and keeps working until every case holds. No gates, no second signature.",
	].join("\n");

export const GOAL_AFTER_CONFIRM_NOTE = "goal confirmed — no gate between here and the result; verify every case and report once at the end";

export const goalConfirmModeLine = (): string =>
	"mode: goal-confirm → autonomous run to a verified result (no per-step approval, no token or cost ceiling, model ladder priority1..priority5 used in parallel)";
