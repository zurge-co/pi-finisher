import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	GOAL_PAGE_CLOSE,
	GOAL_PAGE_KEYS,
	REPORT_PAGE_CLOSE,
	REPORT_PAGE_KEYS,
	SCROLL_KEYS,
	createScrollPage,
	scrollApply,
	scrollCeiling,
	scrollCloses,
	scrollHeight,
	scrollKeyAction,
	scrollKeysLine,
	scrollMaxOffset,
	scrollMoveOf,
	scrollRowKeys,
	scrollStep,
	scrollWindow,
	sessionKeyLine,
} from "../extensions/finisher/index.ts";

const SRC = new URL("../extensions/finisher/src/", import.meta.url).pathname;
const sourceOf = (name) => readFileSync(join(SRC, name), "utf8");

const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x1b[H",
	end: "\x1b[F",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
};

const strip = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

const surface = ({ total, rows, follows = false }) => {
	const lines = Array.from({ length: total }, (_, i) => `line ${i}`);
	const page = createScrollPage({
		requestRender: () => {},
		termRows: () => Math.max(4, rows + 4),
		border: () => ({ render: (w) => ["-".repeat(w)] }),
		head: () => "head",
		renderHead: (w) => [`head ${w}`],
		body: () => lines,
		bodyOf: (body) => body,
		keyLine: () => ["keys"],
		startFollowing: follows,
	});
	return page;
};

test("the keys a page advertises are exactly the keys the shared keymap handles", () => {
	const moved = Object.fromEntries(Object.entries(KEYS).map(([name, data]) => [name, scrollMoveOf(scrollKeyAction(data))]));
	assert.deepEqual(moved, { up: "up", down: "down", home: "top", end: "bottom", pageUp: "pageUp", pageDown: "pageDown" }, "every advertised key has a real move");
	assert.equal(scrollMoveOf(scrollKeyAction("g")), "top");
	assert.equal(scrollMoveOf(scrollKeyAction("G")), "bottom");
	assert.equal(scrollMoveOf(scrollKeyAction("not a key")), null, "a key the map does not handle moves nothing");
	for (const line of [GOAL_PAGE_KEYS, REPORT_PAGE_KEYS, sessionKeyLine(3), sessionKeyLine(1)]) {
		for (const token of ["↑↓", "PgUp/PgDn"]) assert.ok(line.includes(token), `every page advertises ${token}: ${line}`);
	}
	for (const jump of ["Home", "End", "g", "G"]) {
		assert.ok(GOAL_PAGE_KEYS.includes(jump), `the plan page advertises ${jump}, which it handles: ${GOAL_PAGE_KEYS}`);
		assert.ok(sessionKeyLine(1).includes(jump), `the agent page advertises ${jump}, which it handles: ${sessionKeyLine(1)}`);
	}
	assert.equal(REPORT_PAGE_KEYS.startsWith(scrollKeysLine({ close: REPORT_PAGE_CLOSE })), true, "the report key line comes from the shared keymap");
	assert.equal(scrollKeysLine({ close: [] }).startsWith(SCROLL_KEYS), true, "a page with no close key still leads with the scroll keys");
	const closeData = { Esc: "\x1b", q: "q" };
	const pages = [
		[GOAL_PAGE_KEYS, GOAL_PAGE_CLOSE],
		[REPORT_PAGE_KEYS, REPORT_PAGE_CLOSE],
		[sessionKeyLine(1), ["Esc"]],
		[sessionKeyLine(3, 2), ["Esc"]],
	];
	for (const [line, handles] of pages) {
		for (const key of ["Esc", "q"]) {
			assert.equal(line.includes(`${key}/`) || line.includes(`${key} close`), scrollCloses(closeData[key], handles), `${JSON.stringify(key)} is advertised exactly when the page handles it: ${line}`);
		}
		for (const key of [...Object.values(KEYS), "g", "G"]) assert.equal(scrollCloses(key, handles), false, `${JSON.stringify(key)} scrolls, it never closes: ${line}`);
	}
	assert.equal(scrollCloses("q", REPORT_PAGE_CLOSE), false, "the report page never advertises q, so q must not close it");
	assert.equal(scrollCloses("q", GOAL_PAGE_CLOSE), true, "the plan page advertises q, and q closes it");
	const keyData = { Home: KEYS.home, End: KEYS.end, g: "g", G: "G" };
	for (const jumps of [[], ["top"], ["bottom"], ["top", "bottom"]]) {
		const keys = scrollRowKeys(jumps);
		assert.equal(keys.length, jumps.length * 2, `every jump contributes its two keys: ${jumps}`);
		for (const key of keys) assert.notEqual(scrollMoveOf(scrollKeyAction(keyData[key])), null, `an advertised jump key does move the page: ${key}`);
	}
});

