import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PLAN_INFRA_MARKERS,
	PLAN_DEFAULT_CONCURRENCY,
	PLAN_OUTPUT_MAX,
	cacheKeyOf,
	isInfraOutput,
	planBroke,
	planKey,
	planLines,
	processRunner,
	runPlan,
	scopedPlan,
	statusOf,
} from "../extensions/finisher/src/check-runner.ts";

const ok = { exitCode: 0, output: "" };
const task = (id, paths) => ({ id, command: "node", args: ["-e", "0"], ...(paths ? { paths } : {}) });

test("the concurrency cap is a real bound: nine tasks never put more than three in flight", async () => {
	let inFlight = 0;
	let peak = 0;
	const tasks = Array.from({ length: 9 }, (_, i) => task(`t${i}`));
	const results = await runPlan(tasks, {
		concurrency: 3,
		run: async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 2));
			inFlight--;
			return ok;
		},
	});
	assert.equal(peak, 3, "exactly the cap runs at once, never more");
	assert.equal(results.length, 9, "every task finishes");
	assert.deepEqual(results.map((r) => r.id), tasks.map((t) => t.id));
	assert.equal(PLAN_DEFAULT_CONCURRENCY >= 2, true, "the default is parallel, not one-at-a-time");
});

test("the result order is the task order, whatever the completion order is", async () => {
	const tasks = ["a", "b", "c", "d"].map((id) => task(id));
	const delays = { a: 60, b: 40, c: 20, d: 5 };
	const finished = [];
	const results = await runPlan(tasks, {
		concurrency: 4,
		run: async (t) => {
			await new Promise((resolve) => setTimeout(resolve, delays[t.id]));
			finished.push(t.id);
			return ok;
		},
	});
	assert.deepEqual(finished, ["d", "c", "b", "a"], "the runs really finish out of order");
	assert.deepEqual(results.map((r) => r.id), ["a", "b", "c", "d"]);
});

test("a fingerprint makes a second run free and a changed fingerprint runs it again", async () => {
	let calls = 0;
	const run = async () => {
		calls++;
		return ok;
	};
	const cache = new Map();
	const tasks = [task("t")];
	const first = await runPlan(tasks, { run, cache, fingerprint: "f1" });
	const second = await runPlan(tasks, { run, cache, fingerprint: "f1" });
	const third = await runPlan(tasks, { run, cache, fingerprint: "f2" });
	assert.equal(calls, 2, "the cached fingerprint never reaches the runner again");
	assert.equal(first[0].cached, false);
	assert.equal(second[0].cached, true);
	assert.equal(second[0].status, first[0].status, "a cache hit keeps the judged status");
	assert.equal(third[0].cached, false);
	assert.notEqual(cacheKeyOf(tasks[0], "f1"), cacheKeyOf(tasks[0], "f2"));
	assert.equal(cacheKeyOf(tasks[0], "f1"), `${planKey(tasks[0])}@f1`);
});

test("scoping runs exactly the checks a changed path can affect, and never silently skips the unknown", async () => {
	const tasks = [task("typecheck"), task("gui", ["extensions/finisher/src/gui.ts"]), task("swarm", ["extensions/finisher/src/swarm.ts"])];
	const ids = (changed) => scopedPlan(tasks, changed).map((t) => t.id);
	assert.deepEqual(ids([]), ["typecheck", "gui", "swarm"], "an empty change set runs everything");
	assert.deepEqual(ids(["extensions/finisher/src/gui.ts"]), ["typecheck", "gui"]);
	assert.deepEqual(ids(["extensions/finisher/src"]), ["typecheck", "gui", "swarm"], "a changed directory covers the files inside it");
	assert.deepEqual(ids(["README.md"]), ["typecheck"], "a path no check owns leaves only the unscoped check");
	assert.deepEqual(ids([".\\extensions\\finisher\\src\\gui.ts"]), ["typecheck", "gui"], "windows separators still scope");
	assert.deepEqual(scopedPlan(tasks, ["extensions/finisher/src/gui.ts.bak"]), [tasks[0]], "a lookalike path does not match a check");
});

test("a missing toolchain and a cut-off check never count as the repo being broken, a real failure always does", () => {
	assert.equal(statusOf({ exitCode: 0, output: "" }), "pass");
	assert.equal(statusOf({ exitCode: 0, output: "Cannot find module 'typescript'" }), "pass", "exit zero is a pass whatever the output says");
	assert.equal(statusOf({ exitCode: 127, output: "sh: tsc: command not found" }), "infra");
	assert.equal(statusOf({ exitCode: 1, output: "Error: ENOENT: no such file or directory" }), "infra");
	assert.equal(statusOf({ exitCode: 3, output: "2 tests failed" }), "fail");
	assert.equal(statusOf({ exitCode: 0, output: "", timedOut: true }), "deadline");
	for (const marker of PLAN_INFRA_MARKERS) assert.equal(isInfraOutput(`prefix ${marker} suffix`), true);
	assert.equal(isInfraOutput(""), false);
	const results = (statuses) => statuses.map((status, i) => ({ ...task(`t${i}`), status, exitCode: status === "pass" ? 0 : 1, output: "", ms: 1, cached: false }));
	assert.equal(planBroke(results(["pass", "infra", "deadline"])), false);
	assert.equal(planBroke(results(["pass", "fail"])), true);
	assert.equal(planBroke([]), false);
});

test("each status paints its own mark and only a pass may say PASS", () => {
	const results = (statuses) => statuses.map((status, i) => ({ ...task(`t${i}`), status, exitCode: 0, output: "", ms: 7, cached: false }));
	const lines = planLines(results(["pass", "fail", "infra", "deadline"]));
	assert.deepEqual(lines.map((l) => l.split(/\s+/)[0]), ["PASS", "FAIL", "SKIP", "TIMEOUT"]);
	assert.equal(new Set(lines.map((l) => l.split(/\s+/)[0])).size, 4, "four statuses, four distinct marks");
});

test("the real runner maps a real exit code and a real deadline", async () => {
	const run = processRunner(process.cwd());
	assert.deepEqual(await run({ id: "pass", command: process.execPath, args: ["-e", "0"] }, 20_000), { exitCode: 0, output: "" });
	const failed = await run({ id: "fail", command: process.execPath, args: ["-e", "process.exit(3)"] }, 20_000);
	assert.equal(failed.exitCode, 3);
	assert.equal(failed.timedOut, undefined);
	const slow = await run({ id: "slow", command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }, 1_000);
	assert.equal(slow.timedOut, true, "a hung check is cut by its deadline");
	assert.equal(statusOf(slow), "deadline");
	assert.ok(slow.output.length <= PLAN_OUTPUT_MAX, "the captured output stays under the cap");
});
