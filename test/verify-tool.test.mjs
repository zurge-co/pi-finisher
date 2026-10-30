import { stateFile } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLine, clearCheckCache, detectChecks, failingChecks, judgeDeterministic, readChecks, readJournal, runCheck, runChecks, runCommand, stateLabel, verifySummaryLines, bindClaims, buildReport, caseClaims } from "../extensions/finisher/index.ts";

const repo = (scripts) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-checks-"));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "check", scripts }));
	return dir;
};

test("a failing deterministic check is quoted, never guessed: the real exit code and output come back", async () => {
	const dir = repo({ typecheck: "node -e \"console.error('boom: 3 errors'); process.exit(2)\"" });
	const [result] = await runChecks(detectChecks({ scripts: { typecheck: "x" } }), dir, 30_000);
	assert.equal(result.exitCode, 2, "the real exit code, not a boolean");
	assert.match(result.tail, /boom: 3 errors/, "the output is kept so the fix can be aimed");
	assert.match(checkLine(result), /exit 2/);
	assert.deepEqual(failingChecks([result]).map((r) => r.name), ["typecheck"]);
});

test("a passing check is a pass, and a check that never ran is not a check", async () => {
	const dir = repo({ test: "node -e \"process.exit(0)\"" });
	const [ok] = await runChecks(detectChecks({ scripts: { test: "x" } }), dir, 30_000);
	assert.equal(ok.exitCode, 0);
	assert.deepEqual(failingChecks([ok]), []);
	assert.deepEqual(detectChecks({ scripts: { build: "tsc" } }), [], "a script that is not a check is never run");
});

test("a check that hangs is cut by its deadline instead of holding the tool forever", async () => {
	const dir = repo({});
	const started = Date.now();
	const result = await runCheck({ name: "test", command: "node", args: ["-e", "setTimeout(() => {}, 60000)"] }, dir, 1_000);
	assert.notEqual(result.exitCode, 0, "a killed check is a failure, not a pass");
	assert.ok(Date.now() - started < 30_000, "the deadline ends it");
});

test("a broken check must fail every case even when the commands were recorded: a repo that does not pass its own checks cannot satisfy a case", async () => {
	const cases = ["c1", "c2"];
	const calls = [{ command: "node check.mjs", ok: true }];
	const commands = new Map([["c1", "node check.mjs"], ["c2", "node other.mjs"]]);
	const green = await judgeDeterministic(cases, commands, calls, [{ name: "test", command: "npm run --silent test", exitCode: 0, tail: "" }]);
	assert.deepEqual(green.map((c) => c.result), ["PASS", "UNVERIFIED"], "with the checks green the recording decides each case on its own command");
	const red = await judgeDeterministic(cases, commands, calls, [{ name: "test", command: "npm run --silent test", exitCode: 1, tail: "1 failing" }]);
	assert.deepEqual(red.map((c) => c.result), ["FAIL", "FAIL"], "a failing check fails every case, whatever the recording says");
	assert.match(red[0].reason ?? "", /exited 1/);
	assert.equal(buildReport(red).allPass, false);
});

test("a case is never proven by a command it did not name, and an unnamed case stays unverified", async () => {
	const evidence = await judgeDeterministic(["c1", "c2"], new Map([["c1", "node a.mjs"]]), [{ command: "node a.mjs", ok: true }], []);
	assert.deepEqual(evidence.map((c) => [c.caseId, c.result]), [["c1", "PASS"], ["c2", "UNVERIFIED"]]);
	assert.match(evidence[1].reason ?? "", /no command was named/);
});

test("the case claims are read defensively: junk ids and empty claims are dropped instead of proving something", () => {
	assert.deepEqual(caseClaims(undefined), []);
	assert.deepEqual(caseClaims([{ id: "", command: "x" }, { id: "c1", command: "" }, { case: "c2", command: " npm test " }]), [{ id: "c2", human: false, command: "npm test" }]);
	const twice = bindClaims(["c1"], caseClaims([{ id: "c1", command: "a" }, { id: "c1", command: "b" }]));
	assert.equal(twice.commands.get("c1"), "b", "the last named command wins");
});

