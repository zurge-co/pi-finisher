// longrun final apply: /zense accept must find the pendingApply the final apply created.
// Regression 2026-09-28: every completion path called longrunApplyFinal (sets
// state.pendingApply, repins state.lastEval.head to the index tree) and then
// resetLongrunPhaseCycle — whose unconditional clears wiped BOTH in the same turn.
// /zense accept then reported "no pending apply to accept", the tracker could never
// reach "done", and accept's amended-files detection (evalTree→HEAD) lost its pin.
// The closures live in the pi factory (can't run under node:test) → source guards,
// same convention as test/ask-tool.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../extensions/zense-harness/index.ts", import.meta.url), "utf8");

/** body of resetLongrunPhaseCycle (up to the next const trackerSummaryLines) */
const helperBody = (() => {
	const start = src.indexOf("const resetLongrunPhaseCycle =");
	assert.ok(start > 0, "resetLongrunPhaseCycle exists");
	const end = src.indexOf("const trackerSummaryLines", start);
	assert.ok(end > start, "helper body delimited");
	return src.slice(start, end);
})();

test("resetLongrunPhaseCycle accepts preserveFinalApply (default false = mid-phase behavior unchanged)", () => {
	assert.match(helperBody, /preserveFinalApply = false/);
});

test("pendingApply and lastEval clears are guarded by !preserveFinalApply inside the helper", () => {
	assert.ok(helperBody.includes("if (!preserveFinalApply) state.lastEval = undefined;"), "lastEval clear guarded");
	assert.ok(helperBody.includes("if (!preserveFinalApply) state.pendingApply = undefined;"), "pendingApply clear guarded");
	assert.ok(helperBody.includes("state.pendingApply = undefined"), "the clear still exists for mid-phase closure (was not deleted)");
});

test("all four final-apply call sites reset with the preserve flag", () => {
	// 1. autoLoopAdvance last-phase path
	assert.ok(
		src.includes("resetLongrunPhaseCycle(slugKeep, ver, { auto: true, autoFixRounds: 0 }, true)"),
		"autoLoopAdvance final path preserves the final apply",
	);
	// 2. close's done path
	assert.ok(
		src.includes("resetLongrunPhaseCycle(slugKeep, ver, undefined, true)"),
		"close done path preserves the final apply",
	);
	// 3+4. the two awaitingFinalApply retry sites (next + close actions)
	const retries = src.match(/resetLongrunPhaseCycle\(t\.slug, t\.version, undefined, true\)/g) ?? [];
	assert.equal(retries.length, 2, "both awaitingFinalApply retry sites preserve the final apply");
	// no final-apply call left un-preserved: every resetLongrunPhaseCycle call that follows
	// longrunApplyFinal carries the flag
	const applyThenReset = src.match(/longrunApplyFinal\(ctx, t\)[\s\S]{0,200}?resetLongrunPhaseCycle\(([^)]*)\)/g) ?? [];
	for (const m of applyThenReset) assert.ok(/, true\)/.test(m), `final-apply reset must preserve: ${m.slice(-80)}`);
});

test("awaitingFinalApply retry success enters review phase and persists", () => {
	const blocks = src.match(/if \(r\.ok\) \{\s*resetLongrunPhaseCycle\(t\.slug, t\.version, undefined, true\);[\s\S]{0,240}?\}/g) ?? [];
	assert.equal(blocks.length, 2, "both retry sites have the success block");
	for (const b of blocks) {
		assert.ok(b.includes('state.phase = "review"'), "retry success arms the review/accept flow");
		assert.ok(b.includes("persist()"), "retry success persists state");
	}
});

test("mid-phase resetLongrunPhaseCycle call sites still reset WITHOUT the preserve flag", () => {
	// the regular phase-close paths (auto-advance next-phase, close next-phase, fail, abandon)
	// must keep clearing lastEval — a preserved stale eval would leak into the next phase
	const allCalls = src.match(/resetLongrunPhaseCycle\([^;]*\)/g) ?? [];
	const preserved = allCalls.filter((c) => /, true\)$/.test(c));
	assert.equal(preserved.length, 4, `exactly the four completion paths preserve (got ${preserved.length})`);
	assert.ok(allCalls.length > preserved.length, "mid-phase clear-reset calls remain");
});
