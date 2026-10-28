import { writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { budgetFits, budgetNote, effortFor, MAX_EFFORT, swarmWallMs, wavesFor } from "../extensions/finisher/index.ts";
import { capNeededFor, DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const sub = (o, w) => ({ subagentMs: o, attempts: 1, waves: w });
const cap = (c, o, w, a = 1) => ({ toolCapMs: c, subagentMs: o, attempts: a, waves: w });

test("coder attempts are clamped to a real bound, whatever the caller asks for", () => {
	assert.equal(effortFor(undefined), 2, "the default is a failover budget of two");
	assert.equal(effortFor(5), 5, "it honours what the caller asked, up to the ceiling");
	for (const requested of [0, -4, 0.5]) assert.equal(effortFor(requested) >= 1, true, `a nonsense bound still runs at least once: ${requested}`);
	for (const requested of [99, Number.MAX_SAFE_INTEGER]) assert.equal(effortFor(requested) <= MAX_EFFORT, true, `${requested} must not become an unbounded retry loop`);
});

test("one wave of coders fits the default cap, and both a second attempt and a serialised ladder are what break it", () => {
	for (let cases = 1; cases <= 8; cases++) {
		const waves = wavesFor(cases, Math.max(cases, 1));
		assert.equal(budgetFits(cap(DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS.coder, waves, 1)), true, `cases=${cases} at full concurrency must fit`);
	}
	const twoAttempts = cap(DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS.coder, 1, 2);
	assert.equal(budgetFits(twoAttempts), false, "a failover attempt is exactly what cannot fit for a long run");
	assert.match(budgetNote(twoAttempts), /1200s/);
	const serialised = cap(DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS.coder, 4, 1);
	assert.equal(budgetFits(serialised), false, "many waves at low concurrency still do not fit, and the note must say so");
	assert.match(budgetNote(serialised), /2400s/);
});

test("the budget note fires exactly when the worst case exceeds the cap, and never for a fitting fan-out", () => {
	const fits = cap(DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS.coder, 1);
	assert.equal(budgetFits(fits), true);
	assert.equal(budgetNote(fits), undefined);
	const blown = cap(DEFAULT_TOOL_TIMEOUT_MS, SUBAGENT_TIMEOUT_MS.coder, 2, 2);
	assert.equal(budgetFits(blown), false);
	const note = budgetNote(blown);
	assert.match(note, /budget:/);
	assert.match(note, /toolTimeoutMs/);
	assert.match(note, /2400s/);
	assert.match(note, /900s/);
});

test("the worst case is attempts × per-run × waves, and waves round up (never down)", () => {
	assert.equal(wavesFor(8, 5), 2);
	assert.equal(wavesFor(5, 5), 1);
	assert.equal(wavesFor(1, 8), 1);
	assert.equal(wavesFor(0, 5), 0);
	assert.equal(wavesFor(5, 0), 0);
	assert.equal(swarmWallMs(sub(600_000, 2)), 1_200_000);
	assert.equal(swarmWallMs({ subagentMs: 600_000, attempts: 2, waves: 2 }), 2_400_000);
	for (let c = 1; c <= 16; c++) {
		for (let tasks = 1; tasks <= 16; tasks++) {
			assert.equal(wavesFor(tasks, c), Math.ceil(tasks / c), `waves(${tasks}, ${c})`);
			assert.equal(wavesFor(tasks, c) <= wavesFor(tasks, c - 1 === 0 ? 1 : c - 1) || c === 1, true, "more concurrency never needs more waves");
		}
	}
});

test("the tool actually asks for effort, not the raw client bound", () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /const effort = effortFor\(p\.maxAttempts\)/, "the tool asks for effort, not for the raw client bound");
	assert.match(tools, /maxAttempts: effort,/);
	assert.doesNotMatch(tools, /maxAttempts: p\.maxAttempts \?\? 2/, "the raw bound must not reach the scheduler on the verify path");
	assert.match(tools, /budgetNote\(/, "a fan-out that cannot fit must say so before it starts");
});

test("the fan-out says where its concurrency came from, so the ladder size is never a silent limit", async () => {
	const { concurrencyFor } = await import("../extensions/finisher/index.ts");
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const repo = (cfg) => {
		const dir = mkdtempSync(join(tmpdir(), "finisher-conc-"));
		if (cfg) writeState(dir, "config.json", JSON.stringify(cfg));
		return dir;
	};
	const unset = repo(undefined);
	assert.deepEqual(concurrencyFor(unset, 2, 6), { concurrency: 2, source: "slots" }, "with fewer slots than cases the ladder is the limit — and it says so");
	assert.deepEqual(concurrencyFor(unset, 5, 2), { concurrency: 2, source: "tasks" }, "with more slots than cases the case count is the limit");
	assert.deepEqual(concurrencyFor(repo({ swarmConcurrency: 3 }), 5, 6), { concurrency: 3, source: "config" }, "an explicit setting wins and is labelled");
	assert.deepEqual(concurrencyFor(repo({ swarmConcurrency: 99 }), 3, 6), { concurrency: 3, source: "config" }, "the slot count still caps an oversized setting");
	assert.deepEqual(concurrencyFor(unset, 0, 0), { concurrency: 0, source: "none" });
	for (let slots = 1; slots <= 8; slots++)
		for (let tasks = 1; tasks <= 8; tasks++) {
			const got = concurrencyFor(unset, slots, tasks).concurrency;
			assert.ok(got <= slots && got <= tasks && got >= 1, `concurrency ${got} escapes the meet of slots=${slots} and tasks=${tasks}`);
		}
});

test("the outer cap is widened to what the fan-out needs, never narrowed below the configured cap", async () => {
	const tools = readFileSync(join(here, "extensions/finisher/src/tools.ts"), "utf8");
	assert.match(tools, /Math\.max\(configured, needed\)/, "a configured cap is a floor, so a slow fan-out is never cut off early");
	assert.match(tools, /capNeededFor\(/, "the widened cap comes from the one budget module");
	for (let cases = 1; cases <= 8; cases++) {
		for (const concurrency of [1, 2, 5, 8]) {
			const waves = wavesFor(cases, concurrency);
			const needed = capNeededFor({ subagentMs: SUBAGENT_TIMEOUT_MS.coder, attempts: 1, waves });
			assert.equal(budgetFits({ toolCapMs: needed, subagentMs: SUBAGENT_TIMEOUT_MS.coder, attempts: 1, waves }), true, `the widened cap must cover ${cases} slices at concurrency ${concurrency}`);
			assert.ok(needed >= waves * SUBAGENT_TIMEOUT_MS.coder, "the widened cap covers the worst case, not a fraction of it");
		}
	}
});
