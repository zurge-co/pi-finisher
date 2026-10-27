import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	TRACKER_RECORDS_MAX,
	TRACKER_RENDER_MAX,
	TRACKER_SESSIONS_MAX,
	TRACKER_STEPS_MAX,
	buildLapTracker,
	clearLapTracker,
	isSessionDirName,
	lastTrackerRecord,
	pruneTrackers,
	trackerRecords,
	readLapTracker,
	readLapTrackerFile,
	renderLapTracker,
	sessionDirKey,
	stepStateOf,
	stepsOf,
	trackerEvidence,
	trackerPath,
	writeLapTracker,
} from "../extensions/finisher/index.ts";
import { declarePlan, completeLap } from "../extensions/finisher/index.ts";
import { freshGoalRun } from "../extensions/finisher/index.ts";

const tmpRepo = () => mkdtempSync(join(tmpdir(), "finisher-tracker-"));

const goalWith = (plan, cases = []) => ({ ...freshGoalRun("ship the parser", 1_000, cases), phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs });

test("the plan has exactly one current lap at every point, and closing a lap moves that mark by one", () => {
	for (const total of [1, 2, 3, 9]) {
		const texts = Array.from({ length: total }, (_, i) => `lap ${i + 1}`);
		let plan = declarePlan(texts, 0);
		for (let closed = 0; closed <= total; closed++) {
			const states = stepsOf(plan).map((s) => s.state);
			const current = states.filter((s) => s === "current").length;
			const done = states.filter((s) => s === "done").length;
			const finished = plan.lap > total;
			assert.equal(current, finished ? 0 : 1, `total ${total}, closed ${closed}: exactly one current lap while the plan is open`);
			assert.equal(done, Math.min(total, plan.lap - 1), `total ${total}, closed ${closed}: every lap before the current one is done and none after`);
			assert.equal(states[0] === "current", plan.lap === 1, "the first lap is the current one before anything is closed");
			if (!finished) plan = { ...plan, ...completeLap(plan, undefined, 2_000) };
			assert.ok(plan.lap <= total + 1, "a lap close never overshoots the plan");
		}
	}
});

test("the state of a lap is a function of its position and the current lap only — the same plan cannot describe two different worlds", () => {
	const plan = declarePlan(["a", "b", "c", "d"], 0);
	for (let lap = 1; lap <= 5; lap++) {
		for (let index = 0; index < plan.phases.length; index++) {
			const state = stepStateOf({ ...plan, lap }, index);
			const expected = lap > plan.phases.length ? "done" : index + 1 < lap ? "done" : index + 1 === lap ? "current" : "todo";
			assert.equal(state, expected, `lap ${lap} index ${index}`);
		}
	}
});

test("the evidence list keeps the last status per command, so a fixed command is not reported as still failing", () => {
	const calls = [
		{ command: "npm test", ok: false },
		{ command: "npm  test", ok: true },
		{ command: "npm run typecheck", ok: true },
	];
	const evidence = trackerEvidence(calls, 5);
	assert.deepEqual(evidence.map((e) => [e.command, e.ok]), [["npm test", true], ["npm run typecheck", true]], "the retried command carries its final status, deduped");
	const many = Array.from({ length: 40 }, (_, i) => ({ command: `cmd ${i}`, ok: i % 2 === 0 }));
	assert.equal(trackerEvidence(many, 5).length, 5, "the tracker is bounded, never a transcript");
	assert.deepEqual(trackerEvidence(many, 5).map((e) => e.command), ["cmd 35", "cmd 36", "cmd 37", "cmd 38", "cmd 39"], "the most recent commands are the ones kept");
});

test("the tracker file exists exactly while a goal is open, and it round-trips what the next lap needs", () => {
	const cwd = tmpRepo();
	const session = "sess-a";
	const plan = declarePlan(["read the parser", "rewrite the retry policy", "prove it"], 0);
	const goal = goalWith(plan, ["typecheck passes", "tests pass"]);
	assert.equal(writeLapTracker(cwd, session, goal, [{ command: "npm test", ok: true }], 5_000), trackerPath(cwd, session));
	const read = readLapTracker(cwd, session);
	assert.equal(read.goal, "ship the parser");
	assert.equal(read.session, session);
	assert.equal(read.lap, 1);
	assert.equal(read.laps, 3);
	assert.equal(read.current.text, "read the parser");
	assert.deepEqual(read.next.map((s) => s.text), ["rewrite the retry policy", "prove it"]);
	assert.deepEqual(read.cases, ["typecheck passes", "tests pass"]);
	assert.deepEqual(read.evidence, [{ command: "npm test", ok: true }]);

	const advanced = { ...goal, ...completeLap(plan, undefined, 6_000) };
	writeLapTracker(cwd, session, advanced, [], 7_000);
	const second = readLapTracker(cwd, session);
	assert.equal(second.lap, 2, "a fresh lap is what the file reports");
	assert.equal(second.done, 1);
	assert.equal(second.current.text, "rewrite the retry policy");

	writeLapTracker(cwd, session, { ...advanced, doneAt: 9_000, outcome: "verified" }, [], 9_000);
	assert.equal(existsSync(trackerPath(cwd, session)), false, "a closed goal leaves no tracker behind — a stale one would mislead the next task");
	assert.equal(readLapTracker(cwd, session), undefined);
	assert.equal(writeLapTracker(cwd, session, undefined, [], 9_000), undefined, "no goal means no file");
	assert.equal(existsSync(trackerPath(cwd, session)), false);
});

