import { test } from "node:test";
import assert from "node:assert/strict";
import { metricsLine, runSwarm, swarmMetrics } from "../extensions/finisher/index.ts";

const slot = (id, priority, model) => ({ id, priority, ...(model ? { model } : {}) });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("the scheduler never exceeds its concurrency bound, whatever the task count", async () => {
	for (const [concurrency, tasks, slots] of [[1, 7, 3], [2, 7, 5], [5, 5, 5], [3, 2, 3]]) {
		let inFlight = 0;
		let peak = 0;
		const results = await runSwarm(
			Array.from({ length: tasks }, (_, i) => ({ id: `t${i}` })),
			{
				slots: Array.from({ length: slots }, (_, i) => slot(`s${i}`, i + 1)),
				concurrency,
				run: async () => {
					inFlight += 1;
					peak = Math.max(peak, inFlight);
					await delay(5);
					inFlight -= 1;
					return { ok: true, output: "ok" };
				},
			},
		);
		assert.equal(peak, Math.min(concurrency, tasks, slots));
		assert.equal(results.filter((r) => r.ok).length, tasks);
	}
});

test("a failing slot hands the task to the next rung and the attempt count is bounded", async () => {
	const ladder = [slot("s1", 1, "m/one"), slot("s2", 2, "m/two"), slot("s3", 3, "m/three")];
	const reached = [];
	const run = async (_t, s, attempt) => {
		reached.push(`${s.id}@${attempt}`);
		return { ok: s.id === "s3", output: s.id };
	};
	const [ok] = await runSwarm([{ id: "x" }], { slots: ladder, maxAttempts: 3, run });
	assert.deepEqual(reached, ["s1@1", "s2@2", "s3@3"]);
	assert.equal(ok.ok, true);
	assert.equal(ok.model, "m/three");
	assert.equal(ok.failures.length, 2);

	reached.length = 0;
	const [never] = await runSwarm([{ id: "y" }], { slots: ladder, maxAttempts: 2, run: async (_t, s, a) => (reached.push(`${s.id}@${a}`), { ok: false, output: "no" }) });
	assert.equal(never.attempts, 2, "attempts must stop at maxAttempts even with slots left");
	assert.equal(never.ok, false);
});

test("a thrown runner is a failed attempt, not a crashed fan-out", async () => {
	let calls = 0;
	const [r] = await runSwarm([{ id: "boom" }], {
		slots: [slot("s1", 1)],
		maxAttempts: 2,
		run: async () => {
			calls += 1;
			throw new Error("spawn exploded");
		},
	});
	assert.equal(calls, 2);
	assert.equal(r.ok, false);
	assert.match(r.output, /spawn exploded/);
});

test("zero slots is refused before any work is accepted", async () => {
	await assert.rejects(() => runSwarm([{ id: "t" }], { slots: [], run: async () => ({ ok: true, output: "" }) }), /at least one slot/);
});

test("one wedged slice cannot hold a slot forever: the attempt bound abandons it so the remaining slices still run", async () => {
	const wedged = new Promise(() => {});
	const t0 = Date.now();
	const results = await runSwarm(
		[{ id: "hang" }, { id: "ok" }],
		{
			slots: [slot("s1", 1)],
			concurrency: 1,
			attemptMs: 60,
			maxAttempts: 1,
			run: async (task) => (task.id === "hang" ? wedged : { ok: true, output: "done" }),
		},
	);
	assert.equal(results.length, 2, "every task reaches a terminal result");
	const hang = results.find((r) => r.id === "hang");
	assert.equal(hang.ok, false, "the stuck slice is reported as a failure, not silence");
	assert.match(hang.output, /did not finish within/);
	assert.equal(results.find((r) => r.id === "ok").ok, true, "the slice behind it still runs once the attempt is abandoned");
	assert.ok(Date.now() - t0 < 10_000, "the serialised queue must not inherit the hang");
});

test("the attempt bound never changes a run that finishes inside it", async () => {
	const results = await runSwarm([{ id: "a" }], { slots: [slot("s1", 1)], concurrency: 1, attemptMs: 5_000, run: async () => ({ ok: true, output: "fine" }) });
	assert.equal(results[0].ok, true);
	assert.equal(results[0].output, "fine");
	assert.equal(results[0].attempts, 1);
});

test("a dependent slice starts only after its dependency succeeded, and it never runs before it", async () => {
	const events = [];
	const tasks = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
	const results = await runSwarm(tasks, {
		slots: [slot("s1", 1), slot("s2", 2), slot("s3", 3)],
		concurrency: 3,
		run: async (task) => {
			events.push(`start:${task.id}`);
			await delay(20);
			events.push(`done:${task.id}`);
			return { ok: true, output: task.id };
		},
	});
	assert.deepEqual(events, ["start:a", "done:a", "start:b", "done:b", "start:c", "done:c"], "a chain is serialised exactly in dependency order");
	assert.deepEqual(results.map((r) => [r.id, r.ok]), [["a", true], ["b", true], ["c", true]]);
});

