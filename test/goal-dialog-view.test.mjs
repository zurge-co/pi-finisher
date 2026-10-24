import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	GOAL_DIALOG_OVERLAY,
	askGoalConfirmation,
	createEscGuard,
	goalConfirmLines,
	goalDialogAction,
	goalDialogCap,
	goalDialogFit,
	goalDialogIndicator,
	goalDialogMaxTop,
	goalDialogRows,
	goalDialogScroll,
	goalDialogWindow,
	goalDialogWrap,
} from "../extensions/finisher/index.ts";
import { createGui } from "../extensions/finisher/src/gui.ts";

const here = new URL("..", import.meta.url).pathname;
const lines = (n) => goalConfirmLines("ship refresh tokens with rotation", Array.from({ length: n }, (_, i) => `case number ${i + 1} holds for every input the suite feeds it`));

const theme = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	style: (text) => text,
	colors: {},
	appearance: "dark",
};

const driveDialog = async (width, termRows, cases) => {
	let component;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory, options) => {
				const handle = { hidden: false, setHidden: (h) => { handle.hidden = h; }, hide: () => {}, isHidden: () => handle.hidden, focus: () => {}, unfocus: () => {}, isFocused: () => true, getBounds: () => undefined };
				options?.onHandle?.(handle);
				component = factory({ terminal: { rows: termRows }, requestRender: () => {} }, theme, () => "", () => {});
				return new Promise(() => {});
			},
		},
	};
	const gui = createGui({ escGuard: createEscGuard() });
	askGoalConfirmation({ ctx, custom: gui.finisherCustom }, "ship it", Array.from({ length: cases }, (_, i) => `case number ${i + 1} holds for every input the suite feeds it`));
	return { render: () => component.render(width), component };
};

test("the dialog is a real modal overlay — an overlay is the only thing space can hide and the wheel can scroll", () => {
	assert.equal(GOAL_DIALOG_OVERLAY.overlay, true, "without overlay:true pi pushes a non-overlay dialog and never hands back a handle, so space can never hide it");
	assert.ok(GOAL_DIALOG_OVERLAY.overlayOptions?.maxHeight, "a bounded height is what keeps a long case list on screen");
	assert.ok(GOAL_DIALOG_OVERLAY.overlayOptions?.minWidth && GOAL_DIALOG_OVERLAY.overlayOptions?.width);
	const src = readFileSync(join(here, "extensions/finisher/src/goal-dialog.ts"), "utf8");
	assert.match(src, /handleMouse/, "the wheel must scroll this dialog, not the chat behind it");
	assert.match(src, /GOAL_DIALOG_OVERLAY/, "the dialog must pass the overlay options to ctx.ui.custom");
});

test("what the dialog actually draws never exceeds the terminal's 85% cap — measured on the real render, at every reachable width and height", async () => {
	for (const width of [24, 30, 40, 54, 61, 62, 67, 80, 120, 200]) {
		for (const cases of [1, 5, 24]) {
			const floor = (await driveDialog(width, 1, cases)).render().length;
			for (const termRows of [6, 8, 10, 12, 20, 24, 40, 80]) {
				const out = (await driveDialog(width, termRows, cases)).render();
				const cap = goalDialogCap(termRows);
				assert.ok(out.length <= Math.max(cap, floor), `width ${width} height ${termRows} cases ${cases}: drew ${out.length} lines into a ${cap}-line cap (its smallest possible frame is ${floor})`);
				if (floor <= cap) assert.ok(out.length <= cap, `width ${width} height ${termRows} cases ${cases}: a frame that fits (floor ${floor} <= cap ${cap}) drew ${out.length}`);
				for (const line of out) assert.ok(visibleWidth(line) <= width, `a ${visibleWidth(line)}-wide line in a ${width}-column dialog`);
			}
		}
	}
});

test("a dialog that fits is never clipped, at the geometry a previous attempt got wrong — width 61 and 62 in a 24-row terminal", async () => {
	for (const width of [61, 62, 67]) {
		for (const termRows of [24, 40]) {
			const out = (await driveDialog(width, termRows, 24)).render();
			const cap = goalDialogCap(termRows);
			assert.ok(out.length <= cap, `width ${width} height ${termRows}: drew ${out.length} of a ${cap}-line cap`);
			const last = out[out.length - 1];
			assert.ok(last.startsWith("─") || last.startsWith("━"), `the bottom border must survive, got ${JSON.stringify(last)}`);
		}
	}
});

