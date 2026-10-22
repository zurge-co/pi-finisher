import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../extensions/zense-harness/src/longrun-flow.ts", import.meta.url), "utf8");

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

test("the remaining completion path still preserves the final apply for /zense accept", () => {
	const calls = src.match(/resetLongrunPhaseCycle\([^;]*\)/g) ?? [];
	const preserved = calls.filter((c) => /, true\)$/.test(c));
	assert.equal(preserved.length, 1, `exactly one completion path remains and it preserves (got ${preserved.length} of ${calls.length})`);
	assert.ok(preserved[0].includes("{ auto: true, autoFixRounds: 0 }, true)"), "the AUTO final-apply path keeps pendingApply + lastEval");
	const applyThenReset = src.match(/longrunApplyFinal\(ctx, t\)[\s\S]{0,400}?resetLongrunPhaseCycle\(([^)]*)\)/g) ?? [];
	assert.equal(applyThenReset.length, 1, `exactly one final-apply site remains (got ${applyThenReset.length})`);
	for (const m of applyThenReset) assert.ok(/, true\)/.test(m), `final-apply reset must preserve: ${m.slice(-80)}`);
});

test("mid-phase resets still clear lastEval (a stale eval must not leak into the next phase)", () => {
	const calls = src.match(/resetLongrunPhaseCycle\([^;]*\)/g) ?? [];
	const cleared = calls.filter((c) => !/, true\)$/.test(c));
	assert.ok(cleared.length >= 1, "the mid-phase clear-reset path remains");
});
