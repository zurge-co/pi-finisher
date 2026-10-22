import { strict as assert } from "node:assert";
import test from "node:test";
import {
	buildCompactProbeSection,
	buildEvalResultText,
	buildReviewResultText,
	COMMENT_DISCIPLINE_GUIDELINE,
	buildReviewModalText,
} from "../extensions/zense-harness/index.ts";

test("buildCompactProbeSection: detail only for non-pass probes; passes collapse to one line", () => {
	const section = buildCompactProbeSection([
		{ id: "c1", status: "pass", detail: "ok" },
		{ id: "c2", status: "fail", exitCode: 1, detail: "npm test exploded\nstack line 2" },
		{ id: "c3", status: "skipped", detail: "not machine-runnable" },
		{ id: "c4", status: "pass", detail: "ok too" },
	]);
	assert.match(section, /## Probes/);
	assert.match(section, /- c2: fail \(exit 1\) — npm test exploded/);
	assert.match(section, /- c3: skipped — not machine-runnable/);
	assert.match(section, /probes pass: c1,c4/); 	assert.ok(!section.includes("stack line 2"), "detail must be cut to one line");
	assert.ok(!section.includes("- c1:"), "a passing probe gets no detail line of its own");
});

test("buildEvalResultText PASS: verdict + per-criterion verdicts + zense_review directive + log hint", () => {
	const text = buildEvalResultText({
		verdict: "PASS",
		criteria: [
			{ id: "C1", text: "tests pass", check: "npm test" },
			{ id: "C2", text: "file exists", check: "path exists: src/x.ts" },
		],
		perCriteria: { C1: "PASS", C2: "PASS" },
		evidence: { C1: "npm test exit 0", C2: "file found" },
		failedIds: [],
		probeOverrides: [],
		probes: [
			{ id: "C1", status: "pass", detail: "ok" },
			{ id: "C2", status: "pass", detail: "ok" },
		],
		trajectory: ["out-of-scope write: x"],
		specDebt: ["manual QA"],
		logPath: ".zense/subagents/t-grader.log",
	});
	assert.match(text, /✅ Eval PASS/);
	assert.match(text, /zense_review/, "the PASS directive must order zense_review immediately (the agent once silently considered itself done)");
	assert.match(text, /- C1: PASS — npm test exit 0/);
	assert.match(text, /- C2: PASS — file found/);
	assert.match(text, /probes pass: C1,C2/);
	assert.match(text, /out-of-scope write/);
	assert.match(text, /manual QA/);
	assert.match(text, /\.zense\/subagents\/t-grader\.log/);
	assert.match(text, /read it yourself/, "must point the agent at the log to read itself");
});

test("buildEvalResultText FAIL: failing criteria only + evidence capped at 120 chars + no lines for passing ones", () => {
	const longEvidence = "x".repeat(200);
	const text = buildEvalResultText({
		verdict: "FAIL",
		criteria: [
			{ id: "C1", text: "a", check: "npm test" },
			{ id: "C2", text: "b", check: "npm run build" },
		],
		perCriteria: { C1: "PASS", C2: "FAIL" },
		evidence: { C1: "passed fine", C2: `${longEvidence}\nsecond line` },
		failedIds: ["C2"],
		probeOverrides: ["C2"],
		probes: [
			{ id: "C1", status: "pass", detail: "ok" },
			{ id: "C2", status: "fail", exitCode: 2, detail: "build broke" },
		],
		trajectory: [],
		specDebt: [],
		logPath: ".zense/subagents/t-grader.log",
	});
	assert.match(text, /❌ Eval FAIL/);
	assert.match(text, /failing criteria: C2/);
	assert.match(text, /probe override → FAIL \[C2\]/);
	assert.match(text, /- C2: FAIL — /);
	assert.ok(!text.includes("- C1: PASS"), "the FAIL branch must cut passing per-criteria lines");
	const c2Line = text.split("\n").find((l) => l.startsWith("- C2:"));
	assert.ok(c2Line.length <= 121 + "- C2: FAIL — ".length, `evidence must be cut to ~120 chars (got ${c2Line.length})`);
	assert.ok(!text.includes("second line"), "evidence must stay one line");
	assert.match(text, /probes pass: C1/);
	assert.match(text, /build broke/);
	assert.ok(text.length < 2_500, `the FAIL text must be significantly shorter than the old raw dump (got ${text.length} chars)`);
});

test("buildReviewResultText: TL;DR + counts + log hint; the failure branch carries the error tail and the log", () => {
	const okText = buildReviewResultText({ ok: true, tlDr: "all good", trajectoryCount: 2, escalationCount: 1, logPath: ".zense/subagents/t-reviewer.log" });
	assert.match(okText, /all good/);
	assert.match(okText, /trajectory flags: 2 · escalations: 1/);
	assert.match(okText, /t-reviewer\.log/);
	assert.ok(okText.length < 900, "the compact result must be shorter than the old packet slice(0,4000)");
	const withCross = buildReviewResultText({ ok: true, tlDr: "all good", trajectoryCount: 0, escalationCount: 0, logPath: "x.log", crossCheck: [{ goal: "A when B", evidence: "added f in src/a.ts" }] });
	assert.match(withCross, /## Cross-check — your case → what was done/);
	assert.match(withCross, /- A when B\n  → added f in src\/a\.ts/);
	const errText = buildReviewResultText({ ok: false, tlDr: "", trajectoryCount: 0, escalationCount: 0, logPath: ".zense/subagents/t-reviewer.log", errorOutput: "exited code=1" });
	assert.match(errText, /reviewer failed: exited code=1/);
	assert.match(errText, /t-reviewer\.log/);
});

test("COMMENT_DISCIPLINE_GUIDELINE: covers all 5 mandatory rules and stays short", () => {
	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /non-obvious/); 	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /WHAT a line does/i); 	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /banner/i); 	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /JSDoc/i); 	assert.match(COMMENT_DISCIPLINE_GUIDELINE, /existing decision-recording comments/i); 	const lines = COMMENT_DISCIPLINE_GUIDELINE.split("\n");
	assert.ok(lines.length <= 10, `the guideline must stay ~8 lines (got ${lines.length})`);
});

