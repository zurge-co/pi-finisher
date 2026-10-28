import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatPanelRow, liveRuns, panelRowEntries, type PanelOptions, type PanelRun } from "./agent-panel.ts";
import { GOAL_HIT } from "./goal-page.ts";
import { REPORT_HIT, reportIdleTail, reportRowText, withReportTail, type HudReport } from "./report-page.ts";
import { IDLE_TOKEN, raceIdleLine, raceSegment, raceStagePaint, raceStageToken, raceState, type Race, type RaceGoal } from "./race-state.ts";

export const HUD_MARK = "▚";
export const HUD_MAX_ROWS = 6;
export const HUD_MIN_BOX_WIDTH = 18;

export type HudGoal = RaceGoal;

export interface HudInput {
	runs: PanelRun[];
	width: number;
	goal?: HudGoal;
	report?: HudReport;
	now?: number;
	maxRows?: number;
}

const padTo = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - visibleWidth(s)));

const fit = (s: string, n: number): string => padTo(truncateToWidth(s, Math.max(0, n), "…"), n);

const raceOf = (input: HudInput): Race => raceState({ goal: input.goal, runs: input.runs, now: input.now });

export const hudActive = (input: HudInput): boolean =>
	liveRuns(input.runs).length > 0 || (!!input.goal && !input.goal.doneAt);

export const goalSegment = (race: Race): string => raceSegment(race);

export const boxTop = (segments: string[], width: number): string => {
	const inner = width - 2;
	const body = truncateToWidth(segments.filter(Boolean).join(" ─ "), inner - 4, "…");
	return `╭─ ${padTo(body, inner - 4)} ─╮`;
};

export const boxLine = (text: string, width: number): string => `│ ${fit(text, width - 4)} │`;

export const boxBottom = (width: number): string => `╰${"─".repeat(Math.max(0, width - 2))}╯`;

export const hudRowEntries = (input: HudInput, maxRows = HUD_MAX_ROWS): { text: string; hit: number }[] => {
	const window = input.runs.slice(-Math.max(maxRows * 3, maxRows));
	const offset = input.runs.length - window.length;
	const opts: PanelOptions = { width: Math.max(20, input.width - 4), maxTail: 90, now: input.now, showFinished: false };
	return panelRowEntries(window, opts)
		.slice(0, maxRows)
		.map((e) => ({ text: formatPanelRow(e.row, Math.max(20, input.width - 4), 90), hit: e.index + offset }));
};

export const hudRows = (input: HudInput, maxRows = HUD_MAX_ROWS): string[] => hudRowEntries(input, maxRows).map((e) => e.text);

const shownReport = (input: HudInput): HudReport | undefined => input.report;

export const hudIdleLine = (input: HudInput): string => {
	const base = raceIdleLine(raceOf({ ...input, width: 0 }), HUD_MARK);
	const report = shownReport(input);
	return report ? withReportTail(base, reportIdleTail(report), input.width) : truncateToWidth(base, Math.max(0, input.width), "…");
};
export const hudLines = (input: HudInput): string[] => hudFrames(input).map((f) => f.text);

export type HudKind = "border" | "goal" | "report" | "row" | "idle";

export interface HudFrame {
	kind: HudKind;
	text: string;
	hit?: number;
	token?: string;
}

const ROW_STATE_FG: Record<string, string | undefined> = { "▶": undefined, "✓": "success", "✗": "error" };

const MARK_ROW = /^(\S+\s+)([▶✓✗])(.*)$/;

const rowToken = (text: string, stage: string): string => ROW_STATE_FG[text.match(MARK_ROW)?.[2] ?? ""] ?? stage;

const REPORT_STATE_FG: Record<string, string | undefined> = { verified: "success", "needs-human": "warning", halted: "error" };

const reportToken = (report: HudReport, stage: string): string => REPORT_STATE_FG[report.outcome ?? ""] ?? stage;

export const hudSignature = (input: Omit<HudInput, "width">): string => {
	const now = input.now ?? Date.now();
	const live = liveRuns(input.runs).map((r) => [r.role, r.slotId ?? "", r.model ?? "", Math.round((now - (r.startedAt ?? r.at)) / 1000), r.streamTail ?? ""]);
	const done = input.runs.filter((r) => r.status !== "running").length;
	const race = raceOf({ ...input, now, width: 0 });
	const g = input.goal ? [input.goal.goal, race.phase, race.lap, race.laps, race.totalClock, race.lapClock, input.goal.doneAt ?? 0] : null;
	const report = shownReport({ ...input, now, width: 0 });
	const r = report ? [report.at ?? 0, report.outcome ?? "", report.laps ?? 0] : null;
	return JSON.stringify([live, done, g, r]);
};

export interface HudTheme {
	fg: (token: string, text: string) => string;
}

export const hudPaint = (frames: HudFrame[], theme: HudTheme, race?: Race): string[] => {
	const stage = raceStageToken(race) ?? IDLE_TOKEN;
	return frames.map(({ kind, text, token }) => {
		const paint = token ?? stage;
		if (kind !== "row") return theme.fg(paint, text);
		const m = text.match(MARK_ROW);
		if (!m) return theme.fg(paint, text);
		return m[1] + theme.fg(paint, m[2]) + m[3];
	});
};

export const hudFrames = (input: HudInput): HudFrame[] => {
	const width = Math.max(8, Math.floor(input.width));
	const race = raceOf({ ...input, width });
	const stage = raceStagePaint(race);
	const report = shownReport(input);
	if (!hudActive(input)) return [{ kind: "idle", text: hudIdleLine({ ...input, width }), token: stage, ...(report ? { hit: REPORT_HIT } : {}) }];
	const live = liveRuns(input.runs).length;
	const clock = raceSegment(race);
	const segments = [clock ? `${HUD_MARK} ${clock}` : HUD_MARK, live ? `${live} live · click a row · ctrl+_ pages` : ""];
	const body: HudFrame[] = [
		...(input.goal ? [{ kind: "goal" as const, text: truncateToWidth(`▸ ${clip(input.goal.goal, 120)}`, Math.max(0, width - 4), "…"), hit: GOAL_HIT, token: stage }] : []),
		...(report ? [{ kind: "report" as const, text: truncateToWidth(reportRowText(report), Math.max(0, width - 4), "…"), hit: REPORT_HIT, token: reportToken(report, stage) }] : []),
		...hudRowEntries(input).map(({ text, hit }) => ({ kind: "row" as const, text, hit, token: rowToken(text, stage) })),
	];
	if (width < HUD_MIN_BOX_WIDTH)
		return [...segments.filter(Boolean).map((text) => ({ kind: "row" as const, text, token: stage })), ...body].map((f) => ({ ...f, text: truncateToWidth(f.text, width, "…") }));
	return [
		{ kind: "border", text: boxTop(segments, width), token: stage },
		...body.map((f) => ({ kind: f.kind, text: boxLine(f.text, width), token: f.token, ...(f.hit !== undefined ? { hit: f.hit } : {}) })),
		{ kind: "border", text: boxBottom(width), token: stage },
	];
};

export const hudRender = (input: HudInput, theme: HudTheme): { lines: string[]; hits: (number | undefined)[] } => {
	const frames = hudFrames(input);
	const race = raceOf({ ...input, width: 0 });
	return { lines: hudPaint(frames, theme, race), hits: frames.map((f) => f.hit) };
};

export const hudHitMap = (input: HudInput): (number | undefined)[] => hudFrames(input).map((f) => f.hit);
