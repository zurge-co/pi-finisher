import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	RACE_LANES,
	clockLabel,
	declarePlan,
	completeLap,
	hudFrames,
	hudIdleLine,
	hudHitMap,
	hudLines,
	pitMs,
	raceIdleLine,
	raceLightsText,
	raceLoaderCaption,
	raceLoaderFrames,
	raceLoaderMessage,
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

test("a finished race is exactly partitioned: laps + verification + pit = total, with nothing lost", () => {
	const plan = plan3();
	for (const totalEnd of [45_000, 61_000, 3_600_000]) {
		for (const pad of [0, 999, 16_000]) {
			const goal = { goal: "g", confirmedAt: 1_000, doneAt: totalEnd, outcome: "verified", phases: plan.phases, lap: plan.lap, lapAt: plan.lapAt, lapMs: plan.lapMs };
			const raced = racedMs(goal);
			const verify = verifyMs(goal, totalEnd);
			const pit = pitMs(goal, totalEnd);
			const total = totalEnd - 1_000;
			assert.equal(raced + verify + pit, total, `total ${total}: ${raced} + ${verify} + ${pit} must equal the whole race`);
			assert.equal(verify, Math.max(0, totalEnd - 45_000), "verification starts when the last lap closes");
			assert.ok(pit >= 0 && pit <= total);
		}
	}
});

test("the verified shape the harness always produces shows its verification window, not a fake pit", () => {
	const race = raceState({ goal: doneGoal(), lanes: RACE_LANES });
	assert.equal(race.phase, "win");
	assert.equal(race.totalMs, 60_000);
	assert.equal(race.racedMs, 44_000, "three closed laps keep their own measured time");
	assert.equal(race.verifyMs, 16_000, "the time after the last lap is the verification window");
	assert.equal(race.pitClock, "0:00", "a run with no idle overhead has no pit time");
	assert.match(raceIdleLine(race, "▚"), /P1 · 1:00 · 3 laps · pit 0:00/);
	const overhead = { ...doneGoal(), lapMs: [10_000, 10_000, 10_000], lapAt: 45_000, doneAt: 61_000 };
	const race2 = raceState({ goal: overhead, lanes: RACE_LANES });
	assert.equal(race2.verifyMs, 16_000, "the verify window still starts at the last lap close");
	assert.equal(race2.pitClock, "0:14", "time outside every lap and the verify window is pit time: 60 − 30 − 16");
});

test("the lights are always exactly one glyph per lane, lit as a filled prefix", () => {
	for (let lanes = 1; lanes <= RACE_LANES; lanes++) {
		for (let busy = 0; busy <= RACE_LANES + 2; busy++) {
			const runs = Array.from({ length: busy }, () => ({ role: "swarm", status: "running" }));
			const race = raceState({ goal: { goal: "g" }, runs, lanes });
			const text = raceLightsText(race);
			assert.equal([...text].length, lanes, `lanes ${lanes} busy ${busy}`);
			const lit = [...text].filter((c) => c === "●").length;
			assert.equal(lit, Math.min(lanes, busy), "lit lamps are lanes that are actually running");
			assert.equal(text, "●".repeat(lit) + "○".repeat(lanes - lit), "a lit prefix, never a gap");
		}
	}
});

test("the loader and the HUD say the same thing, and the caption clock tracks the lap", () => {
	const goal = { goal: "g", confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 50_000, lapMs: [2_000] };
	const early = raceState({ goal, lanes: 3, now: 56_000 });
	const late = raceState({ goal, lanes: 3, now: 62_000 });
	assert.equal(raceLoaderMessage(early).trim(), raceLoaderCaption(early));
	assert.equal(raceLoaderCaption(early), "LAP 2/3 0:06");
	assert.equal(raceLoaderCaption(late), "LAP 2/3 0:12", "six seconds later is six seconds later");
	for (const race of [early, late]) {
		const { frames } = raceLoaderFrames(race, (_t, s) => `\u001b[35m${s}\u001b[0m`);
		assert.equal(new Set(frames.map((f) => visibleWidth(f))).size, 1, "an animating loader must not jump columns");
		assert.ok(frames.every((f) => [...f].filter((c) => "●○".includes(c)).length === 3), "one lamp per lane in every frame");
	}
});