test("the summary says what the deterministic stage did and what each case came to", () => {
	const report = buildReport([{ caseId: "c1", result: "PASS", commands: [] }, { caseId: "c2", result: "UNVERIFIED", commands: [], reason: "no recording" }]);
	const text = verifySummaryLines([{ name: "typecheck", command: "npm run --silent typecheck", exitCode: 0, tail: "" }, { name: "test", command: "npm run --silent test", exitCode: 1, tail: "boom" }], report).join("\n");
	assert.match(text, /typecheck ok/);
	assert.match(text, /test FAILED \(1\)/);
	assert.match(text, /exit 1/);
	assert.match(text, /✓ c1 PASS/);
	assert.match(text, /c2 UNVERIFIED/);
	const empty = verifySummaryLines([], report).join("\n");
	assert.match(empty, /no typecheck\/lint\/test script/, "a repo with no checks says so instead of pretending it verified");
});

const { registerTools, createStateBox } = await import("../extensions/finisher/index.ts").then(async (m) => ({ registerTools: (await import("../extensions/finisher/src/tools.ts")).registerTools, createStateBox: m.createStateBox }));

const session = (opts = {}) => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const rounds = [];
	const asked = [];
	registerTools({
		pi: { registerTool: (d) => defs.push(d) },
		get state() {
			return box.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "coders ran" }], details: {} }),
		armGoalRound: (text) => rounds.push(text),
		askGoalConfirm: async (_c, goal) => (asked.push(goal), "confirmed"),
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const ctx = { cwd: opts.cwd ?? repo({}), hasUI: true, mode: "tui", model: { provider: "p", id: "m" }, ui: { notify: () => {} } };
	const run = (name, params) => defs.find((d) => d.name === name).execute("1", params, undefined, undefined, ctx);
	return { box, rounds, asked, run, ctx };
};

