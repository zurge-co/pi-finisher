import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	HUD_MARK,
	clockLabel,
	completeLap,
	declarePlan,
	hudFrames,
	hudHitMap,
	hudIdleLine,
	hudLines,
	pitMs,
	raceIdleLine,
	raceLoaderFrames,
	raceStagePaint,
	raceStageToken,
	raceState,
	racedMs,
	verifyMs,
} from "../extensions/finisher/index.ts";

const plan3 = () => {
	let p = declarePlan(["survey the parser", "rewrite the retry policy", "prove it with a command"], 1_000);
	p = completeLap(p, undefined, 11_000);
	p = completeLap(p, undefined, 26_000);
	p = completeLap(p, undefined, 45_000);
	return p;
};

const doneGoal = (extra = {}) => {
	const plan = plan3();
	return { goal: "ship it", confirmedAt: 1_000, doneAt: 61_000, outcome: "verified", phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs, ...extra };
};

const liveRun = { role: "swarm", status: "running", startedAt: 30_000, at: 30_000, slotId: "s1" };

const phases = () => [
	{ label: "idle", input: { runs: [] } },
	{ label: "plan", input: { runs: [], goal: { goal: "ship it", confirmedAt: 1_000 } } },
	{ label: "run", input: { runs: [liveRun], goal: { goal: "ship it", confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 30_000 } } },
	{ label: "verify", input: { runs: [], goal: { goal: "ship it", confirmedAt: 1_000, phases: plan3().phases, lap: 4, lapAt: 45_000, lapMs: [10_000, 15_000, 19_000] } } },
	{ label: "win", input: { runs: [], goal: doneGoal() } },
	{ label: "dnf", input: { runs: [], goal: doneGoal({ doneAt: 40_000, outcome: "halted", lap: 3, lapMs: [10_000, 15_000] }) } },
];

const CIRCLE = /[●○✕]/;
const STAGE_WORD = /\b(LAP|VERIFY|PLAN|READY|P1|DNF)\b/;

test("a finished race is exactly partitioned: laps + verification + pit = total, with nothing lost", () => {
	const plan = plan3();
	for (const [totalEnd, lapShare] of [[45_000, 1], [61_000, 1], [61_000, 0.5], [3_600_000, 0.25]]) {
		const goal = { goal: "g", confirmedAt: 1_000, doneAt: totalEnd, outcome: "verified", phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs.map((ms) => Math.floor(ms * lapShare)) };
		const raced = racedMs(goal);
		const verify = verifyMs(goal, totalEnd);
		const pit = pitMs(goal, totalEnd);
		const total = totalEnd - 1_000;
		assert.equal(raced + verify + pit, total, `total ${total}: ${raced} + ${verify} + ${pit} must equal the whole race`);
		assert.equal(verify, Math.max(0, totalEnd - 45_000), "verification starts when the last lap closes");
		assert.ok(pit >= 0 && pit <= total);
	}
});

test("the verified shape the harness always produces shows its verification window, not a fake pit", () => {
	const race = raceState({ goal: doneGoal() });
	assert.equal(race.phase, "win");
	assert.equal(race.totalMs, 60_000);
	assert.equal(race.racedMs, 44_000, "three closed laps keep their own measured time");
	assert.equal(race.verifyMs, 16_000, "the time after the last lap is the verification window");
	assert.equal(race.pitClock, "0:00", "a run with no idle overhead has no pit time");
	assert.equal(raceIdleLine(race, HUD_MARK), `${HUD_MARK} 1:00 · 3 laps · pit 0:00`, "the closed line is the mark, the goal's clock and its tally — no result word");
	const overhead = { ...doneGoal(), lapMs: [10_000, 10_000, 10_000], lapAt: 45_000, doneAt: 61_000 };
	const race2 = raceState({ goal: overhead });
	assert.equal(race2.verifyMs, 16_000, "the verify window still starts at the last lap close");
	assert.equal(race2.pitClock, "0:14", "time outside every lap and the verify window is pit time: 60 − 30 − 16");
});