test("a done race closes to one line that names the result, the total, the laps and the pit, and never the cost", () => {
	const won = raceState({ goal: doneGoal(), lanes: RACE_LANES });
	const lost = raceState({ goal: doneGoal({ doneAt: 40_000, outcome: "halted", phases: plan3().phases, lap: 3, lapMs: [10_000, 15_000] }), lanes: RACE_LANES });
	for (const race of [won, lost]) {
		const line = raceIdleLine(race, "▚");
		assert.ok(!/turns|tok/.test(line), `the cost counters live in the footer, not the HUD: ${line}`);
		assert.equal([...raceLightsText(race)].length, RACE_LANES);
	}
	assert.match(raceIdleLine(lost, "▚"), /✕{5} DNF · halted · 0:39 · 2\/3 laps/);
	const idle = hudLines({ runs: [], width: 120, lanes: RACE_LANES });
	assert.equal(idle.length, 1);
	assert.match(idle[0], /^▚ finisher · ○{5} READY$/);
});

test("every HUD line fits the width it is given, at any width, for every race phase", () => {
	const states = [
		{ runs: [] },
		{ runs: [], goal: { goal: "g", confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 5_000 } },
		{ runs: [{ role: "swarm", status: "running", startedAt: 1, at: 1, slotId: "slot1" }], goal: { goal: "g".repeat(300), confirmedAt: 1_000, phases: plan3().phases, lap: 1, lapAt: 5_000 } },
		{ runs: [], goal: doneGoal() },
	];
	for (let width = 8; width <= 140; width++) {
		for (const state of states) {
			const input = { ...state, lanes: RACE_LANES, width, now: 62_000 };
			const lines = hudLines(input);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);
			assert.equal(hudHitMap(input).length, lines.length, "one hit slot per painted line");
			assert.equal(hudFrames(input)[0].text, lines[0] === hudIdleLine(input) ? lines[0] : lines[0]);
		}
	}
	assert.match(clockLabel(3_599_999), /^59:59$/);
	assert.match(clockLabel(3_600_000), /^1:00:00$/);
});

test("the HUD and the loader show the same race, including the clock the loader counts", () => {
	const goal = { goal: "g".repeat(20), confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 50_000, lapMs: [2_000] };
	for (const now of [50_000, 56_000, 61_000, 3_590_000]) {
		const input = { goal, runs: [{ role: "swarm", status: "running", startedAt: now, at: now, slotId: "s1" }], lanes: 5, width: 120, now };
		const race = raceState(input);
		const caption = raceLoaderCaption(race);
		assert.ok(caption.startsWith(race.caption), `the loader caption carries the phase: ${caption}`);
		assert.ok(caption.endsWith(race.lapClock), `the loader clock is the race clock: ${caption}`);
		const hud = hudLines(input).join("\n");
		assert.ok(hud.includes(race.caption), "the HUD names the same lap");
		assert.ok(hud.includes(race.lapClock), `the HUD shows the same clock the loader counts: ${race.lapClock} missing from ${hud.split("\n")[0]}`);
	}
	const idle = hudLines({ goal: { goal: "done", confirmedAt: 1_000, doneAt: 61_000, outcome: "verified", phases: plan3().phases, lap: 4, lapAt: 45_000, lapMs: [10_000, 15_000, 19_000] }, runs: [], lanes: 5, width: 200 });
	assert.match(idle[0], /P1 · 1:00 · 3 laps · pit 0:00/, "a finished goal keeps its total, lap count and pit");
});

