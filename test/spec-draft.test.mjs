import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyQualityGate,
	buildRequirementsPrompt,
	buildSubagentArgv,
	extractJsonObject,
	findSimilarSpec,
	hasOutcomeJargon,
	isMachineCheckable,
	parseSpecDraft,
	QUESTION_POLICY,
} from "../extensions/zense-harness/index.ts";

const GOOD_SPEC = {
	title: "Fix login redirect",
	intent: "users hit /login twice",
	crossCheck: [
		"คุณต้องการให้เข้าสู่ระบบครั้งเดียวแล้วถึงหน้าที่ต้องการได้ทันที",
		"เมื่อกลับมาใช้งานอีกครั้ง ระบบจะไม่ถามรหัสผ่านซ้ำ",
	],
	outcomes: "หลังเข้าสู่ระบบ คุณจะถึงหน้าที่ต้องการได้ทันทีโดยไม่ต้องเข้าสู่ระบบซ้ำ",
	scope: ["src/auth"],
	constraints: ["no new deps"],
	criteria: [
		{ id: "c1", text: "login test passes", check: "npm test" },
		{ text: "guard exists", check: "path exists: src/auth/guard.ts" },
	],
	specDebt: [],
};

test("extractJsonObject: tolerates plain JSON, fences and surrounding prose", () => {
	const json = JSON.stringify(GOOD_SPEC);
	assert.deepEqual(extractJsonObject(json), GOOD_SPEC);
	assert.equal(extractJsonObject("```json\n" + json + "\n```").title, "Fix login redirect");
	assert.equal(extractJsonObject("Here is the spec!\n" + json + "\nHope this helps.").intent, "users hit /login twice");
	assert.equal(extractJsonObject("no json at all"), undefined);
});

test("parseSpecDraft: valid spec (plain/fenced) → kind spec with normalized ids and defaults", () => {
	const parsed = parseSpecDraft(JSON.stringify(GOOD_SPEC));
	assert.equal(parsed.kind, "spec");
	assert.equal(parsed.draft.criteria[1].id, "c2"); 	const fenced = parseSpecDraft("here's the draft:\n```json\n" + JSON.stringify({ title: "T", criteria: [{ text: "x", check: "npm test" }] }) + "\n```");
	assert.equal(fenced.kind, "spec");
	assert.deepEqual(fenced.draft.scope, []); 	assert.equal(fenced.draft.title, "T");
});

test("parseSpecDraft: approach normalize — missing/invalid → [], valid array → kept", () => {
	const withApproach = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, approach: ["add approach field to Spec/SpecDraft", "wire prompt contract + renderSpecMd", "npm test green"] }));
	assert.equal(withApproach.kind, "spec");
	assert.deepEqual(withApproach.draft.approach, ["add approach field to Spec/SpecDraft", "wire prompt contract + renderSpecMd", "npm test green"]);
	const missing = parseSpecDraft(JSON.stringify(GOOD_SPEC));
	assert.equal(missing.kind, "spec");
	assert.deepEqual(missing.draft.approach, []); 	const invalid = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, approach: 42 }));
	assert.deepEqual(invalid.draft.approach, []); 			assert.equal(parseSpecDraft(JSON.stringify({ questions: [{ question: "q", choices: ["a", "b"] }], approach: ["x"] })).kind, "clarify");
});

test("buildRequirementsPrompt: JSON contract includes approach (presentational, not a machine-checked criterion)", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /"approach": string\[\]/);
	assert.match(p, /approach: 3–7 short bullets/);
	assert.match(p, /NOT a machine-checked criterion/);
});

test("parseSpecDraft: clarify shape (questions only) → kind clarify; questions+criteria → spec", () => {
	const clarify = parseSpecDraft(JSON.stringify({ questions: [
		{ question: "which env?", choices: ["dev", "prod"] },
		{ question: "which db?", choices: ["sqlite", "pg"] },
	] }));
	assert.equal(clarify.kind, "clarify");
	assert.deepEqual(clarify.questions, [
		{ question: "which env?", choices: ["dev", "prod"] },
		{ question: "which db?", choices: ["sqlite", "pg"] },
	]);
		const withCriteria = parseSpecDraft(JSON.stringify({ questions: [{ question: "q", choices: ["a"] }], ...GOOD_SPEC }));
	assert.equal(withCriteria.kind, "spec");
});