test("scrolling never changes the height of the frame — a scroll must not be able to push the dialog past the cap", async () => {
	for (const width of [38, 39, 40, 61, 80]) {
		for (const termRows of [11, 24, 40]) {
			const floor = (await driveDialog(width, 1, 24)).render().length;
			const { render, component } = await driveDialog(width, termRows, 24);
			const cap = goalDialogCap(termRows);
			const heights = new Set([render().length]);
			for (let i = 0; i < 60; i++) {
				component.handleInput("\x1b[6~");
				heights.add(render().length);
			}
			for (let i = 0; i < 60; i++) {
				component.handleInput("\x1b[5~");
				heights.add(render().length);
			}
			for (let i = 0; i < 60; i++) {
				component.handleInput("\x1b");
				heights.add(render().length);
			}
			assert.equal(heights.size, 1, `width ${width} height ${termRows} drew frames of ${[...heights].join(", ")} lines while scrolling`);
			const [height] = [...heights];
			assert.ok(height <= Math.max(cap, floor), `width ${width} height ${termRows} drew ${height} into a ${cap}-line cap (smallest frame ${floor})`);
			if (floor <= cap) assert.ok(height <= cap, `width ${width} height ${termRows}: a frame that fits (smallest ${floor} <= ${cap}) drew ${height}`);
		}
	}
});

test("the dialog is scrollable to its last case on a real frame, and the last case is drawn", async () => {
	const { render, component } = await driveDialog(80, 24, 24);
	render();
	for (let i = 0; i < 200; i++) component.handleInput("\x1b[6~");
	const out = render();
	assert.ok(out.length <= goalDialogCap(24), `scrolled frame drew ${out.length} lines`);
	assert.ok(out.some((l) => l.includes("case number 24")), "the last case is reachable and drawn");
});

test("the settle loop never shrinks below one content row, and stops as soon as what it draws fits", () => {
	for (const rowCount of [0, 1, 9, 200]) {
		for (const cap of [0, 1, 6, 20, 34, 200]) {
			for (const chrome of [0, 6, 8, 12, 40]) {
				const fit = goalDialogFit(rowCount, 0, cap, (viewport) => chrome + Math.min(viewport, rowCount));
				assert.ok(fit.viewport >= 1, `rowCount ${rowCount} cap ${cap} chrome ${chrome} produced viewport ${fit.viewport}`);
				const drawn = chrome + Math.min(fit.viewport, rowCount);
				if (chrome + 1 <= cap) assert.ok(drawn <= cap, `rowCount ${rowCount} cap ${cap} chrome ${chrome} drew ${drawn}`);
				assert.equal(fit.hiddenAbove + Math.min(fit.viewport, rowCount) + fit.hiddenBelow, fit.total, "the parts always add up");
			}
		}
	}
});

test("the window is a partition of the rows: nothing is dropped, nothing is drawn twice, and it never exceeds the viewport", () => {
	for (const cases of [1, 3, 24]) {
		for (const width of [20, 60, 200]) {
			const rows = goalDialogRows(lines(cases), width);
			for (const top of [0, 1, 7, rows.length, rows.length + 50]) {
				for (const viewport of [1, 4, 12, rows.length + 20]) {
					const win = goalDialogWindow(rows, top, viewport);
					assert.ok(win.rows.length <= Math.max(1, viewport), `rows ${win.rows.length} must fit viewport ${viewport}`);
					assert.equal(win.hiddenAbove + win.rows.length + win.hiddenBelow, win.total, "the three parts must add up to the whole");
					assert.ok(win.top >= 0 && win.top <= goalDialogMaxTop(rows.length, Math.max(1, viewport)), `top ${win.top} out of range`);
					assert.deepEqual(win.rows[0], rows[win.top], "the window starts where it says it starts");
				}
			}
		}
	}
});

