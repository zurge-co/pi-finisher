import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEscGuard } from "../extensions/zense-harness/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("esc-guard: no dialog open → undefined for every key (never consumes/touches anything)", () => {
	const g = createEscGuard();
	assert.equal(g.handleInput("\x1b"), undefined); 	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined); 	assert.equal(g.depth(), 0);
});

test("esc-guard: dialog open → ESC consumed + that dialog closed via close(), other keys pass", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => {
		closed++;
		h.close(); 	});
	assert.equal(g.depth(), 1);
		assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined);
	assert.equal(closed, 0);
		assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.equal(closed, 1);
	assert.equal(g.depth(), 0);
		assert.equal(g.handleInput("\x1b"), undefined);
});

test("esc-guard: nested stack — ESC closes only the topmost dialog, then the next in line", () => {
	const g = createEscGuard();
	const order = [];
	const h1 = g.open(() => { order.push("d1"); h1.close(); });
	const h2 = g.open(() => { order.push("d2"); h2.close(); });
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2"]); 	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2", "d1"]);
	assert.equal(g.handleInput("\x1b"), undefined); });

test("esc-guard: manual handle.close() unregisters the dialog (closed via another key) → ESC not consumed", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	h.close(); 	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
	assert.equal(closed, 0);
});

test("esc-guard: kitty-protocol escape (\x1b[27u) counts as ESC, same as a raw \x1b", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	assert.deepEqual(g.handleInput("\x1b[27u"), { consume: true });
	assert.equal(closed, 1);
});

test("esc-guard: reset() clears the whole stack (new session — old overlays were popped by pi)", () => {
	const g = createEscGuard();
	g.open(() => {});
	g.open(() => {});
	assert.equal(g.depth(), 2);
	g.reset();
	assert.equal(g.depth(), 0);
	assert.equal(g.handleInput("\x1b"), undefined);
});

test("peek: space hides the top dialog and reports it, space brings it back", () => {
	const g = createEscGuard();
	const hidden = [];
	const h = g.open(() => {}, (v) => hidden.push(v));
	assert.deepEqual(g.toggle(), true);
	assert.deepEqual(hidden, [true]);
	assert.equal(g.isPeeking(), true);
	assert.deepEqual(g.toggle(), false);
	assert.deepEqual(hidden, [true, false]);
	assert.equal(g.isPeeking(), false);
	h.close();
});

test("peek: while hidden every key is consumed; space and Esc both un-peek without closing", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); }, () => {});
	g.toggle();
		assert.deepEqual(g.handleInput("x"), { consume: true });
	assert.deepEqual(g.handleInput("\x1b[A"), { consume: true });
	assert.equal(closed, 0);
	assert.deepEqual(g.handleInput(" "), { consume: true }); 	assert.equal(g.isPeeking(), false);
	assert.equal(closed, 0, "restoring must not cancel the dialog");
	assert.equal(g.handleInput("a"), undefined, "shown again → keys pass to the dialog");
});

test("peek: Esc while hidden restores the dialog instead of cancelling it (question is never lost)", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); }, () => {});
	g.toggle();
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.equal(g.isPeeking(), false);
	assert.equal(closed, 0);
	h.close();
});

test("peek: a dialog that opts out (canPeek=false, e.g. the checkbox list) never hides on space", () => {
	const g = createEscGuard();
	const hidden = [];
	const h = g.open(() => {}, (v) => hidden.push(v), () => false);
	assert.equal(g.toggle(), undefined);
	assert.deepEqual(hidden, []);
	assert.equal(g.handleInput(" "), undefined, "space still routes to the dialog's own handler");
	h.close();
});

test("peek: closing the peeked dialog underneath (abort signal) ends the peek cleanly", () => {
	const g = createEscGuard();
	const h1 = g.open(() => {}, () => {});
	g.toggle();
	assert.equal(g.isPeeking(), true);
	h1.close(); 	assert.equal(g.isPeeking(), false, "peek must not outlive its dialog");
	assert.equal(g.handleInput("a"), undefined); });

test("peek: reset() clears a stale peek (new session / mode switch)", () => {
	const g = createEscGuard();
	g.open(() => {}, () => {});
	g.toggle();
	assert.equal(g.isPeeking(), true);
	g.reset();
	assert.equal(g.isPeeking(), false);
	assert.equal(g.toggle(), undefined);
});

test("peek: no dialog open → toggle is a no-op and keys keep passing", () => {
	const g = createEscGuard();
	assert.equal(g.toggle(), undefined);
	assert.equal(g.isPeeking(), false);
	assert.equal(g.handleInput(" "), undefined);
});

test("source: zenseCustom mirrors pi's overlay handle so peek can hide/show it", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/src/gui.ts"), "utf8");
	assert.match(src, /onHandle:/, "zenseCustom must pass onHandle to capture the overlay handle");
	assert.match(src, /setHidden/, "the captured handle must drive OverlayHandle.setHidden");
	assert.match(src, /canPeek/, "dialogs must be able to opt out of the peek key");
});


test("source: the shared picker unlocks peek only while its filter is empty", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/src/gui.ts"), "utf8");
	const i = src.indexOf("const zensePick");
	assert.ok(i > 0);
	const body = src.slice(i, i + 3000);
	assert.match(body, /filter === ""/, "space must stay a filter key once the human starts typing");
});

