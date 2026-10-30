export const COMPACT_HOLD_NOTE = "compaction held: the human must still read this run's outcome";

export type GoalOutcome = "verified" | "needs-human" | "halted";

export const HELD_OUTCOMES = ["needs-human", "halted"] as const;

export interface HeldGoal {
	doneAt?: number;
	outcome?: GoalOutcome;
}

export interface CompactionHoldInput {
	reason: "manual" | "threshold" | "overflow";
	goal?: HeldGoal;
	humanAt?: number;
}

export const outcomeNeedsHuman = (outcome: GoalOutcome | undefined): boolean => !!outcome && (HELD_OUTCOMES as readonly string[]).includes(outcome);

export const reportUnread = (goal: HeldGoal | undefined, humanAt: number | undefined): boolean => {
	const doneAt = goal?.doneAt;
	if (!doneAt || !outcomeNeedsHuman(goal?.outcome)) return false;
	return doneAt > (humanAt ?? 0);
};

export const heldGoalFor = (state: { goalDriver?: HeldGoal; lastReport?: { at: number; outcome: GoalOutcome } }): HeldGoal | undefined =>
	state.goalDriver?.doneAt ? state.goalDriver : state.lastReport ? { doneAt: state.lastReport.at, outcome: state.lastReport.outcome } : state.goalDriver;

export const compactionHold = (input: CompactionHoldInput): { hold: boolean; note?: string } => {
	if (input.reason === "manual") return { hold: false };
	if (!reportUnread(input.goal, input.humanAt)) return { hold: false };
	return { hold: true, note: COMPACT_HOLD_NOTE };
};