test("scrolling is total and bounded: every key from every offset lands inside the page, and the bottom reaches the last row", () => {
	for (const total of [0, 1, 3, 4, 5, 17, 400]) {
		for (const rows of [1, 2, 4, 9, 40]) {
			const max = scrollMaxOffset(total, rows);
			assert.ok(max >= 0, `total ${total} rows ${rows}: a negative offset is impossible`);
			assert.ok(max + Math.max(1, rows) >= total, `total ${total} rows ${rows}: the last page still fills the page`);
			for (const action of ["up", "down", "pageUp", "pageDown", "top", "bottom"]) {
				for (const offset of [0, 1, max, max + 5, -5]) {
					const next = scrollStep(total, rows, offset, action);
					assert.ok(next >= 0 && next <= max, `total ${total} rows ${rows} ${action} from ${offset}: ${next} stays inside 0..${max}`);
				}
			}
			for (const start of [0, max]) {
				const win = scrollWindow(total, rows, start);
				assert.ok(win.from >= 0 && win.to <= total && win.from <= win.to, `total ${total} rows ${rows}: the window ${win.from}..${win.to} sits inside the page`);
				assert.equal(win.to, Math.min(total, start + Math.max(1, rows)), "a window is exactly one page tall");
			}
			if (total) assert.equal(scrollWindow(total, rows, scrollMaxOffset(total, rows)).to, total, `total ${total} rows ${rows}: the bottom window reaches the last row`);
			assert.equal(scrollStep(total, rows, 0, "bottom"), max, `total ${total} rows ${rows}: End is the bottom, never past it`);
		}
	}
});

test("following is a state of the offset, not a second scroll path", () => {
	for (const total of [5, 40, 400]) {
		for (const rows of [4, 9]) {
			const max = scrollMaxOffset(total, rows);
			const bottom = scrollApply(total, rows, { offset: 0, following: false }, "bottom");
			assert.deepEqual(bottom, { offset: max, following: true }, `total ${total} rows ${rows}: End lands on the bottom and follows it`);
			assert.deepEqual(scrollApply(total, rows, bottom, "down"), bottom, `total ${total} rows ${rows}: scrolling down at the bottom changes nothing`);
			assert.deepEqual(scrollApply(total, rows, { offset: 0, following: true }, "top"), { offset: 0, following: false }, `total ${total} rows ${rows}: Home leaves the bottom behind`);
			if (max > 0) assert.equal(scrollApply(total, rows, bottom, "up").following, false, `total ${total} rows ${rows}: one step up stops following`);
			if (!max) {
				const still = scrollApply(total, rows, { offset: 0, following: false }, "down");
				assert.deepEqual(still, { offset: 0, following: false }, `total ${total} rows ${rows}: a page that fits never moves`);
				continue;
			}
			for (const action of ["up", "down", "pageUp", "pageDown"]) {
				const next = scrollApply(total, rows, { offset: Math.floor(max / 2), following: false }, action);
				assert.equal(next.following, next.offset >= max, `total ${total} rows ${rows} ${action}: following is exactly "the offset sits at the bottom"`);
			}
		}
	}
});

