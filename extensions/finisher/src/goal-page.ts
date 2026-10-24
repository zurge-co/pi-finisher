import { allLapsDone, lapIndex, planOf, totalPhases } from "./goal-phase.ts";
import { racedMs, raceState, verifyMs, clockLabel, type Race } from "./race-state.ts";

export const GOAL_HIT = -1;
export const GOAL_PAGE_MARK = "▚";
export const GOAL_PAGE_KEYS = "Esc close · ↑↓ scroll · PgUp/PgDn page · g/G top/bottom";
export const GOAL_PAGE_MIN_ROWS = 4;

export interface GoalPageGoal {
	goal: string;
	confirmedAt?: number;
	doneAt?: number;
	outcome?: "verified" | "needs-human" | "halted";
	phases?: { id: string; text: string; round: number; addedAt: number; lapMs?: number }[];
	lap?: number;
	lapAt?: number;
	lapMs?: number[];
}

export type GoalPageMark = "✓" | "▶" | "·";

export interface GoalPageLine {
	mark: GoalPageMark;
	position: number;
	total: number;
	text: string;
	spent: string;
}

export const goalPageLines = (goal: GoalPageGoal | undefined): GoalPageLine[] => {
	const plan = planOf(goal);
	const total = totalPhases(plan);
	const closedAll = allLapsDone(plan);
	const at = lapIndex(plan);
	return plan.phases.map((phase, i) => {
		const position = i + 1;
		const closed = closedAll || position < at;
		const spent = Math.max(0, phase.lapMs ?? plan.lapMs[i] ?? 0);
		return {
			mark: closed ? "✓" : !closedAll && position === at ? "▶" : "·",
			position,
			total,
			text: phase.text,
			spent: closed && spent ? clockLabel(spent) : "",
		};
	});
};

export const goalPageRace = (goal: GoalPageGoal | undefined, now = Date.now()): Race | undefined =>
	goal ? raceState({ goal, now }) : undefined;

export const goalPageTitle = (goal: GoalPageGoal | undefined, now = Date.now()): string => {
	const position = goalPageLines(goal);
	const plan = planOf(goal);
	if (!position.length) return `${GOAL_PAGE_MARK} no lap declared yet`;
	const race = goalPageRace(goal, now);
	const where = allLapsDone(plan) ? `LAP ${totalPhases(plan)}/${totalPhases(plan)} closed` : `LAP ${lapIndex(plan)}/${totalPhases(plan)}`;
	return `${GOAL_PAGE_MARK} ${where} ${race?.totalClock ?? "0:00"}`;
};

export const goalPageSummary = (goal: GoalPageGoal | undefined, now = Date.now()): string => {
	const race = goalPageRace(goal, now);
	const plan = planOf(goal);
	if (!race || !totalPhases(plan)) return "";
	const parts = [
		`${race.done}/${race.laps} laps closed`,
		`laps ${clockLabel(racedMs(goal))}`,
		goal?.doneAt ? `verify ${clockLabel(verifyMs(goal, now))}` : "",
		`pit ${race.pitClock}`,
	];
	return parts.filter(Boolean).join(" · ");
};

export const goalPageLinesText = (goal: GoalPageGoal | undefined): string[] =>
	goalPageLines(goal).map((line) => `${line.mark} ${line.position}/${line.total}  ${line.text}${line.spent ? `  (${line.spent})` : ""}`);

export const goalPageWindow = (total: number, rows: number, offset: number, size = GOAL_PAGE_MIN_ROWS): { from: number; to: number } => {
	const height = Math.max(size, rows);
	if (total <= height) return { from: 0, to: total };
	const from = Math.max(0, Math.min(total - height, offset));
	return { from, to: Math.min(total, from + height) };
};

export const goalPageMaxOffset = (total: number, rows: number): number => Math.max(0, total - Math.max(GOAL_PAGE_MIN_ROWS, rows));
