import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEscGuard } from "../extensions/zense-harness/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

// B (ESC): the global input guard for zense dialogs — keeps ESC from leaking into pi's
// defaultEditor.onEscape (streaming abort) instead of closing a dialog. Tests cover the
// guard's pure logic (real TUI routing = specDebt)

test("esc-guard: no dialog open → undefined for every key (never consumes/touches anything)", () => {
	const g = createEscGuard();
	assert.equal(g.handleInput("\x1b"), undefined); // even ESC passes — no dialog
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined); // arrow up
	assert.equal(g.depth(), 0);
});

test("esc-guard: dialog open → ESC consumed + that dialog closed via close(), other keys pass", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => {
		closed++;
		h.close(); // real behavior: the dialog unregisters itself from the stack on close
	});
	assert.equal(g.depth(), 1);
	// other keys must pass normally (the focused component handles them)
	assert.equal(g.handleInput("a"), undefined);
	assert.equal(g.handleInput("\x1b[A"), undefined);
	assert.equal(closed, 0);
	// ESC → consumed + closed
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.equal(closed, 1);
	assert.equal(g.depth(), 0);
	// stack empty → later keys pass (incl. the editor's own ESC — e.g. an intentional user abort)
	assert.equal(g.handleInput("\x1b"), undefined);
});

test("esc-guard: nested stack — ESC closes only the topmost dialog, then the next in line", () => {
	const g = createEscGuard();
	const order = [];
	const h1 = g.open(() => { order.push("d1"); h1.close(); });
	const h2 = g.open(() => { order.push("d2"); h2.close(); });
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2"]); // the topmost (opened last) closes first
	assert.deepEqual(g.handleInput("\x1b"), { consume: true });
	assert.deepEqual(order, ["d2", "d1"]);
	assert.equal(g.handleInput("\x1b"), undefined); // empty again → passes
});

test("esc-guard: manual handle.close() unregisters the dialog (closed via another key) → ESC not consumed", () => {
	const g = createEscGuard();
	let closed = 0;
	const h = g.open(() => { closed++; h.close(); });
	h.close(); // the dialog closed itself via another path (y/n/enter) — its entry must leave the stack
	assert.equal(g.depth(), 0);
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

// ---- peek (2026-10-14): space hides the top overlay so the transcript can be read without
// losing the question; space/Esc bring it back and no other key leaks while hidden

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
	// any key (typing/scroll/abort) is swallowed — nothing reaches the editor
	assert.deepEqual(g.handleInput("x"), { consume: true });
	assert.deepEqual(g.handleInput("\x1b[A"), { consume: true });
	assert.equal(closed, 0);
	assert.deepEqual(g.handleInput(" "), { consume: true }); // space restores
	assert.equal(g.isPeeking(), false);
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
	h1.close(); // dialog vanished while hidden
	assert.equal(g.isPeeking(), false, "peek must not outlive its dialog");
	assert.equal(g.handleInput("a"), undefined); // stack empty → normal passthrough
});

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

// ---- index.ts source regression guards (overlay wiring can't run under node:test)

test("source: zenseCustom mirrors pi's overlay handle so peek can hide/show it", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	assert.match(src, /onHandle:/, "zenseCustom must pass onHandle to capture the overlay handle");
	assert.match(src, /setHidden/, "the captured handle must drive OverlayHandle.setHidden");
	assert.match(src, /canPeek/, "dialogs must be able to opt out of the peek key");
});

test("source: the checkbox ext-config dialog declines peek (space is its toggle)", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	const i = src.indexOf("const extConfigDialog");
	assert.ok(i > 0);
	const body = src.slice(i, i + 4000);
	assert.match(body, /\(\) => false/, "canPeek must be false where space already means toggle");
});

test("source: the shared picker unlocks peek only while its filter is empty", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	const i = src.indexOf("const zensePick");
	assert.ok(i > 0);
	const body = src.slice(i, i + 3000);
	assert.match(body, /filter === ""/, "space must stay a filter key once the human starts typing");
});


// ---- index.ts source regression guards: cross-check sign surfaces + review-decision modal
//      (2026-10-18) — the TUI wiring itself can't run under node:test, so the contracts are
//      pinned as source greps: the sign dialog shows ONLY the cross-check cases, n asks for a
//      reason, and non-UI sessions keep the chat-text fallback.