test("the HUD and the loader carry the goal's clock and nothing else: no circle, no stage word, in any phase", () => {
	for (const { label, input } of phases()) {
		const race = raceState({ ...input, now: 62_000 });
		for (const text of [...hudLines({ ...input, width: 120, now: 62_000 }), hudIdleLine({ ...input, width: 120, now: 62_000 })]) {
			assert.ok(!CIRCLE.test(text), `${label}: a circle must never appear: ${text}`);
			assert.ok(!STAGE_WORD.test(text), `${label}: a stage word must never appear: ${text}`);
		}
		const { frames } = raceLoaderFrames(race, (_token, text) => text);
		if (race.phase === "idle") {
			assert.deepEqual(frames, [], "an idle session has no goal clock to show");
			assert.equal(hudIdleLine({ ...input, width: 120, now: 62_000 }), HUD_MARK, "idle is the mark alone");
			continue;
		}
		assert.deepEqual(frames, [race.totalClock], `${label}: the loader line is the goal's clock, exactly once`);
		assert.ok(hudLines({ ...input, width: 120, now: 62_000 })[0].includes(race.totalClock), `${label}: the HUD's first line carries the same clock`);
	}
});

test("six phases own six colours: the stage paint is total and one-to-one, plan is neither grey nor the failure colour, and a lap is not the accent", () => {
	const expected = { idle: "dim", plan: "borderAccent", run: "warning", verify: "accent", win: "success", dnf: "error" };
	const owned = new Map();
	for (const { label, input } of phases()) {
		const race = raceState({ ...input, now: 62_000 });
		assert.equal(race.phase, label, "the fixture reaches the phase it is named for");
		assert.equal(raceStagePaint(race), expected[label], `${label}: the paint is that token, never a fallback`);
		if (label === "idle") assert.equal(raceStageToken(race), undefined, "idle is no stage at all: the paint alone resolves it to dim");
		else assert.equal(raceStageToken(race), expected[label], `${label}: the stage's own token`);
		for (const [other, token] of owned) assert.notEqual(token, expected[label], `${label} may not borrow ${other}'s colour`);
		owned.set(label, raceStagePaint(race));
	}
	assert.equal(owned.size, 6, "six phases, six distinct colours");
	assert.ok(!["dim", "muted", "borderMuted", "error"].includes(expected.plan), "plan is a live stage: neither grey nor the failure colour");
	assert.notEqual(expected.run, "accent", "a running lap is not the accent violet");
	assert.equal(raceStagePaint(undefined), "dim", "a session with no race at all paints idle rather than nothing");
});

test("every HUD line fits the width it is given, at any width, for every race phase", () => {
	const states = phases().map((p) => p.input);
	for (let width = 8; width <= 140; width++) {
		for (const state of states) {
			const input = { ...state, width, now: 62_000 };
			const lines = hudLines(input);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);
			assert.equal(hudHitMap(input).length, lines.length, "one hit slot per painted line");
			assert.deepEqual(hudFrames(input).map((f) => f.text), lines, "the frames are what is painted");
		}
	}
	assert.match(clockLabel(3_599_999), /^59:59$/);
	assert.match(clockLabel(3_600_000), /^1:00:00$/);
});

test("the idle line stays one bare line: no cost counters and no warning tally", () => {
	const quiet = hudIdleLine({ runs: [], width: 200 });
	assert.equal(quiet, HUD_MARK, "an idle session says only what it is");
	const noisy = hudIdleLine({ runs: [], width: 200, flags: 2, hygiene: 1, escalations: 3 });
	assert.equal(noisy, quiet, "warning counters never clutter the idle line — they live on the open box");
	for (const text of [quiet, noisy]) assert.ok(!/turns|tok|⚠|🧹|🚨/.test(text), "and the cost counters are gone from the HUD entirely");
});
