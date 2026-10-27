import { Key, Text, matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { panelize } from "./models.ts";
import { GOAL_SCROLL_KEYS, goalChrome, goalConfirmLines, type GoalAskOutcome, type GoalChromeOverrides, type GoalConfirmLine, type GoalConfirmLineKind } from "./goal-confirm.ts";
import { graphemes, breakGraphemes, DEFAULT_GOAL_LANG } from "./human-language.ts";
import { type CustomDialogOptions, type FinisherCustom, type HarnessContext } from "./kit.ts";
import { MAX_TIMER_MS, readConfirmTimeout } from "./goal-run.ts";

export interface GoalPicker {
	ctx: ExtensionContext;
	custom: FinisherCustom;
}

export const GOAL_DIALOG_OVERLAY: CustomDialogOptions = { overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "85%" } };

export const GOAL_DIALOG_CHROME_ROWS = 6;

export const GOAL_DIALOG_MIN_VIEWPORT = 1;

export const GOAL_DIALOG_SCROLL_KEYS = GOAL_SCROLL_KEYS;

export type GoalDialogAction = "confirm" | "decline" | "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom" | "none";

export const goalDialogAction = (data: string): GoalDialogAction => {
	if (matchesKey(data, Key.enter) || data === "y" || data === "Y") return "confirm";
	if (matchesKey(data, Key.escape) || data === "n" || data === "N") return "decline";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) return "pageUp";
	if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) return "pageDown";
	if (data === "g") return "top";
	if (data === "G") return "bottom";
	return "none";
};

export const goalDialogWrap = (text: string, width: number): string[] => {
	const limit = Math.max(1, Math.floor(width));
	const words = text.split(/\s+/).filter(Boolean);
	if (!words.length) return [""];
	const out: string[] = [];
	let line = "";
	const push = (piece: string): void => {
		out.push(piece);
		line = "";
	};
	for (const word of words) {
		if (graphemes(word).length > limit) {
			if (line) push(line);
			const pieces = breakGraphemes(word, limit);
			for (const piece of pieces.slice(0, -1)) out.push(piece);
			line = pieces[pieces.length - 1];
			continue;
		}
		const next = line ? `${line} ${word}` : word;
		if (graphemes(next).length <= limit) line = next;
		else {
			push(line);
			line = word;
		}
	}
	if (line) out.push(line);
	return out;
};

export interface GoalDialogRow {
	kind: GoalConfirmLineKind;
	text: string;
}

export const goalDialogRows = (lines: GoalConfirmLine[], width: number): GoalDialogRow[] =>
	lines.flatMap((line) => (line.kind === "blank" ? [{ kind: "blank" as const, text: "" }] : goalDialogWrap(line.text, width).map((text) => ({ kind: line.kind, text }))));

export const goalDialogCap = (termRows: number): number => Math.max(1, Math.floor((Number.isFinite(termRows) && termRows > 0 ? termRows : 24) * 0.85));