test("the idle line stays one bare line: no cost counters and no warning tally", () => {
	const quiet = hudIdleLine({ runs: [], width: 200, lanes: 5 });
	assert.match(quiet, /^▚ finisher · ○{5} READY$/, "an idle session says only what it is");
	const noisy = hudIdleLine({ runs: [], width: 200, lanes: 5, flags: 2, hygiene: 1, escalations: 3 });
	assert.equal(noisy, quiet, "warning counters never clutter the idle line — they live on the open box");
	for (const text of [quiet, noisy]) assert.ok(!/turns|tok|⚠|🧹|🚨/.test(text), "and the cost counters are gone from the HUD entirely");
});

test("a done race closes to one line that names the result, the total, the laps and the pit, and never the cost", () => {
	const won = raceState({ goal: doneGoal(), lanes: RACE_LANES });
	const lost = raceState({ goal: doneGoal({ doneAt: 40_000, outcome: "halted", phases: plan3().phases, lap: 3, lapMs: [10_000, 15_000] }), lanes: RACE_LANES });
	for (const race of [won, lost]) {
		const line = raceIdleLine(race, "▚");
		assert.ok(!/turns|tok/.test(line), `the cost counters live in the footer, not the HUD: ${line}`);
		assert.equal([...raceLightsText(race)].length, RACE_LANES);
	}
	assert.match(raceIdleLine(lost, "▚"), /✕{5} DNF · halted · 0:39 · 2\/3 laps/);
	const idle = hudLines({ runs: [], width: 120, lanes: RACE_LANES });
	assert.equal(idle.length, 1);
	assert.match(idle[0], /^▚ finisher · ○{5} READY$/);
});

test("every HUD line fits the width it is given, at any width, for every race phase", () => {
	const states = [
		{ runs: [] },
		{ runs: [], goal: { goal: "g", confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 5_000 } },
		{ runs: [{ role: "swarm", status: "running", startedAt: 1, at: 1, slotId: "slot1" }], goal: { goal: "g".repeat(300), confirmedAt: 1_000, phases: plan3().phases, lap: 1, lapAt: 5_000 } },
		{ runs: [], goal: doneGoal() },
	];
	for (let width = 8; width <= 140; width++) {
		for (const state of states) {
			const input = { ...state, lanes: RACE_LANES, width, now: 62_000 };
			const lines = hudLines(input);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}"`);
			assert.equal(hudHitMap(input).length, lines.length, "one hit slot per painted line");
			assert.equal(hudFrames(input)[0].text, lines[0] === hudIdleLine(input) ? lines[0] : lines[0]);
		}
	}
	assert.match(clockLabel(3_599_999), /^59:59$/);
	assert.match(clockLabel(3_600_000), /^1:00:00$/);
});

test("the HUD and the loader show the same race, including the clock the loader counts", () => {
	const goal = { goal: "g".repeat(20), confirmedAt: 1_000, phases: plan3().phases, lap: 2, lapAt: 50_000, lapMs: [2_000] };
	for (const now of [50_000, 56_000, 61_000, 3_590_000]) {
		const input = { goal, runs: [{ role: "swarm", status: "running", startedAt: now, at: now, slotId: "s1" }], lanes: 5, width: 120, now };
		const race = raceState(input);
		const caption = raceLoaderCaption(race);
		assert.ok(caption.startsWith(race.caption), `the loader caption carries the phase: ${caption}`);
		assert.ok(caption.endsWith(race.lapClock), `the loader clock is the race clock: ${caption}`);
		const hud = hudLines(input).join("\n");
		assert.ok(hud.includes(race.caption), "the HUD names the same lap");
		assert.ok(hud.includes(race.lapClock), `the HUD shows the same clock the loader counts: ${race.lapClock} missing from ${hud.split("\n")[0]}`);
	}
	const idle = hudLines({ goal: { goal: "done", confirmedAt: 1_000, doneAt: 61_000, outcome: "verified", phases: plan3().phases, lap: 4, lapAt: 45_000, lapMs: [10_000, 15_000, 19_000] }, runs: [], lanes: 5, width: 200 });
	assert.match(idle[0], /P1 · 1:00 · 3 laps · pit 0:00/, "a finished goal keeps its total, lap count and pit");
});