test("independent slices still overlap: a dependency does not serialise the whole plan", async () => {
	let inFlight = 0;
	let peak = 0;
	const started = [];
	const results = await runSwarm(
		[{ id: "a" }, { id: "b" }, { id: "c", dependsOn: ["a"] }, { id: "d", dependsOn: ["a"] }],
		{
			slots: [slot("s1", 1), slot("s2", 2), slot("s3", 3), slot("s4", 4)],
			concurrency: 4,
			run: async (task) => {
				started.push(task.id);
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await delay(20);
				inFlight -= 1;
				return { ok: true, output: task.id };
			},
		},
	);
	assert.ok(peak >= 2, `independent work must still run at the same time (peak ${peak})`);
	assert.ok(started.indexOf("a") < started.indexOf("c"), "c starts after a, whatever the peak was");
	assert.ok(started.indexOf("a") < started.indexOf("d"));
	assert.equal(results.every((r) => r.ok), true);
});

test("a failed dependency blocks its dependents instead of attempting them blindly", async () => {
	const ran = [];
	const results = await runSwarm(
		[{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }, { id: "d" }],
		{
			slots: [slot("s1", 1), slot("s2", 2)],
			concurrency: 2,
			maxAttempts: 1,
			run: async (task) => {
				ran.push(task.id);
				return task.id === "a" ? { ok: false, output: "a broke" } : { ok: true, output: task.id };
			},
		},
	);
	assert.deepEqual(ran.sort(), ["a", "d"], "the dependents were never attempted — no coder is spawned on a broken base");
	const b = results.find((r) => r.id === "b");
	const c = results.find((r) => r.id === "c");
	assert.equal(b.ok, false);
	assert.deepEqual(b.blockedBy, ["a"], "b is blocked by the dependency that failed");
	assert.deepEqual(c.blockedBy, ["b"], "c is blocked by its own dependency, which was itself blocked — the chain is never attempted");
	assert.match(b.output, /not attempted/);
	assert.equal(results.find((r) => r.id === "d").ok, true, "a slice with no dependency still runs");
});

test("a plan with no dependencies behaves exactly as before: the peak is the bound, not the chain", async () => {
	let inFlight = 0;
	let peak = 0;
	await runSwarm(
		Array.from({ length: 9 }, (_, i) => ({ id: `t${i}` })),
		{
			slots: [slot("s1", 1), slot("s2", 2), slot("s3", 3)],
			concurrency: 3,
			run: async () => {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await delay(5);
				inFlight -= 1;
				return { ok: true, output: "ok" };
			},
		},
	);
	assert.equal(peak, 3, "a dependency-free list still fills the ladder and stays under the bound");
});

test("every result carries its own timing, so a slow coder can be told apart from a slow queue", async () => {
	const results = await runSwarm(
		[{ id: "slow" }, { id: "fast" }],
		{
			slots: [slot("s1", 1)],
			concurrency: 1,
			run: async (task) => {
				await delay(task.id === "slow" ? 60 : 5);
				return { ok: true, output: task.id };
			},
		},
	);
	const slow = results.find((r) => r.id === "slow");
	const fast = results.find((r) => r.id === "fast");
	assert.ok(slow.wallMs >= 50, `the slow slice reports its own wall time (${slow.wallMs}ms)`);
	assert.ok(fast.queuedMs >= 50, `the second slice reports the wait before it was claimed (${fast.queuedMs}ms)`);
	assert.equal(slow.queuedMs, 0);
	assert.ok(slow.failures.every((f) => typeof f.ms === "number"));
});

test("a retried slice is counted as rework, and a blocked one is counted as blocked — never as work", async () => {
	const results = await runSwarm(
		[{ id: "retry" }, { id: "dead" }, { id: "child", dependsOn: ["dead"] }],
		{
			slots: [slot("s1", 1), slot("s2", 2)],
			concurrency: 2,
			maxAttempts: 2,
			run: async (task, _slot, attempt) => {
				if (task.id === "retry") return attempt === 1 ? { ok: false, output: "first attempt failed" } : { ok: true, output: "second attempt ok" };
				return { ok: false, output: `${task.id} failed` };
			},
		},
	);
	const at = Date.now();
	const m = swarmMetrics(results, 1_234);
	assert.equal(m.reworkCount, 2, "every slice that needed more than one attempt is rework, whatever its final outcome");
	assert.equal(m.recovered, 1, "and only the one that succeeded on the retry is a recovery");
	assert.equal(m.blocked, 1, "a slice that never ran because its dependency failed is blocked, not reworked");
	assert.equal(m.attempts, 4, "two attempts each for the retried and the failing slice, none for the blocked one");
	assert.equal(m.wallMs, 1_234);
	assert.match(metricsLine(m), /2 reworked \(1 recovered\)/);
	assert.match(metricsLine(m), /1 blocked/);
	assert.ok(swarmMetrics([], 0).reworkCount === 0 && at > 0);
});
