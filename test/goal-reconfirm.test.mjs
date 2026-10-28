import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appendPhases,
	bindClaims,
	buildReport,
	caseClaims,
	casesForGate,
	decideOnce,
	freshAttempts,
	freshGoalRun,
	goalGateAsks,
	goalGateFor,
	judgeDeterministic,
	nextGoalDriverStep,
	recordEvidence,
	reopenGoal,
	renderVerifyReport,
} from "../extensions/finisher/index.ts";

const closedRun = (over = {}) => ({
	...freshGoalRun("ship the race HUD", 1_000, ["the lap clock ticks"]),
	attempts: { rounds: 1 },
	phases: [{ id: "p-read", text: "read it", round: 0, addedAt: 1_000 }],
	lap: 2,
	lapAt: 2_000,
	lapMs: [1_000],
	doneAt: 3_000,
	outcome: "needs-human",
	...over,
});

const unproven = (caseId) => ({ caseId, result: "UNVERIFIED", commands: [], reason: "no command was named for this case — a case with no executed check is not proven" });

test("an unchanged goal is resumed without a new confirmation, even after the run closed", () => {
	const prev = closedRun();
	assert.equal(goalGateFor(undefined, "ship the race HUD"), "fresh", "a first goal is always asked");
	assert.equal(goalGateFor(prev, "  SHIP   the race hud "), "reopen", "an unchanged goal that closed comes back without a dialog");
	assert.equal(goalGateFor({ ...prev, doneAt: undefined }, "ship the race HUD"), "resume");
	assert.equal(goalGateFor(prev, "ship something else"), "changed", "a different goal still goes to the human");

	const reopened = reopenGoal(prev, ["the pit split is exact"], 3_000);
	assert.equal(reopened.doneAt, undefined, "reopening clears the closed mark");
	assert.equal(reopened.outcome, undefined);
	assert.equal(reopened.goal, prev.goal, "the goal text is never rewritten by the agent");
	assert.deepEqual(reopened.phases, prev.phases, "the laps already worked and their times survive");
	assert.equal(reopened.lap, prev.lap);
	assert.deepEqual(reopened.lapMs, prev.lapMs);
	assert.deepEqual(reopened.cases, ["the pit split is exact"], "the cases may change: they are the agent's proof plan");
	assert.deepEqual(reopened.attempts, prev.attempts, "silently reopening never hands out a fresh round budget");

	const afterHuman = reopenGoal(prev, [], 4_000);
	assert.deepEqual(afterHuman.cases, prev.cases, "no new cases keeps the ones the run already had");
	assert.deepEqual(reopenGoal(prev, [], 3_001).attempts, freshAttempts(), "a human message after the close is new human input, so the budget restarts");
});

test("a verified goal is never reopened silently", () => {
	const verified = closedRun({ outcome: "verified" });
	assert.equal(goalGateFor(verified, "ship the race HUD"), "verified");
	assert.equal(goalGateFor(verified, "ship the race HUD!"), "changed", "another goal is a new decision, not a reopen");
	assert.equal(goalGateFor(closedRun({ outcome: "halted" }), "ship the race HUD"), "reopen", "a halted goal is unfinished work, so the same goal continues it");
});

test("a goal the human already confirmed never opens the dialog, whatever state the run is in", () => {
	for (const doneAt of [undefined, 3_000])
		for (const outcome of [undefined, "verified", "needs-human", "halted"])
			for (const goal of ["ship the race HUD", "  SHIP   the race hud "])
				assert.equal(goalGateAsks(goalGateFor(closedRun({ doneAt, outcome }), goal)), false, `doneAt=${doneAt} outcome=${outcome}: the human's yes still stands`);
	assert.equal(goalGateAsks(goalGateFor(undefined, "ship the race HUD")), true, "a first goal is the human's decision");
	assert.equal(goalGateAsks(goalGateFor(closedRun(), "ship another thing")), true, "and so is a different one");
});

test("a new goal records exactly the cases the human saw, while a resume keeps its own plan", () => {
	const confirmed = ["the lap clock ticks"];
	const stale = ["a case from the goal before this one"];
	assert.deepEqual(casesForGate("fresh", [], confirmed, stale), confirmed, "a confirmed goal never inherits a stale spec case list");
	assert.deepEqual(casesForGate("changed", [], confirmed, stale), confirmed, "nor does one that replaced another goal");
	assert.deepEqual(casesForGate("resume", [], confirmed, ["the run's own case"]), ["the run's own case"], "a resume keeps the cases it already carries");
	assert.deepEqual(casesForGate("reopen", [], confirmed, ["the run's own case"]), ["the run's own case"]);
	assert.deepEqual(casesForGate("resume", ["a sharper case"], confirmed, ["the run's own case"]), ["a sharper case"], "and the agent may sharpen its proof plan without a dialog");
});

test("a command named with a truncated case id still binds to its case, and an ambiguous one does not", () => {
	const cases = ["the lap clock ticks on every lap", "the pit split is exact to the millisecond", "the HUD shows the lap counter", "the HUD shows the pit timer"];
	const claims = caseClaims([
		{ id: "the lap clock ticks…", command: "npm test -- lap" },
		{ id: "THE   PIT split is exact", command: "node check.mjs" },
		{ id: "the HUD shows…", command: "nonsense" },
		{ id: "no such case anywhere", human: true },
		{ id: "the HUD shows the lap counter", human: true, note: "look at the top border" },
	]);
	const bound = bindClaims(cases, claims);
	assert.equal(bound.commands.get(cases[0]), "npm test -- lap", "a truncated id binds when exactly one case starts with it");
	assert.equal(bound.commands.get(cases[1]), "node check.mjs", "whitespace and case differences are not a different case");
	assert.deepEqual([...bound.human.keys()], [cases[2]], "the human check binds to its own case");
	assert.equal(bound.human.get(cases[2]), "look at the top border", "and carries what the human should look at");
	assert.deepEqual(bound.unbound.map((u) => u.id), ["the HUD shows…", "no such case anywhere"], "an id that fits two cases, and an id that fits none, are never guessed");
	assert.deepEqual(bound.unbound.map((u) => u.candidates.length), [2, 0], "it reports how many cases it could have meant instead of picking one");
	assert.equal(bound.bound.size, 3, "only the claims that name exactly one case are bound");
});