test("two sessions on one repo never overwrite each other, and each resumes from its own goal", () => {
	const cwd = tmpRepo();
	const plan = declarePlan(["read the parser", "rewrite the retry policy"], 0);
	const first = goalWith(plan);
	const second = { ...goalWith(plan), goal: "ship the lexer" };
	const paths = ["sess-a", "sess-b"].map((s) => writeLapTracker(cwd, s, s === "sess-a" ? first : second, [], 1_000));
	assert.equal(new Set(paths).size, 2, "each session owns its own tracker file");
	assert.equal(readLapTracker(cwd, "sess-a").goal, "ship the parser");
	assert.equal(readLapTracker(cwd, "sess-b").goal, "ship the lexer");

	const advanced = { ...first, ...completeLap(plan, undefined, 6_000) };
	writeLapTracker(cwd, "sess-a", advanced, [], 7_000);
	assert.equal(readLapTracker(cwd, "sess-a").lap, 2, "one session's lap close is its own");
	assert.equal(readLapTracker(cwd, "sess-b").lap, 1, "the other session is still on lap 1");

	clearLapTracker(cwd, "sess-b");
	assert.equal(readLapTracker(cwd, "sess-a").lap, 2, "closing one session does not touch the other");
	assert.equal(readLapTracker(cwd, "sess-b"), undefined);
});

test("a session id never escapes the tracker directory, whatever the id looks like", () => {
	const cwd = tmpRepo();
	const goal = goalWith(declarePlan(["a"], 0));
	for (const id of ["../../etc/passwd", "/abs/path", "a b\tc", "..", "", "ÜNICODE-Σ".repeat(40)]) {
		const path = trackerPath(cwd, id);
		assert.ok(path.startsWith(`${cwd}/.finisher/`), `${JSON.stringify(id)} stays under the state dir: ${path}`);
		assert.equal(path, `${cwd}/.finisher/${sessionDirKey(id)}/tracker.jsonl`, `${JSON.stringify(id)} lives in its own session directory`);
		assert.equal(path.split("/").filter((p) => p === "..").length, 0, `${JSON.stringify(id)} never climbs out`);
		writeLapTracker(cwd, id, goal, [], 1_000);
		assert.equal(readLapTracker(cwd, id).goal, "ship the parser", `${JSON.stringify(id)} round-trips`);
	}
	for (const id of ["x".repeat(5_000), "../../etc/passwd", ""]) assert.ok(sessionDirKey(id).length <= 64, `a ${id.length}-char id still names a file a filesystem accepts (${sessionDirKey(id).length})`);
	assert.notEqual(sessionDirKey("sess-a"), sessionDirKey("sess-a2"), "a different id is a different tracker");
	assert.notEqual(sessionDirKey("sess-a"), sessionDirKey("sess_a"), "two ids that flatten to the same word stay two trackers");
});

test("a tracker write is atomic: the reader sees the old tracker or the new one, never a half-written file", () => {
	const cwd = tmpRepo();
	const plan = declarePlan(["read the parser", "rewrite the retry policy"], 0);
	const goal = goalWith(plan);
	writeLapTracker(cwd, "s", goal, [], 1_000);
	const path = trackerPath(cwd, "s");
	const before = readFileSync(path, "utf8");
	writeLapTracker(cwd, "s", { ...goal, ...completeLap(plan, undefined, 6_000) }, [], 7_000);
	const after = readFileSync(path, "utf8");
	assert.notEqual(before, after, "the write really replaced the file");
	assert.ok(after.startsWith(before), "a write appends a record instead of rewriting history");
	assert.deepEqual(trackerRecords(after).map((line) => JSON.parse(line).steps.map((s) => s.state)), [["current", "todo"], ["done", "current"]], "every record is complete JSON, never a truncated prefix");
	assert.deepEqual(readdirSync(dirname(path)).filter((n) => n.endsWith(".tmp")), [], "no temp file is left behind for the next reader to trip on");
});

