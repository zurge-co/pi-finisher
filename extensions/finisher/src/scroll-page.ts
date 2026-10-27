import { Key, matchesKey } from "@earendil-works/pi-tui";

export const SCROLL_MIN_ROWS = 4;
export const SCROLL_OVERLAY_SHARE = 0.9;
export const SCROLL_FOOTER_ROWS = 1;
export const SCROLL_KEYS = "↑↓ scroll · PgUp/PgDn page";

export type ScrollMove = "up" | "down" | "pageUp" | "pageDown" | "top" | "bottom";

export type ScrollKeyAction = { dir: 1 | -1; page: boolean } | "top" | "bottom" | null;

export type RowJump = "top" | "bottom";

const ROW_JUMP_KEYS: Record<RowJump, string[]> = { top: ["Home", "g"], bottom: ["End", "G"] };

export const scrollRowKeys = (jumps: readonly RowJump[]): string[] => jumps.flatMap((jump) => ROW_JUMP_KEYS[jump] ?? []);

export type ScrollCloseKey = "Esc" | "q";

export const SCROLL_CLOSE = ["Esc"] as const satisfies readonly ScrollCloseKey[];
export const SCROLL_CLOSE_QUIT = ["Esc", "q"] as const satisfies readonly ScrollCloseKey[];

export interface ScrollKeysLine {
	close?: readonly ScrollCloseKey[];
	closeNote?: string;
	jumps?: readonly RowJump[];
	lead?: readonly string[];
	tail?: readonly string[];
}

export const scrollKeysLine = (line: ScrollKeysLine = {}): string => {
	const close = line.close ?? SCROLL_CLOSE;
	const rows = scrollRowKeys(line.jumps ?? ["top", "bottom"]);
	const note = line.closeNote ? ` ${line.closeNote}` : "";
	return [
		...(line.lead ?? []),
		close.length ? `${close.join("/")} close${note}` : "",
		SCROLL_KEYS,
		rows.length ? `${rows.join("/")} top/bottom` : "",
		...(line.tail ?? []),
	]
		.filter(Boolean)
		.join(" · ");
};

const CLOSE_MATCHERS: Record<ScrollCloseKey, (data: string) => boolean> = {
	Esc: (data) => matchesKey(data, Key.escape) || matchesKey(data, Key.enter),
	q: (data) => data === "q",
};

export const scrollCloses = (data: string, close: readonly ScrollCloseKey[] = SCROLL_CLOSE): boolean => close.some((key) => CLOSE_MATCHERS[key](data));

export const scrollKeyAction = (data: string): ScrollKeyAction => {
	if (matchesKey(data, Key.up)) return { dir: -1, page: false };
	if (matchesKey(data, Key.down)) return { dir: 1, page: false };
	if (matchesKey(data, Key.pageUp)) return { dir: -1, page: true };
	if (matchesKey(data, Key.pageDown)) return { dir: 1, page: true };
	if (matchesKey(data, Key.home) || data === "g") return "top";
	if (matchesKey(data, Key.end) || data === "G") return "bottom";
	return null;
};

export const scrollMoveOf = (act: ScrollKeyAction): ScrollMove | null =>
	act === null ? null : act === "top" || act === "bottom" ? act : act.page ? (act.dir < 0 ? "pageUp" : "pageDown") : act.dir < 0 ? "up" : "down";

export const scrollCeiling = (termRows: number, min = SCROLL_MIN_ROWS, share = SCROLL_OVERLAY_SHARE): number => {
	const rows = Number.isFinite(termRows) && termRows > 0 ? Math.floor(termRows) : 24;
	return Math.max(min, Math.floor(rows * share));
};

export const scrollHeight = (termRows: number, chromeRows: number, min = SCROLL_MIN_ROWS, share = SCROLL_OVERLAY_SHARE, footerRows = SCROLL_FOOTER_ROWS): number => {
	const chrome = Math.max(0, Math.floor(Number.isFinite(chromeRows) ? chromeRows : 0));
	const foot = Math.max(0, Math.floor(Number.isFinite(footerRows) ? footerRows : 0));
	return Math.max(1, scrollCeiling(termRows, min, share) - chrome - foot);
};

export const scrollMaxOffset = (total: number, rows: number): number => Math.max(0, Math.floor(total) - Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1)));

export const scrollStep = (total: number, rows: number, offset: number, action: ScrollMove): number => {
	const max = scrollMaxOffset(total, rows);
	const start = Math.max(0, Math.min(max, Number.isFinite(offset) ? Math.floor(offset) : 0));
	if (action === "top") return 0;
	if (action === "bottom") return max;
	const step = action === "pageUp" || action === "pageDown" ? Math.max(1, Math.floor(rows)) : 1;
	const dir = action === "up" || action === "pageUp" ? -1 : 1;
	return Math.max(0, Math.min(max, start + dir * step));
};

export interface ScrollPosition {
	offset: number;
	following: boolean;
}

export const scrollWindow = (total: number, rows: number, offset: number): { from: number; to: number } => {
	const height = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
	const from = Math.max(0, Math.min(scrollMaxOffset(total, height), Number.isFinite(offset) ? Math.floor(offset) : 0));
	return { from, to: Math.min(Math.max(0, Math.floor(total)), from + height) };
};

