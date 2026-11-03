import { stateFile, writeState } from "./helpers/finisher-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	blockingGaps,
	createStateBox,
	parseReview,
	peerGapText,
	peerModel,
	peerReviewEnabled,
	runPeerReview,
	writeLadderSlot,
} from "../extensions/finisher/index.ts";
import { registerTools } from "../extensions/finisher/src/tools.ts";

const repo = ({ files = [], ladder } = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-peer-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "peer", scripts: {} }));
	for (const rel of files) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), "x");
	}
	if (ladder) ladder.forEach((pattern, at) => writeLadderSlot(dir, `priority${at + 1}`, pattern));
	return dir;
};

test("the reviewer is a different model from main, picked from the ladder and skipped when there is no second rung", () => {
	assert.equal(peerModel(repo({ ladder: ["p/main", "p/peer"] }), "p/main"), "p/peer");
	assert.equal(peerModel(repo({ ladder: ["p/main:high", "p/peer:low"] }), "p/main"), "p/peer:low", "a thinking suffix is the same model, and the rung's own suffix is kept");
	assert.equal(peerModel(repo({ ladder: ["p/one", "p/two"] }), "p/two"), "p/one", "the first rung that is not main wins");
	assert.equal(peerModel(repo({ ladder: ["p/main"] }), "p/main"), undefined, "the same model is never called a second opinion");
	assert.equal(peerModel(repo({}), "p/main"), undefined, "no ladder means no peer");
});

test("peer review is on by default and can be switched off without touching the ladder", () => {
	const dir = repo({ ladder: ["p/main", "p/peer"] });
	assert.equal(peerReviewEnabled(dir), true);
	writeState(dir, "config.json", JSON.stringify({ peerReview: false }));
	assert.equal(peerReviewEnabled(dir), false);
	writeState(dir, "config.json", "{ broken");
	assert.equal(peerReviewEnabled(dir), true, "a broken config never disables a safety read silently");
});

test("a review is parsed strictly: only a concrete finding in a named case can block", () => {
	const refs = ["the parser handles empty input", "the HUD shows the lap number"];
	const ok = parseReview("thinking...\nREVIEW: OK\n", refs);
	assert.deepEqual(ok, { verdict: "ok", gaps: [] });
	const gaps = parseReview("REVIEW: GAPS\nGAP: C1 | src/parser.ts:12 returns early, so empty input never reaches the parser\nGAP: 2 | this feels risky\n", refs);
	assert.equal(gaps.verdict, "gaps");
	assert.equal(gaps.gaps.length, 2);
	assert.deepEqual(gaps.gaps.map((g) => g.index), [0, 1], "C1 and a bare 2 both bind by position");
	assert.deepEqual(blockingGaps(gaps).map((g) => g.ref), ["C1"], "a vague finding is not allowed to block the plan");
	const text = parseReview("REVIEW: GAPS\nGAP: the HUD shows the lap number | src/hud.ts:40 draws no lap number\n", refs);
	assert.equal(text.gaps[0].index, 1, "a case named by its exact text binds too");
	assert.match(peerGapText(gaps, "cases"), /src\/parser\.ts:12/);
	assert.doesNotMatch(peerGapText(gaps, "cases"), /feels risky/, "only the concrete finding is handed back as a block");
});

test("an answer that is not in the review format never blocks anything", () => {
	const refs = ["one"];
	assert.equal(parseReview("looks fine to me", refs).verdict, "unavailable");
	assert.equal(parseReview("REVIEW: GAPS", refs).verdict, "unavailable", "GAPS with no named gap is not evidence");
	assert.equal(parseReview("REVIEW: GAPS\nGAP: C1 | \n", refs).verdict, "unavailable", "an empty note is not a finding");
	assert.equal(parseReview("REVIEW: OK\nREVIEW: GAPS\nGAP: C1 | a.ts:1 contradicts it", refs).verdict, "gaps", "the last verdict is the reviewer's answer");
	assert.deepEqual(parseReview("the shape you asked for:\nGAP: C2 | src/foo.ts:12 example\nREVIEW: OK", refs), { verdict: "ok", gaps: [] }, "a format example echoed before the verdict is not a finding");
});

test("runPeerReview degrades to unavailable when there is no peer, no runner, or the reviewer fails", async () => {
	const dir = repo({ ladder: ["p/main"] });
	const ctx = { cwd: dir, model: { provider: "p", id: "main" }, ui: { notify: () => {} } };
	assert.equal((await runPeerReview({ ctx, cwd: dir, goal: "g", refs: ["c"], kind: "cases", mainModel: "p/main" })).verdict, "unavailable");
	const two = repo({ ladder: ["p/main", "p/peer"] });
	const failed = await runPeerReview({ ctx: { ...ctx, cwd: two }, cwd: two, goal: "g", refs: ["c"], kind: "cases", mainModel: "p/main", launch: async () => ({ ok: false, output: "", logPath: "/tmp/x.log" }) });
	assert.equal(failed.verdict, "unavailable", "a reviewer that did not run never blocks the goal");
});

