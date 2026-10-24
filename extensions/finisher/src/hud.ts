import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clip, formatPanelRow, liveRuns, panelRowEntries, type PanelOptions, type PanelRun } from "./agent-panel.ts";
import { fmtTok } from "./subagent-log.ts";

export const HUD_MARK = "▚";
export const HUD_NAME = "finisher";
export const HUD_MAX_ROWS = 6;
export const HUD_MIN_BOX_WIDTH = 18;

export interface HudGoal {
	goal: string;
	round?: number;
	maxRounds?: number;
	doneAt?: number;
	outcome?: "verified" | "needs-human" | "halted";
}

export interface HudInput {
	runs: PanelRun[];
	width: number;
	turns?: number;
	tokens?: number;
	goal?: HudGoal;
	flags?: number;
	hygiene?: number;
	escalations?: number;
	now?: number;
	maxRows?: number;
}

const padTo = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - visibleWidth(s)));

const fit = (s: string, n: number): string => padTo(truncateToWidth(s, Math.max(0, n), "…"), n);

export const hudActive = (input: HudInput): boolean =>
	liveRuns(input.runs).length > 0 || (!!input.goal && !input.goal.doneAt);

export const goalSegment = (goal: HudGoal): string => {
	if (goal.outcome) return `goal ${goal.outcome}`;
	const round = goal.round ? `round ${goal.round}${goal.maxRounds ? `/${goal.maxRounds}` : ""}` : "round 0";
	return `goal ${round}`;
};

export const tallySegment = (input: HudInput): string => {
	const parts = [`turns ${input.turns ?? 0}`, `tok ${fmtTok(input.tokens ?? 0)}`];
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

export const hudIdleLine = (input: HudInput): string => {
	const tail = `· ${tallySegment(input)}`;
	const head = `${HUD_MARK} ${HUD_NAME} · idle `;
	return truncateToWidth(`${head}${tail}`, Math.max(0, input.width), "…");
};

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
	const g = input.goal ? [input.goal.goal, input.goal.round ?? 0, input.goal.maxRounds ?? 0, input.goal.doneAt ?? 0, input.goal.outcome ?? ""] : null;
	return JSON.stringify([live, done, g, input.turns ?? 0, input.tokens ?? 0, input.flags ?? 0, input.hygiene ?? 0, input.escalations ?? 0]);
};

const STATE_FG: Record<string, string> = { "▶": "accent", "✓": "success", "✗": "error" };

export interface HudTheme {
	fg: (token: string, text: string) => string;
}

export const hudPaint = (frames: HudFrame[], theme: HudTheme): string[] =>
	frames.map(({ kind, text }) => {
		if (kind === "border") return theme.fg("borderAccent", text);
		if (kind === "goal") return theme.fg("accent", text);
		if (kind === "idle") return theme.fg("dim", text);
		const m = text.match(/^(\S+\s+)([▶✓✗])(.*)$/);
		if (!m) return text;
		return m[1] + theme.fg(STATE_FG[m[2]] ?? "muted", m[2]) + m[3];
	});

export const hudFrames = (input: HudInput): HudFrame[] => {
	const width = Math.max(8, Math.floor(input.width));
	if (!hudActive(input)) return [{ kind: "idle", text: hudIdleLine({ ...input, width }) }];
	const live = liveRuns(input.runs).length;
	const segments = [`${HUD_MARK} ${HUD_NAME}`, input.goal ? goalSegment(input.goal) : "", live ? `${live} live · click a row · ctrl+_ pages` : "", tallySegment(input)];
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

export const styledHudLines = (input: HudInput, theme: HudTheme): string[] => hudRender(input, theme).lines;

export const hudRender = (input: HudInput, theme: HudTheme): { lines: string[]; hits: (number | undefined)[] } => {
	const frames = hudFrames(input);
	return { lines: hudPaint(frames, theme), hits: frames.map((f) => f.hit) };
};

export const hudHitMap = (input: HudInput): (number | undefined)[] => hudFrames(input).map((f) => f.hit);
