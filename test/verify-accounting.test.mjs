import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bindClaims,
	buildLapTracker,
	buildReport,
	decideOnce,
	fixLapText,
	fixPhases,
	freshAttempts,
	freshGoalRun,
	makePhases,
	MAX_LOOP_BATCHES,
	recordEvidence,
	renderLapTracker,
	readLapTracker,
	stepsOf,
	TRACKER_GOAL_MAX,
	TRACKER_RENDER_MAX,
	TRACKER_STEP_MAX,
	writeLapTracker,
} from "../extensions/finisher/index.ts";

const clipTo = (text, max) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const RESULTS = ["FAIL", "UNVERIFIED", "BLOCKED"];

const caselist = (n) => Array.from({ length: n }, (_, i) => `case ${i + 1}: the ${i + 1}${i === 0 ? "st" : i === 1 ? "nd" : i === 2 ? "rd" : "th"} thing the human asked for holds for every input`);

const mixReport = (cases) =>
	buildReport(
		cases.map((caseId, i) => ({
			caseId,
			result: RESULTS[i % RESULTS.length],
			commands: [],
			reason: `${RESULTS[i % RESULTS.length]} because of ${i}`,
		})),
	);

test("every unproven case gets a fix lap that starts with its own text and claims back to exactly it", () => {
	for (let n = 1; n <= 12; n++) {
		const cases = caselist(n);
		const laps = fixPhases(mixReport(cases));
		assert.equal(laps.length, n, `one fix lap per unproven case (n=${n})`);
		const claimed = laps.map((lap) => {
			const bound = bindClaims(cases, [{ id: lap, command: "node --test", human: false }]);
			assert.deepEqual(bound.unbound, [], `the harness's own lap text always names a case: ${lap}`);
			const target = [...bound.commands.keys()][0];
			assert.ok(lap.startsWith(target), "the lap leads with the case text it exists for");
			return target;
		});
		assert.deepEqual([...claimed].sort(), [...cases].sort(), "every unproven case gets exactly one lap, and no lap names a proven one");
	}
});

test("the remedy never swallows the case: a clipped lap still binds, and a bare verb prefix still binds", () => {
	const cases = caselist(9);
	for (const caseId of cases) {
		const lap = fixLapText(caseId, "FAIL", "x".repeat(400));
		const clipped = lap.slice(0, 70);
		assert.deepEqual([...bindClaims(cases, [{ id: clipped, command: "node --test", human: false }]).commands.keys()], [caseId]);
		assert.deepEqual([...bindClaims(cases, [{ id: `fix ${caseId}`, command: "node --test", human: false }]).commands.keys()], [caseId]);
	}
});

test("a case whose text is a prefix of another is never bound by guess — it stays unbound and names both", () => {
	const short = "the clock ticks";
	const long = "the clock ticks and the lap number moves";
	const bound = bindClaims([short, long], [{ id: short, command: "node --test", human: false }]);
	assert.deepEqual([...bound.commands.keys()], [short], "the exact text wins over the longer case it prefixes");
	const vague = bindClaims([short, long], [{ id: "clock", command: "node --test", human: false }]);
	assert.deepEqual(vague.unbound.map((u) => u.id), ["clock"], "a fragment that means either case proves nothing");
});

test("the tracker on disk keeps every case, so a cleared context can still name them all", () => {
	for (let n = 1; n <= 12; n++) {
		const cases = caselist(n);
		const tracker = buildLapTracker(freshGoalRun("ship it", 1_000, cases), [], 2_000);
		assert.equal(tracker.cases.length, n, `no case is dropped (n=${n})`);
		tracker.cases.forEach((kept, i) => {
			const original = cases[i].replace(/\s+/g, " ").trim();
			assert.ok(original.startsWith(kept.replace(/…$/, "").trim()), `case ${i + 1} survives as its own opening text`);
		});
		assert.deepEqual(
			[...bindClaims(cases, tracker.cases.map((c) => ({ id: c, command: "node --test", human: false }))).commands.keys()],
			cases,
			"every kept case binds back to the case it came from",
		);
	}
});

test("the tracker on disk keeps the human's goal and every case whole — only the painted line is clipped", () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-accounting-"));
	const goalText = `goal ${'ก'.repeat(300)} tail`;
	const cases = caselist(12).map((c, i) => `${c} ${'ข'.repeat(200)} ${i}`);
	const goal = freshGoalRun(goalText, 1_000, cases);
	writeLapTracker(cwd, "sess-accounting", goal, [], 2_000);
	const read = readLapTracker(cwd, "sess-accounting");
	assert.equal(read.goal, goalText, "the goal is stored verbatim, never shortened on disk");
	assert.deepEqual(read.cases, cases, "every case is stored verbatim — the tracker is the state that survives a cleared context");
	const text = renderLapTracker(read);
	assert.ok(text.length <= TRACKER_RENDER_MAX, "what is painted is still bounded");
	assert.equal(text.split("\n")[0], `[finisher lap tracker] goal: ${clipTo(goalText, TRACKER_GOAL_MAX)}`, "the painted goal is the stored goal, clipped at the display bound");
});

test("a report gap is a fix lap every round until the bound — only the round budget stops it", () => {
	const report = buildReport([{ caseId: "c1", result: "UNVERIFIED", commands: [], reason: "no command was named for this case" }]);
	let attempts = freshAttempts();
	for (let round = 0; round < MAX_LOOP_BATCHES; round++) {
		assert.equal(decideOnce(report, attempts).kind, "replan", `round ${round + 1} keeps working`);
		attempts = { ...recordEvidence(attempts, report), rounds: attempts.rounds + 1 };
	}
	assert.equal(decideOnce(report, attempts).kind, "halt", "the bound still ends it");
});

test("a fix lap still names its case after the plan and the tracker clip it — at any case length, a two-letter id included", () => {
	const cases = ["c1", "it stops", caselist(9)[8], "x".repeat(140) + " holds"];
	for (const caseId of cases) {
		const [lap] = fixPhases(buildReport([{ caseId, result: "FAIL", commands: [], reason: "`node check.mjs` exited 1: boom" }]));
		const plan = makePhases([lap], 1, 1_000);
		for (const step of stepsOf({ phases: plan, lap: 1, lapAt: 0, lapMs: [] })) {
			assert.ok(step.text.length <= TRACKER_STEP_MAX, "the tracker keeps its own bound");
			const bound = bindClaims(cases, [{ id: step.text, command: "node check.mjs", human: false }]);
			assert.deepEqual(bound.unbound, [], `the tracker's own lap line names a case: ${step.text}`);
			assert.deepEqual([...bound.commands.keys()], [caseId], `and names exactly the case it was written for: ${step.text}`);
		}
	}
});

test("a case that carries the harness's own separators is never cut before it is matched", () => {
	const cases = ["ship it | the report is written", "ship it | the log is clean", "the run — every lap — is journaled", "the run — every lap — is counted"];
	for (const caseId of cases) {
		const [lap] = fixPhases(buildReport([{ caseId, result: "UNVERIFIED", commands: [], reason: "no command was named" }]));
		const bound = bindClaims(cases, [{ id: lap, command: "node check.mjs", human: false }]);
		assert.deepEqual([...bound.commands.keys()], [caseId], `a separator inside the case is the case's own text: ${lap}`);
	}
	const bare = bindClaims(["the clock ticks", "the clock ticks and the lap number moves"], [{ id: "clock", command: "node check.mjs", human: false }]);
	assert.deepEqual(bare.unbound.map((u) => u.id), ["clock"], "a fragment that is not a case is still never guessed");
});