const session = (cwd, reply) => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const asked = [];
	const calls = [];
	registerTools({
		pi: { registerTool: (def) => defs.push(def) },
		get state() {
			return box.get();
		},
		persist: () => {},
		updateWidget: () => {},
		runCodeSwarm: async () => ({ content: [{ type: "text", text: "coders ran" }], details: {} }),
		armGoalRound: () => {},
		askGoalConfirm: async (_ctx, goal) => (asked.push(goal), "confirmed"),
		launchSubagent: async (_ctx, role, task, _onChunk, _signal, model) => {
			calls.push({ role, task, model });
			return { ok: true, output: typeof reply === "function" ? reply(task) : reply, logPath: `/tmp/${role}.log`, calls: [] };
		},
	});
	const ctx = { cwd, hasUI: true, mode: "tui", model: { provider: "p", id: "main" }, ui: { notify: () => {} }, sessionManager: { getEntries: () => [], getSessionId: () => "sess-peer" } };
	const run = (name, params) => defs.find((def) => def.name === name).execute("1", params, undefined, undefined, ctx);
	return { box, asked, calls, run };
};

const gap = (file, line) => `REVIEW: GAPS\nGAP: C1 | ${file}:${line} contradicts the case as written`;

test("goal asks a second model to ground the cases, and a concrete contradiction stops it before the human is asked", async () => {
	const s = session(repo({ ladder: ["p/main", "p/peer"], files: ["src/a.ts"] }), gap("src/parser.ts", 12));
	const refused = await s.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /src\/parser\.ts:12/);
	assert.equal(s.asked.length, 0, "the human never sees a case a second model could not ground");
	assert.equal(s.calls.length, 1);
	assert.equal(s.calls[0].role, "reviewer");
	assert.equal(s.calls[0].model, "p/peer");
	assert.match(s.calls[0].task, /C1: the parser handles empty input/, "the reviewer sees the numbered cases, not a summary");
});

test("a review that finds nothing lets the goal reach the human, and no second model means no review at all", async () => {
	const ok = session(repo({ ladder: ["p/main", "p/peer"] }), "REVIEW: OK");
	const accepted = await ok.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	assert.equal(accepted.isError, undefined);
	assert.equal(ok.asked.length, 1);
	assert.equal(ok.calls[0].role, "reviewer");

	const alone = session(repo({ ladder: ["p/main"] }), gap("src/parser.ts", 12));
	const solo = await alone.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	assert.equal(solo.isError, undefined, "one model alone is not a peer review");
	assert.equal(alone.calls.length, 0, "the harness never calls the main model twice and calls it a review");
	assert.equal(alone.asked.length, 1);
});

test("lap sends the declared plan to the second model, and a concrete contradiction keeps it out of the goal", async () => {
	const dir = repo({ ladder: ["p/main", "p/peer"], files: ["src/parser.ts"] });
	const s = session(dir, (task) => (task.includes("plan:") ? gap("src/parser.ts", 3) : "REVIEW: OK"));
	await s.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	s.calls.length = 0;
	const refused = await s.run("lap", { plan: ["split `src/parser.ts` into two modules"] });
	assert.equal(refused.isError, true);
	assert.equal(s.box.get().goalDriver.phases.length, 0, "an ungrounded plan is not stored");
	assert.equal(s.calls[0].role, "reviewer");
	assert.match(s.calls[0].task, /plan:/, "the reviewer is asked about the plan, not the cases");

	const ok = session(dir, "REVIEW: OK");
	await ok.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	const declared = await ok.run("lap", { plan: ["split `src/parser.ts` into two modules"] });
	assert.equal(declared.isError, undefined);
	assert.equal(ok.box.get().goalDriver.phases.length, 1);
});

test("a config switch turns the peer gate off without changing anything else", async () => {
	const dir = repo({ ladder: ["p/main", "p/peer"] });
	writeState(dir, "config.json", JSON.stringify({ peerReview: false }));
	const s = session(dir, gap("src/parser.ts", 12));
	const out = await s.run("goal", { goal: "ship it", cases: ["the parser handles empty input"] });
	assert.equal(out.isError, undefined);
	assert.equal(s.calls.length, 0);
	assert.equal(s.asked.length, 1);
});