export const scrollApply = (total: number, rows: number, at: ScrollPosition, action: ScrollMove): ScrollPosition => {
	const offset = scrollStep(total, rows, at.offset, action);
	const max = scrollMaxOffset(total, rows);
	if (action === "bottom") return { offset, following: true };
	if (action === "top") return { offset, following: false };
	return { offset, following: max > 0 ? offset >= max : at.following };
};

export const scrollFollow = (total: number, rows: number, at: ScrollPosition): ScrollPosition => (at.following ? { ...at, offset: scrollMaxOffset(total, rows) } : at);

export const scrollRange = (total: number, rows: number, at: ScrollPosition): string => {
	const all = Math.max(0, Math.floor(total));
	const height = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : 1));
	if (all <= height) return "";
	const win = scrollWindow(all, height, at.offset);
	return ` · ${win.from + 1}-${win.to}/${all}${at.following ? " following" : ""}`;
};

export interface ScrollView extends ScrollPosition {
	total: number;
	rows: number;
}

export const scrollProgress = (view: ScrollView): string => {
	const total = Math.max(0, Math.floor(Number.isFinite(view.total) ? view.total : 0));
	const rows = Math.max(1, Math.floor(Number.isFinite(view.rows) ? view.rows : 1));
	const at = Math.max(0, Math.min(scrollMaxOffset(total, rows), Number.isFinite(view.offset) ? Math.floor(view.offset) : 0));
	const last = Math.min(total, at + rows);
	return view.following ? `▶ following the end • ${last}/${total} lines` : `⏸ ${total ? at + 1 : 0}-${last}/${total} — End resumes following`;
};

export interface ScrollPageParts<Head, Body> {
	requestRender: () => void;
	termRows: () => number;
	border: () => { render: (w: number) => string[] };
	head: () => Head | undefined;
	renderHead: (w: number, head: Head | undefined) => string[];
	body: (width: number) => Body[];
	bodyOf: (body: Body[], width: number) => string[];
	keyLine: (w: number, view: ScrollView) => string[];
	decorate?: (rows: string[], from: number, width: number) => string[];
	onClose?: (data: string) => boolean;
	take?: (data: string) => boolean;
	pageKey?: () => number;
	startFollowing?: boolean;
	minRows?: number;
	share?: number;
	prefix?: string;
	footerRows?: (w: number) => number;
	dispose?: () => void;
}

export interface ScrollPageSurface {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
	handleMouse: (event: { type?: string; wheelDelta?: number }) => { handled: boolean; render: boolean } | undefined;
	dispose: () => void;
	position: () => ScrollPosition;
}

export const createScrollPage = <Head, Body>(parts: ScrollPageParts<Head, Body>): ScrollPageSurface => {
	const positions = new Map<number, ScrollPosition>();
	const prefix = parts.prefix ?? "  ";
	let lastWidth = 80;
	let lastChrome = 3;
	const page = (): number => (parts.pageKey ? parts.pageKey() : 0);
	const at = (): ScrollPosition => positions.get(page()) ?? { offset: 0, following: parts.startFollowing === true };
	const footerRows = (w: number): number => Math.max(0, parts.footerRows?.(w) ?? SCROLL_FOOTER_ROWS);
	const rowsFor = (chrome: number, w: number): number => scrollHeight(parts.termRows(), chrome, parts.minRows ?? SCROLL_MIN_ROWS, parts.share ?? SCROLL_OVERLAY_SHARE, footerRows(w));
	const inner = (w: number): number => Math.max(20, Math.floor(w) - 4);
	const bodyLines = (w: number): string[] => parts.bodyOf(parts.body(inner(w)), inner(w));
	const remember = (next: ScrollPosition): ScrollPosition => {
		positions.set(page(), next);
		return next;
	};
	const measured = (): { rows: number; total: number } => ({ rows: rowsFor(lastChrome, lastWidth), total: bodyLines(lastWidth).length });
	const move = (action: ScrollMove): void => {
		const { rows, total } = measured();
		remember(scrollApply(total, rows, at(), action));
	};
	return {
		position: () => at(),
		render: (w: number) => {
			const headLines = parts.renderHead(w, parts.head());
			lastWidth = w;
			lastChrome = headLines.length + 2;
			const rows = rowsFor(lastChrome, w);
			const total = bodyLines(w);
			const position = scrollFollow(total.length, rows, at());
			const win = scrollWindow(total.length, rows, position.offset);
			const shown = remember({ ...position, offset: win.from });
			const body = total.slice(win.from, win.to);
			const painted = parts.decorate ? parts.decorate(body, win.from, w) : body.map((line) => `${prefix}${line}`);
			const out: string[] = [...parts.border().render(w), ...headLines, ...painted];
			for (let i = painted.length; i < rows; i++) out.push("");
			out.push(...parts.keyLine(w, { ...shown, total: total.length, rows }));
			out.push(...parts.border().render(w));
			return out;
		},
		invalidate: () => {
			positions.clear();
		},
		handleInput: (data: string) => {
			if (parts.onClose?.(data)) return;
			if (parts.take?.(data)) {
				parts.requestRender();
				return;
			}
			const action = scrollMoveOf(scrollKeyAction(data));
			if (!action) return;
			move(action);
			parts.requestRender();
		},
		handleMouse: (event) => {
			if (event?.type !== "wheel" || !event.wheelDelta) return undefined;
			move(event.wheelDelta < 0 ? "up" : "down");
			parts.requestRender();
			return { handled: true, render: true };
		},
		dispose: () => parts.dispose?.(),
	};
};
