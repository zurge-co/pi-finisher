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

export type GoalAskOutcome = "confirmed" | "declined" | "unavailable";

export const GOAL_CONFIRM_TITLE = "▚ confirm this goal once";
export const GOAL_CONFIRM_KEYS = "y / enter = confirm  •  n / esc = decline";
export const GOAL_TOO_MANY_CASES = 24;

export const NON_GOAL_PREFIX = "verify: ";

export type GoalConfirmLineKind = "goal" | "blank" | "header" | "case" | "note";

export interface GoalConfirmLine {
	kind: GoalConfirmLineKind;
	text: string;
}

export const goalConfirmLines = (goal: string, cases: string[]): GoalConfirmLine[] => [
	{ kind: "goal", text: goal.trim() || "(no goal stated)" },
	{ kind: "blank", text: "" },
	{ kind: "header", text: "the goal is met when every case below is true of the real result:" },
	...cases.map((c, i) => ({ kind: "case" as const, text: `${i + 1}. ${c}` })),
	{ kind: "blank", text: "" },
	{ kind: "note", text: "after you confirm: no further approval, no token or cost ceiling — every case is verified and the report comes once." },
];

export const tooManyCasesNote = (n: number): string =>
	`finisher_goal: ${n} cases is too many for one confirmation to be honest — the human cannot weigh that list. Group them into at most ${GOAL_TOO_MANY_CASES} cases the human can read, then ask once. Nothing was started.`;

export const caseKey = (c: string): string => c.replace(/\s+/g, " ").trim().toLowerCase();

export const sameCaseSet = (a: string[], b: string[]): boolean => {
	const left = new Set(a.map(caseKey).filter(Boolean));
	const right = new Set(b.map(caseKey).filter(Boolean));
	if (left.size !== right.size) return false;
	for (const c of left) if (!right.has(c)) return false;
	return true;
};

export const casesOnlyChanged = (previous: string[], next: string[]): string[] =>
	next.filter((c) => !previous.some((p) => caseKey(p) === caseKey(c)));

export const droppedCases = (previous: string[], next: string[]): string[] =>
	previous.filter((p) => !next.some((c) => caseKey(c) === caseKey(p)));

export const GOAL_CHANGE_NOTE =
	"the confirmed goal was left exactly as it was — a goal and its cases can only change when the human confirms the change in the dialog. Call finisher_goal again with the same goal to continue it, or state the new goal and let the human confirm it.";

export const GOAL_DECLINED_NOTE =
	"goal NOT confirmed — the human declined the goal or its cases, so nothing was started. Re-state the goal, or the cases that were wrong, and call finisher_goal again. Do not begin the work on your own.";

export const unconfirmedGoalNote = (allPass: boolean): string =>
	[
		`no goal was confirmed, so this run did not drive one — the verdict below is the evidence, and nothing was recorded as the goal:`,
		allPass
			? `every case passed on its own evidence. Present this to the human and call finisher_goal with the goal they want; that dialog is the only thing that turns a case list into a goal.`
			: `at least one case did not pass. Fix the real cause, verify again, and only call finisher_goal once the human is there to confirm the goal.`,
		`(the run is named "verify: …" in the widget because there is no goal to name)`,
	].join("\n");

export const GOAL_NO_UI_NOTE =
	"goal cannot be confirmed: this session has no dialog to ask in (headless/print mode). Run it from the interactive TUI so the human can confirm once, and do not start the work without that yes.";

export const goalConfirmModeLine = (): string =>
	"mode: goal-confirm → autonomous run to a verified result (no per-step approval, no token or cost ceiling, model ladder priority1..priority5 used in parallel)";