test("buildReviewModalText: cross-check cases render goal → what was done; an unmapped case is flagged, never dropped", () => {
	const md = buildReviewModalText({
		tlDr: "done",
		crossCheck: [
			{ goal: "You want A to show B when C", evidence: "added renderB in src/a.ts" },
			{ goal: "When 1 happens, 2 disappears", evidence: "" },
		],
		trajectory: [],
		specDebt: [],
		escalations: [],
		canAccept: true,
	});
	assert.match(md, /## Cross-check — your case → what was done/);
	assert.match(md, /\*\*You want A to show B when C\*\*/);
	assert.match(md, /→ added renderB in src\/a\.ts/);
	assert.match(md, /When 1 happens, 2 disappears/);
	assert.match(md, /⚠ not mapped by the reviewer/);
});

test("buildReviewModalText: TL;DR + flags/debt/escalations render; y accept hint only when something is staged", () => {
	const md = buildReviewModalText({
		tlDr: "the login fix landed cleanly",
		trajectory: ["reviewer hallucination: x.ts"],
		specDebt: ["verify UX by eye"],
		escalations: [{ kind: "need-decision", detail: "pick a branch" }],
		paths: ["src/auth/guard.ts", "test/auth.test.mjs"],
		logPath: ".zense/subagents/x.log",
		canAccept: true,
	});
	assert.match(md, /## Review — TL;DR/);
	assert.match(md, /the login fix landed cleanly/);
	assert.match(md, /reviewer hallucination: x\.ts/);
	assert.match(md, /verify UX by eye/);
	assert.match(md, /need-decision: pick a branch/);
	assert.match(md, /2 file\(s\)/, "staged paths are listed");
	assert.match(md, /\*\*\[y\] accept\*\*/, "y = accept when canAccept");
	assert.match(md, /\*\*\[n\] close\*\*/, "n = close only — always offered");
});

test("buildReviewModalText: nothing staged → the accept hotkey is withheld, not shown disabled", () => {
	const md = buildReviewModalText({ tlDr: "ok", trajectory: [], specDebt: [], escalations: [], canAccept: false });
	assert.ok(!md.includes("[y] accept"), "y must not read as an option when nothing can be accepted");
	assert.match(md, /nothing is staged in main/);
	assert.match(md, /\[n\] close/);
});

test("the eval/review graders staying on disk are still wired as read-only judging roles", async () => {
	const { SUBAGENT_EXCLUDE_TOOLS, buildGraderPrompt, parseGraderOutput } = await import("../extensions/zense-harness/index.ts");
	assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS.grader, ["write", "edit"], "the grader role may judge but never fix");
	const prompt = buildGraderPrompt({ intent: "x", scope: [], criteria: [{ id: "c1", text: "holds", check: "npm test" }], specDebt: [] }, [], [], "");
	assert.match(prompt, /c1/);
	const parsed = parseGraderOutput("c1: PASS: npm test exited 0\nOVERALL: PASS", [{ id: "c1", text: "holds", check: "npm test" }]);
	assert.equal(parsed.overall, "PASS");
	assert.equal(parsed.perCriteria.c1, "PASS");
});
