import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	normalizeShellCommand,
	applyQualityGate,
	buildGraderPrompt,
	buildRequirementsPrompt,
	buildReviewerPrompt,
	gatherRepoFacts,
	gitChangeSummary,
	gitChangedSymbols,
	gitDiffExcerpt,
	parseCrossCheckItems,
	mergeCrossCheck,
	hasUnsubstitutedPlaceholder,
	loadSpecExemplar,
	modelMatchesPattern,
	parseGraderOutput,
	parseReviewerPacket,
	runCheckProbes,
	lintSpecChecks,
	CHECK_FORMAT_CONTRACT,
	SUBAGENT_EXCLUDE_TOOLS,
	SUBAGENT_STRIP_FLAGS,
	buildCompactProbeSection,
	buildEvalResultText,
	buildPendingApplyEvidencePrefix,
	buildReviewResultText,
	buildReviewModalText,
	COMMENT_DISCIPLINE_GUIDELINE,
} from "../extensions/zense-harness/index.ts";

const CRITERIA = [
	{ id: "C1", text: "tests pass", check: "npm test" },
	{ id: "C2", text: "file exists", check: "path exists: src/x.ts" },
];

test("parseGraderOutput: full contract → verdicts + evidence + overall", () => {
	const p = parseGraderOutput("C1: PASS: npm test exit 0 (30 pass)\nC2: FAIL: src/x.ts not found\nOVERALL: FAIL", CRITERIA);
	assert.deepEqual(p.perCriteria, { C1: "PASS", C2: "FAIL" });
	assert.deepEqual(p.failedIds, ["C2"]);
	assert.deepEqual(p.missingIds, []);
	assert.deepEqual(p.passNoEvidence, []);
	assert.equal(p.overall, "FAIL");
	assert.match(p.evidence.C1, /exit 0/);
});

test("parseGraderOutput: missing ids / missing OVERALL / PASS without evidence are detected, not silently passed", () => {
		assert.deepEqual(parseGraderOutput("C1: PASS: ran and it worked\nOVERALL: PASS", CRITERIA).missingIds, ["C2"]);
		assert.equal(parseGraderOutput("C1: PASS: ok\nC2: PASS: ok", CRITERIA).overall, null);
		assert.deepEqual(parseGraderOutput("C1: PASS\nc2: PASS:\nOVERALL: PASS", [{ id: "C1", text: "x", check: "y" }]).passNoEvidence, ["C1"]);
		const weird = parseGraderOutput("c-1.2: PASS: ok\nOVERALL: PASS", [{ id: "c-1.2", text: "x", check: "y" }]);
	assert.equal(weird.perCriteria["c-1.2"], "PASS");
});

test("runCheckProbes: path-exists resolved in-process, runnable checks execute, manual checks are skipped", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-probe-"));
	try {
		writeFileSync(join(dir, "here.txt"), "x");
		const probes = runCheckProbes(dir, [
			{ id: "p1", text: "a", check: "path exists: here.txt" },
			{ id: "p2", text: "b", check: "path exists: nope.txt" },
			{ id: "p3", text: "c", check: "node --version" },
			{ id: "p4", text: "d", check: 'node -e "process.exit(7)"' },
			{ id: "p5", text: "e", check: "manual visual QA" },
		]);
		assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "pass", "fail", "skipped"]);
		assert.match(probes[1].detail, /not found/);
		assert.equal(probes[3].exitCode, 7);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCheckProbes: compound checks (path exists && shell / && path exists) are evaluated per segment, all must pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-probe-compound-"));
	try {
		writeFileSync(join(dir, "here.txt"), "x");
		writeFileSync(join(dir, "two.txt"), "y");
		const probes = runCheckProbes(dir, [
						{ id: "c1", text: "two files", check: "path exists: here.txt && path exists: two.txt" },
			{ id: "c2", text: "missing one", check: "path exists: here.txt && path exists: nope.txt" },
						{ id: "c3", text: "exists + shell pass", check: "path exists: here.txt && node --version" },
			{ id: "c4", text: "exists missing + shell pass", check: "path exists: nope.txt && node --version" },
			{ id: "c5", text: "exists ok + shell fail", check: 'node --version && path exists: here.txt && node -e "process.exit(3)"' },
						{ id: "c6", text: "unrunnable segment", check: "path exists: here.txt && manual visual QA" },
		]);
		assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "pass", "fail", "fail", "skipped"]);
		assert.match(probes[1].detail, /not found: nope\.txt/);
		assert.match(probes[2].detail, /exists: here\.txt/);
		assert.match(probes[3].detail, /not found: nope\.txt/);
		assert.equal(probes[4].exitCode, 3);
		assert.match(probes[5].detail, /not machine-runnable/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runCheckProbes: shell-only check containing quoted '&&' is NOT split (runs verbatim)", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "q1", text: "quoted && literal", check: 'test "$(echo \'a && b\')" = "a && b"' },
		{ id: "q2", text: "normal && chain", check: "node --version && echo ok" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["pass", "pass"]);
});

