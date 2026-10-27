import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { allLapsDone, lapIndex, planOf, totalPhases } from "./goal-phase.ts";
import { racedMs, raceState, verifyMs, clockLabel, type Race } from "./race-state.ts";
import { SCROLL_CLOSE_QUIT, SCROLL_FOOTER_ROWS, SCROLL_MIN_ROWS, SCROLL_OVERLAY_SHARE, scrollCeiling, scrollKeysLine, scrollMaxOffset, scrollStep, scrollWindow, type ScrollCloseKey } from "./scroll-page.ts";

export const GOAL_HIT = -1;
export const GOAL_PAGE_MARK = "▚";
export const GOAL_PAGE_MIN_ROWS = SCROLL_MIN_ROWS;
export const GOAL_PAGE_OVERLAY_SHARE = SCROLL_OVERLAY_SHARE;
export const GOAL_PAGE_CLOSE: readonly ScrollCloseKey[] = SCROLL_CLOSE_QUIT;
export const GOAL_PAGE_KEYS = scrollKeysLine({ close: GOAL_PAGE_CLOSE });
export const GOAL_PAGE_CHROME_ROWS = 2 + SCROLL_FOOTER_ROWS;

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
	if (total <= Math.max(size, rows)) return { from: 0, to: Math.max(0, total) };
	return scrollWindow(total, Math.max(size, rows), offset);
};

export const goalPageMaxOffset = (total: number, rows: number): number => scrollMaxOffset(total, Math.max(GOAL_PAGE_MIN_ROWS, rows));

export const goalPageCeiling = (termRows: number): number => scrollCeiling(termRows, GOAL_PAGE_MIN_ROWS, GOAL_PAGE_OVERLAY_SHARE);

export const goalPageViewport = (termRows: number, headerRows: number): number =>
	Math.max(1, goalPageCeiling(termRows) - Math.max(0, Math.floor(Number.isFinite(headerRows) ? headerRows : 0)) - GOAL_PAGE_CHROME_ROWS);

export const goalPageStep = (total: number, rows: number, offset: number, action: "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom"): number => scrollStep(total, rows, offset, action);

export const goalPageLineText = (line: GoalPageLine, width: number): string[] => {
	const head = `${line.mark} ${line.position}/${line.total}`;
	const spent = line.spent ? `  (${line.spent})` : "";
	const room = Math.max(1, Math.floor(width) - 4 - visibleWidth(head));
	return wrapTextWithAnsi(`${line.text}${spent}`, room).map((text, i) => truncateToWidth(`  ${i === 0 ? head : " ".repeat(head.length)}  ${text}`, Math.max(1, Math.floor(width)), ""));
};

export const goalPageRowOf = (lines: GoalPageLine[], width: number): number[] => {
	const at: number[] = [];
	let row = 0;
	for (const line of lines) {
		at.push(row);
		row += goalPageLineText(line, width).length;
	}
	return at;
};

export const goalPageBody = (lines: GoalPageLine[], width: number, offset: number, rows: number): { from: number; to: number; text: string[] } => {
	const rendered = lines.flatMap((line) => goalPageLineText(line, width));
	const height = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
	const win = scrollWindow(rendered.length, height, offset);
	return { from: win.from, to: win.to, text: rendered.slice(win.from, win.to) };
};