export interface GoalDialogFit {
	top: number;
	viewport: number;
	total: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

export const goalDialogFit = (rowCount: number, top: number, cap: number, measure: (viewport: number, top: number) => number, minViewport = GOAL_DIALOG_MIN_VIEWPORT): GoalDialogFit => {
	const total = Math.max(0, Math.floor(rowCount));
	const budget = Math.max(0, Math.floor(cap));
	const at = goalDialogScroll(top, Math.max(1, minViewport), total, "none");
	let viewport = Math.max(1, Math.min(Math.max(1, total), budget));
	for (let pass = 0; pass < 8; pass++) {
		const drawn = measure(viewport, at);
		if (drawn <= budget || viewport <= 1) break;
		viewport = Math.max(1, viewport - (drawn - budget));
	}
	const view = Math.max(1, Math.min(viewport, Math.max(1, total)));
	const settledTop = goalDialogScroll(at, view, total, "none");
	return { top: settledTop, viewport: view, total, hiddenAbove: settledTop, hiddenBelow: Math.max(0, total - settledTop - Math.min(view, total)) };
};

export const goalDialogMaxTop = (total: number, viewport: number): number => Math.max(0, total - Math.max(1, viewport));

export const goalDialogScroll = (top: number, viewport: number, total: number, action: GoalDialogAction): number => {
	const maxTop = goalDialogMaxTop(total, viewport);
	const now = Number.isFinite(top) ? Math.max(0, Math.floor(top)) : 0;
	const page = Math.max(1, viewport - 1);
	const moved =
		action === "up" ? now - 1 : action === "down" ? now + 1 : action === "pageUp" ? now - page : action === "pageDown" ? now + page : action === "top" ? 0 : action === "bottom" ? maxTop : now;
	return Math.max(0, Math.min(moved, maxTop));
};

export interface GoalDialogWindow {
	rows: GoalDialogRow[];
	top: number;
	total: number;
	viewport: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

export const goalDialogWindow = (rows: GoalDialogRow[], top: number, viewport: number): GoalDialogWindow => {
	const shown = Math.max(1, Math.floor(viewport));
	const at = goalDialogScroll(top, shown, rows.length, "none");
	const slice = rows.slice(at, at + shown);
	return { rows: slice, top: at, total: rows.length, viewport: shown, hiddenAbove: at, hiddenBelow: Math.max(0, rows.length - at - slice.length) };
};

export const goalDialogIndicator = (win: GoalDialogWindow): string | undefined => {
	if (win.hiddenAbove <= 0 && win.hiddenBelow <= 0) return undefined;
	const last = win.top + win.rows.length;
	return `lines ${win.top + 1}-${last} of ${win.total}  (${win.hiddenAbove} above, ${win.hiddenBelow} below)`;
};

export const goalDialogIndicatorWorst = (total: number): string => `lines ${total}-${total} of ${total}  (${total} above, ${total} below)`;

export const goalLineColor = (kind: GoalConfirmLineKind): string =>
	kind === "goal" ? "accent" : kind === "header" ? "muted" : kind === "case" ? "text" : "dim";

export const askGoalViaPicker = (ctx: ExtensionContext, goal: string, cases: string[], lang?: string, chrome?: GoalChromeOverrides): Promise<GoalAskOutcome> => {
	const detail = goalConfirmLines(goal, cases, lang, chrome)
		.filter((l) => l.kind !== "blank")
		.map((l) => l.text);
	return ctx.ui.confirm(goalChrome(lang, chrome).title, detail.join("\n")).then((ok) => (ok ? "confirmed" : "declined") as GoalAskOutcome);
};

const TERM_ROWS = (tui: unknown): number => {
	const terminal = (tui as { terminal?: { rows?: number } } | undefined)?.terminal;
	const rows = terminal?.rows;
	if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) return rows;
	const fallback = process.stdout.rows;
	return typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0 ? fallback : 24;
};

const askGoalViaDialog = ({ ctx, custom }: GoalPicker, goal: string, cases: string[], timeoutMs = 0, lang?: string, chrome?: GoalChromeOverrides): Promise<GoalAskOutcome> =>
	custom<GoalAskOutcome | null>(
		ctx,
		GOAL_DIALOG_OVERLAY,
		(tui, theme, _kb, finish) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let top = 0;
			let shown: GoalDialogWindow = { rows: [], top: 0, total: 0, viewport: GOAL_DIALOG_MIN_VIEWPORT, hiddenAbove: 0, hiddenBelow: 0 };
			const done = (v: GoalAskOutcome | null): void => {
				if (timer) clearTimeout(timer);
				timer = undefined;
				finish(v);
			};
			if (timeoutMs > 0) timer = setTimeout(() => done("timeout"), Math.min(timeoutMs, MAX_TIMER_MS));
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const lines = goalConfirmLines(goal, cases, lang, chrome);
			const words = goalChrome(lang, chrome);
			const move = (action: GoalDialogAction): void => {
				top = goalDialogScroll(top, shown.viewport, shown.total, action);
				tui.requestRender();
			};
			const assemble = (all: GoalDialogRow[], win: GoalDialogWindow, w: number, indicatorRows: number): string[] => {
				const out: string[] = [...border.render(w)];
				out.push(...new Text(theme.fg("accent", theme.bold(words.title)), 1, 0).render(w));
				for (const row of win.rows) {
					if (row.kind === "blank") {
						out.push("");
						continue;
					}
					out.push(...new Text(theme.fg(goalLineColor(row.kind) as never, row.text), 2, 0).render(w));
				}
				const indicator = goalDialogIndicator(win);
				const painted = indicator && indicatorRows > 0 ? new Text(theme.fg("dim", indicator), 1, 0).render(w) : [];
				out.push(...painted);
				for (let i = painted.length; i < indicatorRows; i++) out.push("");
				out.push(...new Text(theme.fg("dim", words.keysLine), 1, 0).render(w));
				out.push(...new Text(theme.fg("dim", words.keys), 1, 0).render(w));
				out.push(...border.render(w));
				return panelize(theme, out, w);
			};
			const indicatorSlot = (total: number, w: number): number => new Text(theme.fg("dim", goalDialogIndicatorWorst(total)), 1, 0).render(w).length;
			return {
				render: (w: number) => {
					const all = goalDialogRows(lines, Math.max(12, w - 4));
					const cap = goalDialogCap(TERM_ROWS(tui));
					const slot = indicatorSlot(all.length, w);
					const drawAt = (viewport: number, at: number, rows: number): string[] => assemble(all, goalDialogWindow(all, at, viewport), w, rows);
					const wanted = drawAt(1, 0, slot).length <= cap ? slot : 0;
					const fit = goalDialogFit(all.length, top, cap, (viewport, at) => drawAt(viewport, at, wanted).length);
					const win = goalDialogWindow(all, fit.top, fit.viewport);
					top = win.top;
					shown = win;
					return drawAt(fit.viewport, fit.top, wanted);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					const action = goalDialogAction(data);
					if (action === "confirm") done("confirmed");
					else if (action === "decline") done("declined");
					else if (action === "none") return;
					else move(action);
				},
				handleMouse: (event: TuiMouseEvent) => {
					const delta = event.wheelDelta;
					if (event.type !== "wheel" || !delta) return undefined;
					move(delta < 0 ? "up" : "down");
					return { handled: true, render: true };
				},
			};
		},
		() => true,
	).then((outcome) => outcome ?? "declined");