test("parseSpecDraft: clarify questions normalize — choices shape, freeText marker, junk skipped, cap 5", () => {
		const withChoices = parseSpecDraft(JSON.stringify({ questions: [{ question: "pick env?", choices: ["dev", "prod"] }] }));
	assert.equal(withChoices.kind, "clarify");
	assert.deepEqual(withChoices.questions, [{ question: "pick env?", choices: ["dev", "prod"] }]);
		const mixed = parseSpecDraft(JSON.stringify({ questions: [
		{ question: "what should the empty state look like?", freeText: true },
		{ question: "with choice?", choices: ["a"] },
	] }));
	assert.equal(mixed.kind, "clarify");
	assert.deepEqual(mixed.questions, [
		{ question: "what should the empty state look like?", choices: [], freeText: true },
		{ question: "with choice?", choices: ["a"] },
	]);
		assert.equal(parseSpecDraft(JSON.stringify({ questions: [{ foo: 1 }] })).kind, "error");
		const many = parseSpecDraft(JSON.stringify({ questions: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}?`, choices: ["a", "b"] })) }));
	assert.equal(many.questions.length, 5);
});

test("parseSpecDraft: question policy — a bare string / choice-less question is an ERROR (never a silent open question)", () => {
			const bare = parseSpecDraft(JSON.stringify({ questions: ["which db should we use?"] }));
	assert.equal(bare.kind, "error");
	assert.match(bare.error, /question policy violation/);
	assert.match(bare.error, /which db should we use\?/); 		const noChoices = parseSpecDraft(JSON.stringify({ questions: [{ question: "which module layout?" }] }));
	assert.equal(noChoices.kind, "error");
	assert.match(noChoices.error, /no choices and no "freeText": true/);
		const partiallyBad = parseSpecDraft(JSON.stringify({ questions: [{ question: "ok?", choices: ["a", "b"] }, "bare one"] }));
	assert.equal(partiallyBad.kind, "error");
		assert.equal(parseSpecDraft(JSON.stringify({ questions: [{ question: "x?", freeText: false }] })).kind, "error");
});

test("QUESTION_POLICY: names both sides of the contract (goal-only questions + decide-it-yourself rule)", () => {
	assert.match(QUESTION_POLICY, /product\/UI-outcome questions/i);
	assert.match(QUESTION_POLICY, /2–6 pickable choices/);
	assert.match(QUESTION_POLICY, /internal technical\/detail/);
	assert.match(QUESTION_POLICY, /assumption plus a specDebt entry/);
	assert.match(QUESTION_POLICY, /freeText/);
});

test("parseSpecDraft: invalid outputs → kind error with a specific reason (retry feedback)", () => {
	assert.equal(parseSpecDraft("sure, let me think about it").kind, "error");
	assert.match(parseSpecDraft(JSON.stringify({ title: "T" })).error, /criteria/); 	const badItem = parseSpecDraft(JSON.stringify({ criteria: [{ text: "x" }] }));
	assert.equal(badItem.kind, "error");
	assert.match(badItem.error, /\[0\]\.check/); });

test("isMachineCheckable: runnable commands / path-exists pass, manual/ambiguous fail", () => {
	assert.ok(isMachineCheckable("npm test"));
	assert.ok(isMachineCheckable("node --test test/x.mjs"));
	assert.ok(isMachineCheckable("path exists: src/auth/guard.ts"));
	assert.ok(isMachineCheckable("run `vitest run`"));
	assert.ok(!isMachineCheckable("manual review by the team"));
	assert.ok(!isMachineCheckable("ask the human to verify it works"));
	assert.ok(!isMachineCheckable("GET /health returns 200")); });

test("applyQualityGate: empty scope and non-machine checks are forced into specDebt with notes", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-draft-"));
	try {
		const gated = applyQualityGate(dir, {
			title: "T",
			intent: "fix things",
			scope: [],
			constraints: [],
			criteria: [
				{ id: "c1", text: "tests pass", check: "npm test" },
				{ id: "c2", text: "looks good", check: "manual visual QA" },
			],
			specDebt: [],
		});
						assert.deepEqual(gated.notes, ["cross-check-missing", "empty-scope", "manual-check:c2"]);
		assert.equal(gated.draft.specDebt.length, 3);
		assert.ok(gated.draft.specDebt.some((d) => d.includes("cross-check cases")));
				const ghost = applyQualityGate(dir, { ...gated.draft, scope: ["ghost/path-xyz"], specDebt: [] });
		assert.ok(ghost.notes.some((n) => n.startsWith("scope-missing:ghost/path-xyz")));
		assert.ok(ghost.draft.specDebt.some((d) => d.includes("ghost/path-xyz")));
		assert.match(gated.draft.specDebt[0], /cross-check cases/);
		assert.match(gated.draft.specDebt[1], /scope/);
		assert.match(gated.draft.specDebt[2], /c2/);
		assert.equal(gated.draft.criteria.length, 2);
				mkdirSync(join(dir, "src", "auth"), { recursive: true });
		const clean = applyQualityGate(dir, { ...GOOD_SPEC, title: "Unique title xyz", intent: "unrelated intent qrs" });
		assert.deepEqual(clean.notes, []);
		assert.equal(clean.draft.specDebt.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("findSimilarSpec: archived spec with overlapping title+intent is flagged (Jaccard ≥ 0.5)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-sim-"));
	try {
		assert.equal(findSimilarSpec(dir, { ...GOOD_SPEC }), null); 		const specsDir = join(dir, ".zense", "specs");
		mkdirSync(specsDir, { recursive: true });
		writeFileSync(
			join(specsDir, "2026-01-01-00-00-00-v1-fix-login-redirect.json"),
			JSON.stringify({ title: "fix login redirect", intent: "users hit the login page twice" }),
		);
		const hit = findSimilarSpec(dir, { ...GOOD_SPEC, title: "fix login redirect bug", intent: "users hit the login page twice" });
		assert.ok(hit, "must catch the similar spec");
		assert.match(hit.file, /fix-login-redirect/);
		const miss = findSimilarSpec(dir, { ...GOOD_SPEC, title: "database migration tooling", intent: "add schema versioning for postgres" });
		assert.equal(miss, null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildSubagentArgv: requirements role is read-only (--exclude-tools write,edit), others untouched", () => {
	const ro = buildSubagentArgv("draft a spec", "anthropic/claude-sonnet", ["write", "edit"]);
	assert.deepEqual(ro.slice(0, 4), ["PI_ZENSE_SUBAGENT=1", "pi", "--mode", "json"]);
	const xt = ro.indexOf("--exclude-tools");
	assert.ok(xt > 0 && ro[xt + 1] === "zense_*,write,edit", "the harness tools are excluded before the role's own read-only set");
	const md = ro.indexOf("--model");
	assert.ok(md > xt, "--exclude-tools must come before --model");
	assert.equal(ro.at(-1), "draft a spec");

	const plain = buildSubagentArgv("grade it");
	assert.ok(!plain.includes("--exclude-tools"));
	assert.equal(plain.at(-1), "grade it");
});

test("buildSubagentArgv: per-role strip flags — grader/reviewer boot fully bare, requirements keep skills/extensions", () => {
	const FULL = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	for (const role of ["grader", "reviewer"]) {
		const a = buildSubagentArgv(`task-${role}`, undefined, undefined, role);
		for (const f of FULL) assert.ok(a.includes(f), `${role} must have ${f}`);
		assert.equal(a.at(-1), `task-${role}`, "the task must always be argv's last element");
				assert.ok(a.indexOf("--no-themes") > a.indexOf("--no-session"), `${role}: strip flags must come after --no-session`);
	}
		const g = buildSubagentArgv("grade", "sonnet", ["write", "edit"], "grader");
	assert.ok(g.indexOf("--no-skills") < g.indexOf("--exclude-tools"), "strip flags must come before --exclude-tools");
	assert.ok(g.indexOf("--exclude-tools") < g.indexOf("--model"), "--exclude-tools must come before --model (standing contract)");
		const req = buildSubagentArgv("draft", undefined, undefined, "requirements");
	assert.ok(req.includes("--no-themes") && req.includes("--no-prompt-templates"));
	assert.ok(!req.includes("--no-skills") && !req.includes("--no-extensions"), "requirements must not strip skills/extensions");
		const STRIP_ONLY = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	assert.ok(!STRIP_ONLY.some((f) => buildSubagentArgv("x").includes(f)));
	assert.ok(!STRIP_ONLY.some((f) => buildSubagentArgv("x", undefined, undefined, "mystery").includes(f)));
});

test("buildRequirementsPrompt: enforces explore-first, JSON-only output and the clarify contract", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /EXPLORE \(read-only/);
	assert.match(p, /NO write\/edit tools/);
	assert.match(p, /"questions"/);
	assert.match(p, /"choices"/); 	assert.match(p, /type their own/); 	assert.match(p, /1–2 most decision-critical/); });

test("buildRequirementsPrompt: goal-only questions — names the banned internal technical category + the assumption/specDebt fallback", () => {
	const p = buildRequirementsPrompt("add dark mode", []);
	assert.match(p, /GOAL-ONLY QUESTIONS/);
	assert.match(p, /product\/UI terms/);
	assert.match(p, /NEVER ask the human an internal technical\/detail question/);
	assert.match(p, /library choice, module split/); 	assert.match(p, /specDebt entry/); 	assert.match(p, /assumption/);
	assert.match(p, /freeText/); 	assert.match(p, /policy violation/); 	assert.match(p, /Request: add dark mode$/);
	assert.doesNotMatch(p, /Past lessons/);
	const withLessons = buildRequirementsPrompt("x", ["📚 lesson one"]);
	assert.match(withLessons, /Past lessons[\s\S]*lesson one/);
});

test("applyQualityGate: unsubstituted placeholder in check → specDebt + notes (fix check before signing)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-ph-"));
	try {
		const gated = applyQualityGate(dir, {
			title: "T",
			intent: "i",
			scope: ["."],
			constraints: [],
			criteria: [
				{ id: "c1", text: "ok", check: "npm test" },
				{ id: "c2", text: "ph", check: "path exists: src/<module>/x.ts" },
			],
			specDebt: [],
		});
		assert.ok(gated.notes.includes("placeholder:c2"));
		assert.ok(!gated.notes.some((n) => n.startsWith("placeholder:c1")));
		assert.ok(gated.draft.specDebt.some((d) => d.includes("unsubstituted placeholder in its check") && d.includes("<module>")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseSpecDraft: crossCheck parsed + trimmed, embedded newlines collapsed, blanks dropped; absent stays undefined", () => {
	const withCases = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, crossCheck: ["  A when B  ", "C\nand D", "  "] }));
	assert.equal(withCases.kind, "spec");
	assert.deepEqual(withCases.draft.crossCheck, ["A when B", "C and D"]);
	const legacy = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, crossCheck: [] }));
	assert.equal(legacy.kind, "spec");
	assert.equal(legacy.draft.crossCheck, undefined, "empty crossCheck must normalize to undefined, never an empty array");
});

test("parseSpecDraft: legacy outcomes still parsed + trimmed; absent outcomes stay undefined (back-compat)", () => {
	const withOut = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, outcomes: "  คุณจะได้หน้าล็อกอินที่เข้าได้ทันที  " }));
	assert.equal(withOut.kind, "spec");
	assert.equal(withOut.draft.outcomes, "คุณจะได้หน้าล็อกอินที่เข้าได้ทันที");
	const legacy = parseSpecDraft(JSON.stringify({ ...GOOD_SPEC, outcomes: "   " }));
	assert.equal(legacy.kind, "spec");
	assert.equal(legacy.draft.outcomes, undefined, "blank outcomes must normalize to undefined, never an empty string");
});

test("hasOutcomeJargon: clean request-language text passes; backticks, file names, paths and commands are flagged", () => {
	assert.deepEqual(hasOutcomeJargon("หลังเข้าสู่ระบบ คุณจะเห็นหน้าโปรไฟล์ของตัวเองได้ทันที"), []);
	assert.deepEqual(hasOutcomeJargon("You can see your profile right after logging in"), []);
	assert.ok(hasOutcomeJargon("run `npm test` to confirm").includes("code fence/backtick"));
	assert.ok(hasOutcomeJargon("adds src/auth/guard.ts").includes("file name"));
	assert.ok(hasOutcomeJargon("grep -q x y && echo ok").includes("shell command"));
});

test("applyQualityGate: jargon in cross-check cases is forced into specDebt (the signer must not read command soup)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-draft-"));
	try {
		const gated = applyQualityGate(dir, { ...GOOD_SPEC, crossCheck: ["adds `src/auth/guard.ts` and runs npm test"] });
		assert.ok(gated.notes.includes("cross-check-jargon"));
		assert.ok(gated.draft.specDebt.some((d) => d.includes("technical tokens")));
		const long = applyQualityGate(dir, { ...GOOD_SPEC, crossCheck: ["x".repeat(241)] });
		assert.ok(long.notes.includes("cross-check-long"));
		assert.ok(long.draft.specDebt.some((d) => d.includes("240 characters")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildRequirementsPrompt: crossCheck is REQUIRED, request-language, one case per line (the sign surface)", () => {
	const p = buildRequirementsPrompt("fix the login flow", []);
	assert.match(p, /"crossCheck": string\[\]/, "the draft JSON contract must carry crossCheck");
	assert.match(p, /crossCheck: REQUIRED/);
	assert.match(p, /SAME LANGUAGE as the Request/i);
	assert.match(p, /one goal CASE per line/);
	assert.match(p, /NEVER use jargon/);
});
