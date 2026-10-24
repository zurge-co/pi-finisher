import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatPanelRow, liveRuns, panelRowEntries, type PanelOptions, type PanelRun } from "./agent-panel.ts";
import { raceIdleLine, raceLampToken, raceSegment, raceState, type Race, type RaceGoal } from "./race-state.ts";

export const HUD_MARK = "▚";
export const HUD_NAME = "finisher";
export const HUD_MAX_ROWS = 6;
export const HUD_MIN_BOX_WIDTH = 18;

export type HudGoal = RaceGoal;

export interface HudInput {
	runs: PanelRun[];
	width: number;
	goal?: HudGoal;
	flags?: number;
	hygiene?: number;
	escalations?: number;
	lanes?: number;
	now?: number;
	maxRows?: number;
}

const padTo = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - visibleWidth(s)));

const fit = (s: string, n: number): string => padTo(truncateToWidth(s, Math.max(0, n), "…"), n);

const raceOf = (input: HudInput): Race =>
	raceState({ goal: input.goal, runs: input.runs, lanes: input.lanes, now: input.now });

export const hudActive = (input: HudInput): boolean =>
	liveRuns(input.runs).length > 0 || (!!input.goal && !input.goal.doneAt);

export const goalSegment = (race: Race): string => raceSegment(race);

export const tallySegment = (input: HudInput): string => {
	const parts: string[] = [];
	if (input.flags) parts.push(`⚠ ${input.flags}`);
	if (input.hygiene) parts.push(`🧹 ${input.hygiene}`);
	if (input.escalations) parts.push(`🚨 ${input.escalations}`);
	return parts.join(" · ");
};

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

export const hudIdleLine = (input: HudInput): string =>
	truncateToWidth(raceIdleLine(raceOf({ ...input, width: 0 }), HUD_MARK, HUD_NAME, tallySegment(input)), Math.max(0, input.width), "…");
export const hudLines = (input: HudInput): string[] => hudFrames(input).map((f) => f.text);

export type HudKind = "border" | "goal" | "row" | "idle";

export interface HudFrame {
	kind: HudKind;
	text: string;
	hit?: number;
}

export const hudSignature = (input: Omit<HudInput, "width">): string => {
	const now = input.now ?? Date.now();
	const live = liveRuns(input.runs).map((r) => [r.role, r.slotId ?? "", r.model ?? "", Math.round((now - (r.startedAt ?? r.at)) / 1000), r.streamTail ?? ""]);
	const done = input.runs.filter((r) => r.status !== "running").length;
	const race = raceOf({ ...input, now, width: 0 });
	const g = input.goal ? [input.goal.goal, race.phase, race.lap, race.laps, race.totalClock, race.lapClock, input.goal.doneAt ?? 0] : null;
	return JSON.stringify([live, done, g, input.flags ?? 0, input.hygiene ?? 0, input.escalations ?? 0, race.busy, race.lanes]);
};

const ROW_STATE_FG: Record<string, string> = { "▶": "accent", "✓": "success", "✗": "error" };

export interface HudTheme {
	fg: (token: string, text: string) => string;
}

export const hudPaint = (frames: HudFrame[], theme: HudTheme, race?: Race): string[] =>
	frames.map(({ kind, text }, i) => {
		if (kind === "border") {
			if (i !== 0 || !race) return theme.fg("borderAccent", text);
			const seg = raceSegment(race);
			const at = text.indexOf(seg);
			if (at < 0) return theme.fg("borderAccent", text);
			return theme.fg("borderAccent", text.slice(0, at)) + theme.fg(raceLampToken(race), seg) + theme.fg("borderAccent", text.slice(at + seg.length));
		}
		if (kind === "goal") return theme.fg("accent", text);
		if (kind === "idle") {
			if (!race) return theme.fg("dim", text);
			const seg = raceSegment(race);
			const at = text.indexOf(seg);
			if (at < 0) return theme.fg("dim", text);
			return theme.fg("dim", text.slice(0, at)) + theme.fg(raceLampToken(race), seg) + theme.fg("dim", text.slice(at + seg.length));
		}
		const m = text.match(/^(\S+\s+)([▶✓✗])(.*)$/);
		if (!m) return text;
		return m[1] + theme.fg(ROW_STATE_FG[m[2]] ?? "muted", m[2]) + m[3];
	});

export const hudFrames = (input: HudInput): HudFrame[] => {
	const width = Math.max(8, Math.floor(input.width));
	const race = raceOf({ ...input, width });
	if (!hudActive(input)) return [{ kind: "idle", text: truncateToWidth(raceIdleLine(race, HUD_MARK, HUD_NAME, tallySegment(input)), width, "…") }];
	const live = liveRuns(input.runs).length;
	const segments = [`${HUD_MARK} ${HUD_NAME}`, raceSegment(race), live ? `${live} live · click a row · ctrl+_ pages` : "", tallySegment(input)];
	const body: HudFrame[] = [
		...(input.goal ? [{ kind: "goal" as const, text: truncateToWidth(`▸ ${clip(input.goal.goal, 120)}`, Math.max(0, width - 4), "…") }] : []),
		...hudRowEntries(input).map(({ text, hit }) => ({ kind: "row" as const, text, hit })),
	];
	if (width < HUD_MIN_BOX_WIDTH)
		return [...segments.filter(Boolean).map((text) => ({ kind: "row" as const, text })), ...body].map((f) => ({ ...f, text: truncateToWidth(f.text, width, "…") }));
	return [
		{ kind: "border", text: boxTop(segments, width) },
		...body.map((f) => ({ kind: f.kind, text: boxLine(f.text, width), ...(f.hit !== undefined ? { hit: f.hit } : {}) })),
		{ kind: "border", text: boxBottom(width) },
	];
};

export const hudRender = (input: HudInput, theme: HudTheme): { lines: string[]; hits: (number | undefined)[] } => {
	const frames = hudFrames(input);
	const race = raceOf({ ...input, width: 0 });
	return { lines: hudPaint(frames, theme, race), hits: frames.map((f) => f.hit) };
};

export const hudHitMap = (input: HudInput): (number | undefined)[] => hudFrames(input).map((f) => f.hit);