export const askGoalConfirmation = (picker: GoalPicker, goal: string, cases: string[], timeoutMs?: number, lang?: string, chrome?: GoalChromeOverrides): Promise<GoalAskOutcome> => {
	if (!picker.ctx.hasUI) return Promise.resolve("unavailable");
	const ask = (): Promise<GoalAskOutcome> =>
		picker.ctx.mode !== "tui"
			? askGoalViaPicker(picker.ctx, goal, cases, lang, chrome).catch(() => "declined" as GoalAskOutcome)
			: Promise.resolve(askGoalViaDialog(picker, goal, cases, timeoutMs, lang, chrome)).catch(() => askGoalViaPicker(picker.ctx, goal, cases, lang, chrome).catch(() => "declined" as GoalAskOutcome));
	const timed = (run: Promise<GoalAskOutcome>): Promise<GoalAskOutcome> => {
		if (!timeoutMs || timeoutMs <= 0) return run;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<GoalAskOutcome>((res) => {
			timer = setTimeout(() => res("timeout"), Math.min(timeoutMs, MAX_TIMER_MS));
		});
		return Promise.race([run, expired]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};
	return timed(ask());
};

export const createGoalPicker = (ctx: HarnessContext) => {
	const custom = ctx.finisherCustom;
	const askGoalConfirm: HarnessContext["askGoalConfirm"] = (toolCtx, goal, cases) =>
		askGoalConfirmation({ ctx: toolCtx, custom }, goal, cases, readConfirmTimeout(toolCtx.cwd), ctx.state.goalLang ?? ctx.state.humanLang, ctx.state.goalChrome);
	return { askGoalConfirm };
};
