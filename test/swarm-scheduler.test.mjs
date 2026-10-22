import { test } from "node:test";
import assert from "node:assert/strict";
import { runSwarm } from "../extensions/zense-harness/index.ts";

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
