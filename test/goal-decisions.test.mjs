import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DECISION_MARKER,
	addDecisions,
	noHumanRule,
	parseDecisions,
	renderDecisions,
	reportWithDecisions,
	withDecisionRule,
	writeDecisionsFile,
	buildGoalToolText,
} from "../extensions/zense-harness/index.ts";

const out = (...lines) => lines.join("\n");

test("a decision a worker declared is captured with its assumption", () => {
	const o = parseDecisions("verifier", out("did some work", `${DECISION_MARKER} should the cache be per-tenant?`, "assumption: yes, keyed by tenant id", "more work"), 42);
	assert.equal(o.length, 1);
	assert.equal(o[0].from, "verifier");
	assert.equal(o[0].question, "should the cache be per-tenant?");
	assert.equal(o[0].assumption, "yes, keyed by tenant id");
	assert.equal(o[0].at, 42);
});

test("several declarations in one run are all captured, and a marker with no question is not", () => {
	const o = parseDecisions("swarm", out(`${DECISION_MARKER} pick a schema`, "assumption: normalize", `${DECISION_MARKER}`, `${DECISION_MARKER} rename the module?`, "assumption: keep the old name"));
	assert.deepEqual(o.map((d) => d.question), ["pick a schema", "rename the module?"]);
	assert.deepEqual(o.map((d) => d.assumption), ["normalize", "keep the old name"]);
});

test("the same question from the same role is stored once, and the cap keeps the newest", () => {
	let items = addDecisions([], [{ at: 1, from: "swarm", question: "which db?", assumption: "postgres" }]);
	items = addDecisions(items, [{ at: 2, from: "swarm", question: "WHICH DB?", assumption: "sqlite" }]);
	assert.equal(items.length, 1, "case-insensitive duplicate");
	const many = Array.from({ length: 100 }, (_, i) => ({ at: i, from: "swarm", question: `q${i}`, assumption: "" }));
	const capped = addDecisions([], many, 40);
	assert.equal(capped.length, 40);
	assert.equal(capped.at(-1).question, "q99", "the newest survive");
});

test("the goal report carries the decisions — that is the only place a human learns them", () => {
	const items = [{ at: 1, from: "swarm", question: "which db?", assumption: "postgres" }];
	const report = renderDecisions(items);
	assert.match(report, /decisions made without asking you/);
	assert.match(report, /\[swarm\] which db\? → postgres/);
	assert.equal(renderDecisions([]), "", "no decisions, no section");
	assert.match(reportWithDecisions("GOAL REACHED", items), /^GOAL REACHED\ndecisions made/);
});

test("the goal tool text keeps its header and swaps in the decision-bearing body", () => {
	const started = { attempts: { rounds: 1 } };
	const step = { text: "raw" };
	const text = buildGoalToolText(started, step, "FINAL");
	assert.match(text, /goal still running/);
	assert.match(text, /FINAL/);
	assert.ok(!text.includes("raw"));
});

test("workers are told never to wait for a human, and the rule is appended to every task", () => {
	assert.match(noHumanRule(), /cannot ask a human/);
	assert.match(noHumanRule(), /DECISION NEEDED/);
	assert.match(noHumanRule(), /Never stop to wait/);
	const prompt = withDecisionRule("do the thing");
	assert.ok(prompt.startsWith("do the thing"));
	assert.match(prompt, /DECISION NEEDED/);
});

test("the decisions file is written once per goal and is readable afterwards", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-dec-"));
	try {
		assert.equal(writeDecisionsFile(cwd, "goal", []), undefined, "nothing to write when nothing was decided");
		const p = writeDecisionsFile(cwd, "make it fast", [{ at: Date.now(), from: "swarm", question: "cache?", assumption: "yes" }]);
		assert.ok(p);
		const body = readFileSync(p, "utf8");
		assert.match(body, /decisions — make it fast/);
		assert.match(body, /\[swarm\] cache\? → yes/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("there is no rollback baseline any more — undo is something the human asks the agent for", async () => {
	const { readFileSync } = await import("node:fs");
	const indexSrc = readFileSync(new URL("../extensions/zense-harness/index.ts", import.meta.url), "utf8");
	assert.ok(!indexSrc.includes("baselineHead ="), "goal confirmation no longer records a commit to roll back to");
	const types = readFileSync(new URL("../extensions/zense-harness/src/types.ts", import.meta.url), "utf8");
	assert.equal(/\tbaselineHead\?:/.test(types), false, "and the state no longer carries it");
});