test("runCheckProbes: malformed/usage-error check commands classify as skipped (NOT fail) — no false probe-primacy FAIL loop", () => {
	const probes = runCheckProbes(tmpdir(), [
				{ id: "u1", text: "helm arg error", check: `node -e "console.error('Error: expected at most two arguments, unexpected: +, grep'); process.exit(1)"` },
		{ id: "u2", text: "test usage error", check: `node -e "console.error('sh: test: too many arguments'); process.exit(2)"` },
		{ id: "u3", text: "command not found", check: "this-command-does-not-exist-xyz --version jq" },
				{ id: "u4", text: "silent exit 1", check: 'node -e "process.exit(1)"' },
		{ id: "u5", text: "grep no match", check: "echo hello | grep -q goodbye" },
				{ id: "u6", text: "compound with broken segment", check: `node --version && node -e "console.error('usage: x [opts]'); process.exit(2)"` },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["skipped", "skipped", "skipped", "fail", "fail", "skipped"]);
	assert.match(probes[0].detail, /probe command error/);
	assert.match(probes[2].detail, /probe command error/);
	assert.equal(probes[3].exitCode, 1);
});

test("lintSpecChecks: spec-side broken checks (127 / not-runnable / placeholder) flagged, artifact-fails silent", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-lint-"));
	try {
		const r = lintSpecChecks(dir, [
			{ id: "b1", text: "t", check: "bash -c no-such-cmd-qqq" },
			{ id: "b2", text: "t", check: "definitely-not-a-real-cmd-xyz --version" },
			{ id: "b3", text: "t", check: "path exists: src/<module>/x" },
			{ id: "k1", text: "t", check: "path exists: no-such-artifact-abc" },
			{ id: "k2", text: "t", check: "test 1 -eq 2" },
			{ id: "k3", text: "t", check: "node --version" },
		]);
		assert.deepEqual(r.broken.sort(), ["b1", "b2", "b3"]);
		assert.ok(r.notes.some((n) => n.includes("b1")), "a note must name the broken id");
		assert.ok(r.notes.every((n) => n.startsWith("check-lint:")), "every note must start with check-lint:");
				assert.deepEqual(lintSpecChecks(dir, []), { broken: [], notes: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CHECK_FORMAT_CONTRACT + requirements prompt: contract markers (sh -c / path exists: / && / ** / specDebt / npm test)", () => {
	for (const marker of ["sh -c", "path exists:", "&&", "**", "specDebt", "npm test"])
		assert.ok(CHECK_FORMAT_CONTRACT.includes(marker), `contract missing marker "${marker}"`);
	const p = buildRequirementsPrompt("probe", []);
	for (const marker of ["sh -c", "path exists:", "specDebt", "&&", "**", "npm test"])
		assert.ok(p.includes(marker), `requirements prompt missing marker "${marker}"`);
		assert.ok(p.includes(CHECK_FORMAT_CONTRACT.slice(0, 120)), "prompt must embed CHECK_FORMAT_CONTRACT");
});

test("SUBAGENT_EXCLUDE_TOOLS: the verifier is read-only, the coder is not", () => {
	assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS.verifier, ["write", "edit"]);
	assert.deepEqual(SUBAGENT_EXCLUDE_TOOLS.swarm, [], "a coder must be able to write in its own worktree");
	for (const dead of ["requirements", "grader", "reviewer", "distiller", "planner"]) assert.equal(SUBAGENT_EXCLUDE_TOOLS[dead], undefined, `${dead} must be gone`);
	assert.equal(SUBAGENT_EXCLUDE_TOOLS["unknown-role"], undefined);
});

test("SUBAGENT_STRIP_FLAGS: neither role strips extensions, so both can reach their model", () => {
	assert.ok(!SUBAGENT_STRIP_FLAGS.verifier.includes("--no-extensions"));
	assert.ok(!SUBAGENT_STRIP_FLAGS.swarm.includes("--no-extensions"));
	for (const dead of ["requirements", "grader", "reviewer", "distiller", "planner"]) assert.equal(SUBAGENT_STRIP_FLAGS[dead], undefined);
});

test("gatherRepoFacts: reads package scripts + README head + layout, tolerates bare dirs", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-facts-"));
	try {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test test/x.mjs" } }));
		writeFileSync(join(dir, "README.md"), "# Demo\nhello world\n");
		mkdirSync(join(dir, "src"));
		const facts = gatherRepoFacts(dir).join("\n");
		assert.match(facts, /package: demo/);
		assert.match(facts, /test="node --test test\/x\.mjs"/);
		assert.match(facts, /README\.md \(head\)/);
		assert.match(facts, /top-level dirs: src/);
				const bare = mkdtempSync(join(tmpdir(), "zense-facts-bare-"));
		try {
			assert.ok(gatherRepoFacts(bare).every((f) => f.startsWith("- toolchain on PATH")));
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadSpecExemplar: picks the newest APPROVED spec with criteria, skips unapproved/broken", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-exemplar-"));
	try {
		assert.equal(loadSpecExemplar(dir), null); 		const specsDir = join(dir, ".zense", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "2026-01-01-00-00-00-v1-old-signed.json"),
			JSON.stringify({ title: "old signed", intent: "do old thing", approved: true, scope: ["src"], criteria: [{ id: "c1", text: "t", check: "npm test" }], specDebt: [] }),
		);
		writeFileSync(
			join(specsDir, "2026-02-01-00-00-00-v2-new-unsigned.json"),
			JSON.stringify({ title: "new unsigned", intent: "x", approved: false, scope: [], criteria: [{ id: "c1", text: "t", check: "npm test" }], specDebt: [] }),
		);
		writeFileSync(join(specsDir, "2026-03-01-00-00-00-v3-broken.json"), "{not json");
		const ex = loadSpecExemplar(dir);
		assert.ok(ex);
		assert.match(ex, /old signed/, "must skip the newer-but-unsigned/broken files and pick the approved one");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildGraderPrompt: probe results are authoritative, evidence mandatory, read-only stated", () => {
	const spec = { version: 1, title: "T", intent: "i", scope: ["src"], constraints: [], criteria: CRITERIA, specDebt: [], approved: true };
	const p = buildGraderPrompt(spec, [{ id: "C1", status: "fail", exitCode: 1, detail: "boom" }, { id: "C2", status: "pass", detail: "exists" }], "recent commits:\nabc123 x", "");
	assert.match(p, /probe: FAIL \(exit 1\) — boom/);
	assert.match(p, /probe: PASS — exists/);
	assert.match(p, /NO write\/edit tools/);
	assert.match(p, /Reward-hacking checklist/);
	assert.match(p, /Change summary/);
	assert.match(p, /A PASS without evidence is rejected/);
		assert.match(buildGraderPrompt(spec, [], "", "no verdict given for: C2"), /SYSTEM FEEDBACK: your previous response was rejected: no verdict given for: C2/);
});

test("parseReviewerPacket: full schema ok + TL;DR extracted; missing sections reported for retry feedback", () => {
	const good = [
		"## TL;DR",
		"- merged wave 2",
		"- eval PASS with probes",
		"- safe to deploy",
		"- extra line beyond 3 is truncated",
		"## Cross-check",
		"- You want A to show B when C → added renderB in src/a.ts",
		"- When 1 happens, 2 disappears → removed the stale path in src/b.ts",
		"## Intent vs Implementation",
		"matched",
		"## Risks",
		"none",
		"## Rollback",
		"git revert abc",
		"## Human actions",
		"none",
	].join("\n");
	const parsed = parseReviewerPacket(good);
	assert.equal(parsed.ok, true);
	assert.deepEqual(parsed.missing, []);
	assert.equal(parsed.tldr.split("\n").length, 3);
	assert.match(parsed.tldr, /merged wave 2/);
	assert.deepEqual(parsed.crossCheck, [
		{ goal: "You want A to show B when C", evidence: "added renderB in src/a.ts" },
		{ goal: "When 1 happens, 2 disappears", evidence: "removed the stale path in src/b.ts" },
	]);
	const bad = parseReviewerPacket("Some free text without headers at all");
	assert.equal(bad.ok, false);
	assert.deepEqual(bad.missing, ["TL;DR", "Cross-check", "Intent vs Implementation", "Risks", "Rollback", "Human actions"]);
	assert.equal(bad.tldr, "");
	assert.deepEqual(bad.crossCheck, []);
});

test("parseCrossCheckItems: arrows (→/->), bold, numbered bullets tolerated; a bullet without an arrow keeps the goal only", () => {
	const text = ["## Cross-check", "- **A when B** → done in `f` at src/a.ts", "2. C -> removed in src/c.ts", "- D has no mapping"].join("\n");
	assert.deepEqual(parseCrossCheckItems(text), [
		{ goal: "A when B", evidence: "done in `f` at src/a.ts" },
		{ goal: "C", evidence: "removed in src/c.ts" },
		{ goal: "D has no mapping", evidence: "" },
	]);
	assert.deepEqual(parseCrossCheckItems("no section"), []);
});

test("mergeCrossCheck: every signed goal appears once; exact/near matches reuse evidence, unmapped goals are flagged", () => {
	const goals = ["You want A to show B when C", "When 1 happens, 2 disappears"];
	const parsed = [{ goal: "when 1 happens 2 disappears", evidence: "removed it in src/b.ts" }];
	const merged = mergeCrossCheck(goals, parsed);
	assert.deepEqual(merged, [
		{ goal: goals[0], evidence: "" },
		{ goal: goals[1], evidence: "removed it in src/b.ts" },
	]);
		const extra = mergeCrossCheck([goals[0]], [{ goal: "bonus case", evidence: "added in src/z.ts" }]);
	assert.equal(extra.length, 2);
	assert.equal(extra[1].goal, "bonus case");
});

test("buildReviewerPrompt: carries eval evidence + git + flags/debt, defines strict section contract", () => {
	const p = buildReviewerPrompt(
		"make things fast",
		{ verdict: "PASS", perCriteria: { C1: "PASS", C2: "FAIL" }, probes: [{ id: "C1", status: "pass", detail: "ok" }] },
		["out-of-scope write: x"],
		["debt one"],
		[{ kind: "need-fix", detail: "criteria failed: C2" }],
		"recent commits:\nabc impl v2",
		"",
	);
	assert.match(p, /Intent: make things fast/);
	assert.match(p, /Eval verdict: PASS/);
	assert.match(p, /C2=FAIL/);
	assert.match(p, /C1: pass — ok/); 	assert.match(p, /out-of-scope write: x/);
	assert.match(p, /debt one/);
	assert.match(p, /need-fix: criteria failed: C2/);
	assert.match(p, /abc impl v2/);
	assert.match(p, /never write "to be implemented"/);
	assert.match(p, /## Human actions/);
	assert.match(p, /## Cross-check/);
	const withGoals = buildReviewerPrompt("i", undefined, [], [], [], "changed symbols:\n+ src/a.ts: export function renderB", "", undefined, undefined, ["You want A to show B when C"]);
	assert.match(withGoals, /Cross-check cases \(the human's signed request, verbatim/);
	assert.match(withGoals, /1\. You want A to show B when C/);
	assert.match(withGoals, /EXACTLY one line per case above/);
	assert.match(withGoals, /what was actually DONE/);
	assert.match(buildReviewerPrompt("i", undefined, [], [], [], "", "Rollback"), /was rejected: Rollback/); });

test("buildReviewerPrompt: stale lastEval (version/tree) is dropped and warned", () => {
	const ev = {
		verdict: "PASS",
		perCriteria: { C1: "PASS" },
		probes: [{ id: "C1", status: "pass", detail: "ok" }],
		specVersion: 1,
		head: "tree-aaa",
	};
		const staleV = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 2, head: "tree-aaa" });
	assert.doesNotMatch(staleV, /Eval verdict: PASS/);
	assert.doesNotMatch(staleV, /C1=PASS/);
	assert.doesNotMatch(staleV, /C1: pass/);
	assert.match(staleV, /STALE eval evidence/);
		const staleT = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 1, head: "tree-bbb" });
	assert.doesNotMatch(staleT, /Eval verdict: PASS/);
	assert.match(staleT, /STALE eval evidence/);
		const fresh = buildReviewerPrompt("i", ev, [], [], [], "", "", { specVersion: 1, head: "tree-aaa" });
	assert.match(fresh, /Eval verdict: PASS/);
	assert.match(fresh, /C1=PASS/);
	assert.match(fresh, /C1: pass — ok/); 	assert.doesNotMatch(fresh, /STALE/);
});

test("gitChangeSummary: baseline scopes log+diff to baseline..HEAD", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-gitbase-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		writeFileSync(join(cwd, "old-round-file.txt"), "old\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "old-round commit"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
		writeFileSync(join(cwd, "new-round-file.txt"), "new\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "current-round commit"]);
		const scoped = gitChangeSummary(cwd, baseline);
		assert.match(scoped, /current-round commit/); 		assert.doesNotMatch(scoped, /old-round commit/); 		assert.match(scoped, /new-round-file\.txt/); 		assert.doesNotMatch(scoped, /old-round-file\.txt/);
				assert.match(gitChangeSummary(cwd), /old-round commit/);
		const nonGit = mkdtempSync(join(tmpdir(), "zense-nogit-base-"));
		try {
			assert.equal(gitChangeSummary(nonGit, "deadbeef"), "");
		} finally {
			rmSync(nonGit, { recursive: true, force: true });
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("buildPendingApplyEvidencePrefix: the reviewer can't mistake main for committed — a clear staged-uncommitted label when pendingApply exists", () => {
		const p = buildPendingApplyEvidencePrefix(true, false);
	assert.match(p, /staged, uncommitted/);
	assert.match(p, /a human commits after this review/);
	assert.match(p, /no new commits since baseline.+expected/);
		const h = buildPendingApplyEvidencePrefix(true, true);
	assert.match(h, /edited AFTER eval\+apply/);
	assert.match(h, /review as normal/);
		assert.equal(buildPendingApplyEvidencePrefix(false, false), "");
		const prompt = buildReviewerPrompt("i", undefined, [], [], [], buildPendingApplyEvidencePrefix(true, false) + "\n" + "diffstat vs baseline:\n src.ts | 2 ++", "", {
		specVersion: 1,
		head: "tree-x",
	});
	assert.match(prompt, /staged, uncommitted/);
	assert.match(prompt, /src\.ts \| 2/); });

test("gitChangeSummary: staged-but-uncommitted changes (pendingApply) still show in diffstat/porcelain — the reviewer sees full evidence", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-staged-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		writeFileSync(join(cwd, "base.txt"), "base\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "baseline commit"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
				writeFileSync(join(cwd, "applied.txt"), "staged only\n");
		git(["add", "applied.txt"]);
		const s = gitChangeSummary(cwd, baseline);
		assert.match(s, /applied\.txt/); 		assert.doesNotMatch(s, /commits since baseline/); 	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("gitChangedSymbols: reports real added function/class/const names with their files (reviewer can cite them)", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-symbols-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "a.ts"), "export const before = 1;\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "baseline"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
		writeFileSync(join(cwd, "src", "a.ts"), "export const before = 1;\nexport function renderB() {}\nconst helper = () => {};\n");
		writeFileSync(join(cwd, "src", "b.ts"), "export interface Case {}\n");
		git(["add", "-A"]);
		const out = gitChangedSymbols(cwd, baseline);
		assert.match(out, /changed symbols/);
		assert.match(out, /\+ src\/a\.ts: export function renderB/);
		assert.match(out, /\+ src\/a\.ts: const helper/);
		assert.match(out, /\+ src\/b\.ts: export interface Case/);
		assert.equal(gitChangedSymbols(cwd, "deadbeef"), ""); 	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("gitDiffExcerpt: verbatim added/removed lines + file paths (call sites and removals are evidence)", () => {
	const cwd = mkdtempSync(join(tmpdir(), "zense-diffex-"));
	try {
		const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		git(["init", "-q"]);
		git(["config", "user.email", "t@t"]);
		git(["config", "user.name", "t"]);
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src", "a.ts"), "export function oldPath() {}\n");
		writeFileSync(join(cwd, "src", "b.ts"), "oldPath();\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "baseline"]);
		const baseline = git(["rev-parse", "HEAD"]).trim();
		writeFileSync(join(cwd, "src", "a.ts"), "export function newPath() {}\n");
		writeFileSync(join(cwd, "src", "b.ts"), "newPath();\n");
		git(["add", "-A"]);
		const out = gitDiffExcerpt(cwd, baseline);
		assert.match(out, /changed lines \(verbatim/);
		assert.match(out, /file: src\/a\.ts/);
		assert.match(out, /\+export function newPath/);
		assert.match(out, /-export function oldPath/);
		assert.match(out, /\+newPath\(\)/); 		assert.equal(gitDiffExcerpt(cwd, "deadbeef"), "");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("buildRequirementsPrompt: facts + exemplar spliced in, request stays last (backward compatible)", () => {
	const base = buildRequirementsPrompt("add x", []);
	assert.match(base, /Request: add x$/);
	assert.doesNotMatch(base, /Repository facts/);
	const withCtx = buildRequirementsPrompt("add x", ["lesson A"], ["- scripts: test=..."], '{"title":"old"}');
	const factsAt = withCtx.indexOf("Repository facts");
	const exemplarAt = withCtx.indexOf("previously SIGNED spec");
	const lessonsAt = withCtx.indexOf("Past lessons");
	const requestAt = withCtx.indexOf("Request: add x");
	assert.ok(exemplarAt > -1 && exemplarAt < factsAt && factsAt < lessonsAt && lessonsAt < requestAt);
});