test("source: specSignDialog renders only the cross-check — no technical spec, no Changes; n asks why", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	const i = src.indexOf("const specSignDialog");
	assert.ok(i > 0, "specSignDialog must exist");
	const body = src.slice(i, src.indexOf("const trackerSignDialog"));
	assert.match(body, /renderSignOutcome/, "the dialog body must come from renderSignOutcome (cross-check cases only)");
	assert.match(body, /Confirm ONCE — the agent then works until every case holds \(no further gate\)/);
	assert.match(body, /goalCases\(spec\)/, "the dialog must list the goal cases from the spec (cross-check outcomes, legacy outcomes, else intent)");
	assert.match(body, /askRejectReason/, "n must open the optional reason box");
	assert.match(body, /done\(REJECT_WITH_REASON\)/, "n returns the reject sentinel");
	assert.match(body, /matchesKey\(data, Key\.escape\).*done\(null\)/, "Esc must stay a quick no-reason close");
	assert.ok(!body.includes("renderSpecMd"), "the full technical spec must not render in the sign dialog");
	assert.ok(!body.includes("renderSpecChangesTui"), "the Changes section must not render in the sign dialog");
});

test("source: tracker sign is a cross-check dialog (y=AUTO, m=MANUAL, n=not yet + reason); plan flow uses the decision", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	const i = src.indexOf("const trackerSignDialog");
	assert.ok(i > 0);
	const body = src.slice(i, src.indexOf("const reviewModalDialog"));
	assert.match(body, /renderTrackerOutcomes/, "the tracker sign body must come from renderTrackerOutcomes");
	assert.match(body, /done\("auto"\)/);
	assert.match(body, /done\("manual"\)/);
	assert.match(body, /done\(REJECT_WITH_REASON\)/);
	assert.match(body, /askRejectReason/);
	assert.match(body, /matchesKey\(data, Key\.escape\).*done\(null\)/);
	assert.ok(src.includes("const res = await trackerSignDialog(ctx, t)"), "the plan flow must sign via the dialog");
	assert.ok(src.includes("decideTrackerSign({"), "the plan flow must decide gate-off/goals-unchanged before asking");
});

test("source: zense_review ends in a decision modal — y=accept, n=reason, Esc=close-only, gate OFF skips it", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	const i = src.indexOf("const reviewModalDialog");
	assert.ok(i > 0);
	const body = src.slice(i, src.indexOf("const extConfigDialog"));
	assert.match(body, /buildReviewModalText/, "the modal body must come from the pure builder");
	assert.match(body, /if \(data === "y" && canAccept\) done\(true\)/, "y only counts as consent when something is staged");
	assert.match(body, /done\(REJECT_WITH_REASON\)/, "n opens the reason box");
	assert.match(body, /done\(null\)/, "Esc closes without discarding");
	assert.match(body, /askRejectReason/);
	const rev = src.slice(src.indexOf('name: "zense_review"'));
	assert.match(rev, /reviewModalDialog\(ctx, packet/, "the review tool must open the modal after the packet");
	assert.match(rev, /ctx\.hasUI && ctx\.mode === "tui" && state\.gateEnabled/, "the modal must be TUI-only AND gate-gated");
	assert.match(rev, /acceptPending\(ctx, true\)/, "y routes to the accept side's commit-on-behalf path");
	assert.match(rev, /rejectionDirective\("review"/, "a typed rejection reaches the agent");
	assert.ok(!rev.slice(0, rev.indexOf("zense_discard")).includes("discardPendingApply"), "review must never discard on its own");
});

test("source: gate OFF disables every human prompt (spec/tracker auto-sign, clarify/planner/zense_ask/pre-spec dirty/review)", () => {
	const src = readFileSync(join(here, "..", "extensions/zense-harness/index.ts"), "utf8");
	assert.match(src, /decideSpecApproval\(\{/, "commitSpec uses the one approval decision");
	assert.match(src, /decideTrackerSign\(\{/, "longrun plan uses the tracker-sign decision");
	assert.match(src, /sameGoalLines\(prevSpec, state\.spec\)/, "goal-stable re-specs are detected");
	assert.match(src, /sameGoalLines\(t0, t\)/, "goal-stable tracker re-plans are detected");
	assert.match(src, /clarifyClosed && clarifyRounds < 4 && ctx\.hasUI && state\.gateEnabled/, "clarify questions honor gate OFF");
	assert.match(src, /parsed\.questions\?\.length\) \{\s*if \(!state\.gateEnabled\)/, "planner questions are decided autonomously under gate OFF");
	assert.match(src, /preDirty\.length && !state\.gateEnabled/, "gate OFF auto-snapshots a dirty main instead of asking");
	assert.match(src, /human questions are disabled[\s\S]{0,400}?gateOff: true/, "zense_ask refuses under gate OFF");
	assert.match(src, /auto-approved: gate OFF|gate OFF \(no sign prompt\)/, "a spec committed under gate OFF is auto-signed");
	assert.match(src, /Gate OFF — no sign\/approval prompts/, "/zense gate off explains the mode");
	assert.match(src.slice(src.indexOf('name: "zense_review"')), /state\.gateEnabled/, "review checks gateEnabled");
});