test("for every cut of a case, a truncated id binds to a case only when exactly one case starts with that cut", () => {
	const cases = [
		"the lap clock ticks on every lap",
		"the pit split is exact to the millisecond",
		"the HUD shows the lap counter",
	];
	for (const full of cases) {
		const words = full.split(" ");
		for (let n = 2; n < words.length; n++) {
			const cut = words.slice(0, n).join(" ");
			if (cut.length < 8) continue;
			const rivals = cases.filter((c) => c.toLowerCase().startsWith(cut.toLowerCase()));
			const id = `${cut}…`;
			const bound = bindClaims(cases, caseClaims([{ id, command: "true" }]));
			assert.equal(bound.bound.has(id), rivals.length === 1, `"${id}" binds only when one case starts with it (${rivals.length} do)`);
			if (rivals.length === 1) assert.equal(bound.bound.get(id), full, `"${id}" binds to the case it was cut from`);
			else assert.equal(bound.unbound[0]?.candidates.length, rivals.length, "an ambiguous cut reports every case it could have meant");
		}
	}
	const shared = ["the lap clock ticks on every lap", "the lap clock ticks even while a coder is paused"];
	const ambiguous = bindClaims(shared, caseClaims([{ id: "the lap clock ticks…", command: "true" }]));
	assert.equal(ambiguous.commands.size, 0, "a cut that fits two cases proves neither");
	assert.deepEqual(ambiguous.unbound[0].candidates, shared, "and it names both instead of picking one");
	const unknown = bindClaims(cases, caseClaims([{ id: "a case that does not exist…", command: "true" }]));
	assert.equal(unknown.commands.size, 0, "an id no case starts with never binds to a neighbour");
	assert.deepEqual(unknown.unbound[0].candidates, [], "and it is reported as matching nothing, not as a guess");
});

test("an unproven case that only lacked a command becomes a fix lap, not a human hand-off", () => {
	const oneRound = decideOnce(buildReport([unproven("c1")]), freshAttempts());
	assert.equal(oneRound.kind, "replan", "naming no command is a repair the agent can do, so the goal stays open");
	const same = recordEvidence({ rounds: 1 }, buildReport([unproven("c1")]));
	assert.equal(decideOnce(buildReport([unproven("c1")]), same).kind, "replan", "a missing command is a report gap, never a reason to stop: naming none twice is not evidence of failure");
	const bound = decideOnce(buildReport([unproven("c1")]), { rounds: 3 });
	assert.equal(bound.kind, "halt", "the repair is bounded like every other round");

	const step = nextGoalDriverStep({ ...freshGoalRun("ship the race HUD", 1_000, ["c1"]) }, buildReport([unproven("c1")]));
	assert.equal(step.action, "replan");
	assert.equal(step.state.outcome, undefined, "the goal is not closed by a missing command");
	assert.ok(step.state.phases[0].text.startsWith("c1 — "), "the fix lap names the case first, so it can be claimed back verbatim");
});

test("a human check is reported apart and never counted as a failure", async () => {
	const passing = await judgeDeterministic(["c1"], new Map([["c1", "npm test -- lap"]]), [{ command: "npm test -- lap", ok: true }], []);
	const human = await judgeDeterministic(["c2"], new Map(), [], [], undefined, new Map([["c2", "look at the top border"]]));
	assert.equal(human[0].result, "HUMAN");
	const report = buildReport([...passing, ...human]);
	assert.deepEqual(report.humanChecks, ["c2"]);
	assert.deepEqual(report.unverified, [], "a human check is not unproven");
	assert.deepEqual(report.failed, []);
	assert.equal(report.allPass, true, "everything a machine can prove is proven, so the goal is reached");
	assert.equal(decideOnce(report, freshAttempts()).kind, "pass");

	const text = renderVerifyReport(report);
	assert.match(text, /✓ c1 PASS/);
	assert.match(text, /🧑 c2 HUMAN/);
	assert.match(text, /yours to check/, "the human is told what is left for them");
	const step = nextGoalDriverStep(freshGoalRun("ship the race HUD", 1_000, ["c1", "c2"]), report);
	assert.equal(step.action, "finish");
	assert.match(step.text, /c2/, "and the finish report names it again");
});

test("a fix lap appended to a fully closed plan opens its own first lap instead of re-closing a done one", () => {
	const plan = { phases: [{ id: "p-a", text: "a", round: 0, addedAt: 1 }, { id: "p-b", text: "b", round: 0, addedAt: 2 }], lap: 3, lapAt: 3, lapMs: [10, 20] };
	const grown = appendPhases(plan, ["fix it"], 1, 4);
	assert.equal(grown.phases.length, 3);
	assert.equal(grown.lap, 3, "lap 3 is the first added lap, not the already-closed lap 2");
	assert.equal(grown.lapAt, 4, "and its clock starts now");
	assert.deepEqual(grown.lapMs, plan.lapMs, "the time already spent is kept");
});