test("the record file is bounded and junk proves nothing: the newest well-formed line is the state at any length", () => {
	const cwd = tmpRepo();
	const plan = declarePlan(["a", "b"], 0);
	let goal = goalWith(plan);
	for (let i = 0; i < TRACKER_RECORDS_MAX + 20; i++) {
		goal = { ...goal, attempts: { rounds: i } };
		writeLapTracker(cwd, "s", goal, [], 1_000 + i);
	}
	const path = trackerPath(cwd, "s");
	const lines = trackerRecords(readFileSync(path, "utf8"));
	assert.equal(lines.length, TRACKER_RECORDS_MAX, "the append-only file is capped, so a long-lived goal cannot grow without bound");
	assert.equal(JSON.parse(lines.at(-1)).round, TRACKER_RECORDS_MAX + 19, "the cap keeps the newest records, so the last line is the live state");
	assert.equal(readLapTracker(cwd, "s").round, TRACKER_RECORDS_MAX + 19, "the reader agrees with the last line");
	for (const junk of ["", "not json", "[]", '{"goal":1,"steps":[]}', '{"goal":"cut","steps":[{"id":"x"']) {
		const corrupt = `${lines.slice(0, -1).join("\n")}\n${junk}\n`;
		assert.equal(lastTrackerRecord(corrupt)?.round, TRACKER_RECORDS_MAX + 18, `${JSON.stringify(junk)} is skipped, so a torn write never becomes the state`);
	}
	assert.equal(lastTrackerRecord(""), undefined, "an empty file holds no state, and the reader invents none");
});

test("the tracker directory is pruned to the newest sessions, so a long-lived repo cannot grow without bound", () => {
	const cwd = tmpRepo();
	const goal = goalWith(declarePlan(["a"], 0));
	for (let i = 0; i < TRACKER_SESSIONS_MAX + 6; i++) writeLapTracker(cwd, `sess-${i}`, goal, [], 1_000 + i);
	const kept = readdirSync(join(cwd, ".finisher")).filter(isSessionDirName);
	assert.equal(kept.length, TRACKER_SESSIONS_MAX, "only the newest sessions keep a tracker");
	assert.ok(!kept.some((n) => n.startsWith("sess-0")), "the oldest session is the one dropped");
	for (let i = TRACKER_SESSIONS_MAX + 6 - TRACKER_SESSIONS_MAX; i < TRACKER_SESSIONS_MAX + 6; i++) assert.ok(readLapTracker(cwd, `sess-${i}`), `sess-${i} survives`);
	assert.equal(pruneTrackers(cwd, TRACKER_SESSIONS_MAX), 0, "pruning an already-pruned directory removes nothing");
	assert.equal(pruneTrackers(cwd, 1), TRACKER_SESSIONS_MAX - 1, "the prune count is what it actually removed");
});

test("the rendered tracker is bounded and always carries the goal and the current lap, whatever the plan length", () => {
	for (const total of [0, 1, 3, 40, 200]) {
		const texts = Array.from({ length: total }, (_, i) => `lap ${i + 1} ${"detail ".repeat(20)}`);
		const plan = total ? declarePlan(texts, 0) : { phases: [], lap: 0, lapAt: 0, lapMs: [] };
		const goal = goalWith(plan, Array.from({ length: 30 }, (_, i) => `case ${i} ${"x".repeat(300)}`));
		const tracker = buildLapTracker(goal, Array.from({ length: 30 }, (_, i) => ({ command: `cmd ${i} ${"y".repeat(200)}`, ok: i % 3 !== 0 })), 1_000);
		const text = renderLapTracker(tracker);
		assert.ok(text.length <= TRACKER_RENDER_MAX, `total ${total}: the tracker must stay small enough to ride every turn (${text.length})`);
		assert.ok(text.startsWith("[finisher lap tracker] goal: "), "the goal always leads, so a truncated tracker still says what is being built");
		assert.ok(text.includes("where: "), "the lap position survives truncation");
		if (total) {
			assert.ok(text.includes(`where: lap 1/${total}`), `total ${total}: the current lap number is stated`);
			assert.ok(text.includes("now: lap 1"), `total ${total}: the current lap's own text is stated`);
			assert.ok(text.split("\n").filter((l) => /^\s+[✓▶·] \d+\./.test(l)).length <= TRACKER_STEPS_MAX, `total ${total}: the plan window is capped`);
		} else {
			assert.ok(text.includes("no plan declared yet"), "an undeclared plan says so instead of inventing a lap");
		}
	}
});

test("clearing is idempotent, so a repeated reset cannot fail the run", () => {
	const cwd = tmpRepo();
	assert.equal(clearLapTracker(cwd, "s"), true, "clearing a tracker that was never written is not an error");
	writeLapTracker(cwd, "s", goalWith(declarePlan(["a"], 0)), [], 1_000);
	assert.equal(existsSync(trackerPath(cwd, "s")), true);
	assert.equal(clearLapTracker(cwd, "s"), true);
	assert.equal(existsSync(trackerPath(cwd, "s")), false);
	assert.equal(clearLapTracker(cwd, "s"), true, "clearing twice is still not an error");
});