test("the goal loop survives on main alone: a failing verify re-arms the round, and a proven one finishes the goal", async () => {
	const s = session({ cwd: repo({ test: "node -e \"process.exit(process.env.CHECK ? 0 : 1)\"" }) });
	await s.run("goal", { goal: "ship it", cases: ["the check passes"] });
	assert.equal(s.box.get().goalDriver.goal, "ship it");
	await s.run("lap", { plan: ["make the check pass"] });

	const blocked = await s.run("verify", { cases: [{ id: "the check passes", command: "npm test" }] });
	assert.equal(blocked.isError, true, "an open lap blocks verification, so a stale verify can never pass a goal early");
	assert.deepEqual(s.rounds, [], "and it does not arm a round either");

	await s.run("lap", { done: true });
	const failing = await s.run("verify", { cases: [{ id: "the check passes", command: "npm test" }] });
	assert.equal(failing.isError, true, "the deterministic check really failed in a real repo");
	assert.equal(existsSync(stateFile(s.ctx.cwd, "report.md")), false, "a goal that is still open leaves no report behind");
	assert.equal(s.rounds.length, 1, "a failing verify hands the round back to main — the loop is alive");
	assert.match(failing.content[0].text, /LAP/i, "and it tells main which lap to work next");
	assert.ok((s.box.get().goalDriver.phases ?? []).length >= 2, "a fix lap was appended to the plan");

	process.env.CHECK = "1";
	try {
		for (let i = 0; i < 8 && !(s.box.get().goalDriver.phases ?? []).every((p) => p) === false; i++) {
			const before = s.box.get().goalDriver.lap ?? 0;
			await s.run("lap", { done: true });
			if ((s.box.get().goalDriver.lap ?? 0) === before) break;
		}
		s.box.get().verifyCalls = [{ command: "npm test", ok: true }];
		const passing = await s.run("verify", { cases: [{ id: "the check passes", command: "npm test" }] });
		const driver = s.box.get().goalDriver;
		assert.ok(driver.doneAt, "with the check green and the command recorded, the goal finishes — the loop is not dead");
		assert.equal(driver.outcome, "verified");
		assert.equal(passing.isError, undefined);
		const written = readFileSync(stateFile(s.ctx.cwd, "report.md"), "utf8");
		assert.match(written, /^# finisher report — verified/, "closing the goal writes the report the HUD offers to open");
		assert.match(written, /the check passes/, "and it carries the case the run was proven against");
		assert.equal(s.box.get().lastReport.outcome, "verified", "the state keeps the meta the HUD reads");
		assert.equal(s.box.get().lastReport.path, stateFile(s.ctx.cwd, "report.md"));
	} finally {
		delete process.env.CHECK;
	}
});

test("a case with no named command stays UNVERIFIED even on a green suite — a green suite is not proof of a case", async () => {
	const s = session({ cwd: repo({ test: "node -e \"process.exit(0)\"" }) });
	await s.run("goal", { goal: "ship it", cases: ["the check passes"] });
	await s.run("lap", { plan: ["make it pass"] });
	await s.run("lap", { done: true });
	const out = await s.run("verify", { cases: [] });
	assert.equal(out.isError, true);
	assert.match(out.content[0].text, /UNVERIFIED/);
	assert.match(out.content[0].text, /no command was named/);
	assert.notEqual(s.box.get().goalDriver.outcome, "verified", "an unproven case can never be recorded as a verified goal");
	assert.equal(s.box.get().goalDriver.outcome, undefined, "an unproven case is a repair lap, not the end of the goal — the goal is never closed and never re-confirmed for it");
	assert.equal(s.box.get().goalDriver.phases.length, 2, "the closed plan gains exactly one fix lap — the goal is not closed and not re-confirmed for it");
	assert.match(s.box.get().goalDriver.phases[1].text, /the check passes/, "and that lap names the case in the human's own words");
	assert.ok(s.box.get().goalDriver.phases[1].text.startsWith("the check passes"), "the lap leads with the case text the report will name, so it binds back");

	await s.run("lap", { done: true });
	const again = await s.run("verify", { cases: [] });
	assert.equal(again.isError, true);
	assert.match(again.content[0].text, /no command was named/);
	assert.equal(s.box.get().goalDriver.outcome, undefined, "the same gap twice is still a fix lap, never a halt: naming nothing changes nothing, but the round budget is what ends it");
	assert.equal(s.box.get().goalDriver.phases.length, 3, "the second gap buys a second fix lap, aimed at the same case");
	assert.ok(s.box.get().goalDriver.phases[2].text.startsWith("the check passes"), "and it names that case the same way the first one did");
});

test("a named command the harness has not recorded yet is RUN by the harness — the exit code is the evidence, never a claim", async () => {
	const cases = ["the file exists"];
	const commands = new Map([["the file exists", "node -e \"process.exit(0)\""]]);
	const ran = [];
	const pass = await judgeDeterministic(cases, commands, [], [], async (command) => {
		ran.push(command);
		return { name: command, command, exitCode: 0, tail: "" };
	});
	assert.deepEqual(ran, ["node -e \"process.exit(0)\""], "the harness ran exactly the command the case named");
	assert.equal(pass[0].result, "PASS");
	const failed = await judgeDeterministic(cases, commands, [], [], async (command) => {
		ran.push(command);
		return { name: command, command, exitCode: 3, tail: "boom" };
	});
	assert.equal(failed[0].result, "FAIL", "a command that exits non-zero fails the case");
	assert.match(failed[0].reason ?? "", /exited 3/);
});

test("a recorded command outranks running it again: the recording decides, and a contradiction is still a FAIL", async () => {
	let ran = 0;
	const commands = new Map([["c1", "npm test"]]);
	const fromRecording = await judgeDeterministic(["c1"], commands, [{ command: "npm test", ok: false }], [], async () => {
		ran += 1;
		return { name: "x", command: "npm test", exitCode: 0, tail: "" };
	});
	assert.equal(ran, 0, "the harness already watched it fail, so it is not re-run and re-judged");
	assert.equal(fromRecording[0].result, "FAIL");
	const ok = await judgeDeterministic(["c1"], commands, [{ command: "npm test", ok: true }], []);
	assert.equal(ok[0].result, "PASS");
});

test("a check that hangs is cut when the harness runs a case command, so verify can never hang on a case", async () => {
	const dir = repo({});
	const started = Date.now();
	const result = await runCommand("sleep 30", dir, 1_000);
	assert.notEqual(result.exitCode, 0);
	assert.ok(Date.now() - started < 20_000, "the deadline ends it");
	assert.equal((await runCommand("exit 0", dir, 5_000)).exitCode, 0, "a command that succeeds is a pass");
	assert.equal((await runCommand("exit 7", dir, 5_000)).exitCode, 7, "and a command's own status is what is reported");
});

test("a claim can name a case by position, by a cut id, or past a lead verb — and an ambiguous one still proves nothing", () => {
	const cases = ["verify-tool writes report.md once", "the journal records real models", "GC prunes a gone project dir"];
	const bound = (id) => bindClaims(cases, [{ id, command: "true", human: false }]);
	assert.equal(bound("C1").commands.get(cases[0]), "true", "C1 names the first case");
	assert.equal(bound("case 2").commands.get(cases[1]), "true", "'case 2' names the second case");
	assert.equal(bound("#3").commands.get(cases[2]), "true", "'#3' names the third case");
	assert.deepEqual(bound("C9").unbound.map((u) => u.candidates), [[]], "a position past the end matches nothing instead of guessing");
	assert.equal(bound("the journal records real…").commands.get(cases[1]), "true", "a truncated id still binds when it fits exactly one case");
	assert.equal(bound("แก้ the journal records real models").commands.get(cases[1]), "true", "a Thai lead verb is stripped before matching");
	assert.equal(bindClaims(["C2", "a real case"], [{ id: "C2", command: "true", human: false }]).commands.get("C2"), "true", "an exact text still outranks a position");
	const shared = ["the lap clock ticks", "the lap clock tocks"];
	assert.deepEqual(bindClaims(shared, [{ id: "the lap clock", command: "true", human: false }]).unbound[0].candidates, shared, "an ambiguous fragment still names both and proves nothing");
});

test("the report file carries the verdict exactly once and none of the words aimed at the agent", async () => {
	const s = session({ cwd: repo({ test: "node -e \"process.exit(0)\"" }) });
	await s.run("goal", { goal: "report stays clean", cases: ["the check passes"] });
	await s.run("lap", { plan: ["make it pass"] });
	await s.run("lap", { done: true });
	s.box.get().verifyCalls = [{ command: "npm test", ok: true, at: Date.now() }];
	const out = await s.run("verify", { cases: [{ id: "the check passes", command: "npm test" }] });
	assert.equal(out.isError, undefined);
	const written = readFileSync(stateFile(s.ctx.cwd, "report.md"), "utf8");
	assert.equal(written.split("✅ verified").length - 1, 1, "the verdict line is written once, not once per render path");
	assert.equal(written.split("the check passes").length - 1, 1, "and the case is listed once, not again per summary section");
	assert.doesNotMatch(written, /report this once|report exactly this|goal reached|fix lap|do not keep spinning/, "no agent-only directive leaks into the file the human reads");
	assert.match(written, /deterministic stage: test ok/, "the stage outcome stays in the report");
});

test("the journal's gap record names the models that actually ran, and stays silent when none did", async () => {
	const used = session({ cwd: repo({}) });
	await used.run("goal", { goal: "journal names used models", cases: ["proof lives here"] });
	await used.run("lap", { plan: ["do it"] });
	await used.run("lap", { done: true });
	used.box.get().subagentRuns = [
		{ role: "coder", ok: true, summary: "", at: 1, model: "p/m" },
		{ role: "coder", ok: true, summary: "", at: 2, model: "p/m" },
		{ role: "coder", ok: true, summary: "", at: 3 },
	];
	await used.run("verify", { cases: [] });
	const named = readJournal().filter((r) => r.goal === "journal names used models");
	assert.ok(named.length >= 1, "the replan wrote a gap record");
	assert.deepEqual(named.at(-1).models, ["p/m"], "the models that ran are named once each, and a run without a model adds nothing");

	const quiet = session({ cwd: repo({}) });
	await quiet.run("goal", { goal: "journal stays quiet" , cases: ["proof lives here"] });
	await quiet.run("lap", { plan: ["do it"] });
	await quiet.run("lap", { done: true });
	await quiet.run("verify", { cases: [] });
	const silent = readJournal().filter((r) => r.goal === "journal stays quiet");
	assert.ok(silent.length >= 1, "the second replan also wrote a gap record");
	assert.equal("models" in silent.at(-1), false, "with no recorded run models the key is absent, not an empty list");
});

test("verify runs the repo's checks through the plan and writes its evidence to the state home", async () => {
	const dir = repo({ test: `node -e "require('node:fs').appendFileSync('runs.log','x')"` });
	const s = session({ cwd: dir });
	clearCheckCache();
	await s.run("goal", { goal: "ship it", cases: ["the suite passes"] });
	await s.run("lap", { plan: ["make it pass"] });
	await s.run("lap", { done: true });
	s.box.get().verifyCalls = [{ command: "node check.mjs", ok: true, at: Date.now() }];
	const runs = () => (existsSync(join(dir, "runs.log")) ? readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n").length : 0);
	const first = await s.run("verify", { cases: [{ id: "the suite passes", command: "node check.mjs" }] });
	assert.equal(first.isError, undefined, "the recorded command plus the green check close the goal");
	assert.equal(runs(), 1, "the check stage really ran the repo's own test script");
	assert.deepEqual(readChecks(dir).map((e) => [e.case, e.status]), [["the suite passes", "pass"]], "one line per case, and a pass only for a pass");
	assert.ok(first.content[0].text.includes(`evidence: ${stateLabel(dir, "checks", "checks.jsonl")}`), "the evidence line names the check file in the state home, not a workspace dir");
	await s.run("verify", { cases: [] });
	assert.equal(runs(), 1, "a second pass over the same edit state is answered from the plan cache — the suite is not re-run");
});