test("every case is reachable: scrolling to the bottom shows the last row, to the top shows the first, whatever the viewport", () => {
	for (const cases of [1, 5, 24]) {
		const rows = goalDialogRows(lines(cases), 60);
		for (const viewport of [1, 10, 40]) {
			const top = goalDialogScroll(0, viewport, rows.length, "top");
			assert.equal(goalDialogWindow(rows, top, viewport).rows[0], rows[0], "top shows the goal line");
			const bottom = goalDialogScroll(0, viewport, rows.length, "bottom");
			const win = goalDialogWindow(rows, bottom, viewport);
			assert.deepEqual(win.rows[win.rows.length - 1], rows[rows.length - 1], "bottom shows the last case, never a clipped one");
			assert.equal(win.hiddenBelow, 0, "at the bottom there is nothing left below");
		}
	}
});

test("scrolling is total and idempotent at the ends: every action lands in range, and further scrolling changes nothing", () => {
	const actions = ["up", "down", "pageUp", "pageDown", "top", "bottom", "none"];
	const rows = 200;
	for (const viewport of [1, 4, 12, 100]) {
		let top = 0;
		for (const action of actions) top = goalDialogScroll(top, viewport, rows, action);
		assert.ok(top >= 0 && top <= goalDialogMaxTop(rows, viewport), `top ${top} must stay in range`);
		assert.equal(goalDialogScroll(0, viewport, rows, "up"), 0, "scrolling up at the top is a no-op, not a negative offset");
		const atBottom = goalDialogScroll(0, viewport, rows, "bottom");
		assert.equal(goalDialogScroll(atBottom, viewport, rows, "down"), atBottom, "scrolling down at the bottom is a no-op");
		for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, -5]) assert.equal(goalDialogScroll(junk, viewport, rows, "none") >= 0, true, `${junk} must not escape the range`);
	}
});

test("the indicator appears exactly when rows are hidden, and states the true position", () => {
	const rows = goalDialogRows(lines(24), 40);
	const full = goalDialogWindow(rows, 0, rows.length + 5);
	assert.equal(goalDialogIndicator(full), undefined, "nothing is hidden, so nothing claims to be hidden");
	const scrolled = goalDialogWindow(rows, 3, 8);
	const label = goalDialogIndicator(scrolled);
	assert.ok(label, "a scrolled window must say so");
	assert.match(label, new RegExp(`lines ${scrolled.top + 1}-${scrolled.top + scrolled.rows.length} of ${rows.length}`));
	assert.match(label, new RegExp(`${scrolled.hiddenAbove} above`));
});

test("wrapping keeps every character in order, respects the width, and only breaks a word when the width forces it", () => {
	const goal = "ship refresh tokens with rotation and revocation and a migration path for old sessions";
	const longest = Math.max(...goal.split(" ").map((w) => w.length));
	for (const width of [8, 20, 60]) {
		const pieces = goalDialogWrap(goal, width);
		assert.equal(pieces.join(" ").replace(/\s+/g, ""), goal.replace(/ /g, ""), "no character is lost or reordered");
		for (const p of pieces) assert.ok(visibleWidth(p) <= width, `"${p}" is wider than ${width}`);
		if (width >= longest) assert.equal(pieces.join(" "), goal, `at width ${width}, wider than every word, wrapping is purely at word boundaries`);
	}
	const long = "x".repeat(50);
	const split = goalDialogWrap(long, 10);
	assert.equal(split.join(""), long, "an unbreakable word is split, never dropped");
	for (const p of split) assert.ok(p.length <= 10);
	assert.deepEqual(goalDialogWrap("", 10), [""]);
});

test("the keys are unambiguous: confirm and decline are distinct from every scroll key, and space is left for peeking", () => {
	const keys = ["y", "Y", "n", "N", "g", "G", "\r", "\x1b", "\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "q", " ", ""];
	for (const data of keys) {
		const action = goalDialogAction(data);
		assert.equal(typeof action, "string");
		if (action === "confirm") assert.ok(data === "y" || data === "Y" || data === "\r", `only y/enter confirm, got ${JSON.stringify(data)}`);
		if (action === "decline") assert.ok(data === "n" || data === "N" || data === "\x1b", `only n/esc decline, got ${JSON.stringify(data)}`);
	}
	assert.equal(goalDialogAction(" "), "none", "space must fall through to the peek handler, never close or scroll");
	for (const scroll of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"]) assert.ok(!["confirm", "decline"].includes(goalDialogAction(scroll)), `${JSON.stringify(scroll)} must only scroll`);
});