test("the page height is the overlay share minus its own chrome, so the drawn page never exceeds the ceiling", () => {
	for (const termRows of [1, 4, 6, 10, 24, 60, 200]) {
		const ceiling = scrollCeiling(termRows);
		const screen = Number.isFinite(termRows) && termRows > 0 ? termRows : 24;
		assert.ok(ceiling <= Math.max(4, Math.floor(screen * 0.9)), `term ${termRows}: the overlay stays inside its share`);
		assert.ok(ceiling >= 1, `term ${termRows}: a page always has height`);
		for (const chrome of [0, 1, 3, 5, 20]) {
			const body = scrollHeight(termRows, chrome);
			assert.ok(body >= 1, `term ${termRows} chrome ${chrome}: a page always shows one body row`);
			assert.equal(body + chrome + 1, Math.max(ceiling, chrome + 2), `term ${termRows} chrome ${chrome}: head + body + key line is the ceiling, never past it`);
		}
	}
});

test("one scroll surface serves every page: the same component pages a wrapped body to its last row at any size", () => {
	for (const [total, rows] of [[24, 6], [200, 12], [5, 20]]) {
		const page = surface({ total, rows });
		const drawn = new Set();
		const sweep = (out) => {
			for (const hit of out.join("\n").matchAll(/line (\d+)/g)) drawn.add(Number(hit[1]));
			return out;
		};
		sweep(page.render(80).map(strip));
		for (let i = 0; i < total + 2; i++) {
			page.handleInput(KEYS.pageDown);
			sweep(page.render(80).map(strip));
		}
		assert.equal(drawn.size, total, `${total} rows in a ${rows}-row page: paging down draws every row`);
		page.handleInput(KEYS.home);
		assert.ok(page.render(80).some((l) => strip(l).includes("line 0")), `${total} rows: Home returns to the first row`);
		assert.equal(page.position().offset, 0);
		page.handleInput(KEYS.end);
		assert.ok(page.render(80).some((l) => strip(l).includes(`line ${total - 1}`)), `${total} rows: End reaches the last row`);
		assert.equal(page.position().following, true);
		page.handleInput("g");
		assert.equal(page.position().offset, 0, "g returns to the top without any page-specific code");
	}
});

test("one module owns the offset math: every page in viewers.ts is built on the shared surface, and no page recomputes it", () => {
	const viewers = sourceOf("viewers.ts");
	const pages = viewers.match(/createScrollPage</g) ?? [];
	assert.equal(pages.length, 3, `the plan page, the report page and the agent page all come from the shared surface, found ${pages.length}`);
	for (const page of ["goal-page.ts", "report-page.ts", "viewers.ts"]) {
		const source = sourceOf(page);
		for (const copy of [/Math\.max\(0, total -/, /total - rows\(\)/, /total - Math\.max\(1, rows\)/]) assert.doesNotMatch(source, copy, `${page} must not carry its own copy of ${copy}`);
	}
	for (const page of ["goalPageWindow", "goalPageMaxOffset", "goalPageStep", "reportPageWindow", "reportPageMaxOffset"]) {
		const owners = ["goal-page.ts", "report-page.ts"].filter((file) => sourceOf(file).includes(`export const ${page} `));
		assert.equal(owners.length, 1, `${page} is defined once`);
		const body = sourceOf(owners[0]).slice(sourceOf(owners[0]).indexOf(`export const ${page} `)).split("\n\n")[0];
		assert.match(body, /scroll(Step|Window|MaxOffset)|goalPage(Window|MaxOffset|Step)\(/, `${page} delegates to the shared math instead of repeating it: ${body}`);
	}
});

test("the surface closes only on the keys a page opts into, never on a scroll key", () => {
	let closed = 0;
	const page = createScrollPage({
		requestRender: () => {},
		termRows: () => 24,
		border: () => ({ render: () => ["-"] }),
		head: () => undefined,
		renderHead: () => [],
		body: () => ["a", "b"],
		bodyOf: (body) => body,
		keyLine: () => ["keys"],
		onClose: (data) => {
			const closes = data === "\x1b" || data === "\r" || data === "q";
			if (closes) closed += 1;
			return closes;
		},
	});
	for (const key of [...Object.values(KEYS), "g", "G"]) {
		page.handleInput(key);
		assert.equal(closed, 0, `${JSON.stringify(key)} scrolls instead of closing`);
	}
	for (const key of ["\x1b", "\r", "q"]) {
		page.handleInput(key);
		assert.ok(closed > 0, `${JSON.stringify(key)} closes the page`);
	}
});
