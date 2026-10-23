import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { analyzeTestFile, assertions, formatTestFindings, isTestFile, testBlocks } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
		return [p];
	});

const kinds = (text) => analyzeTestFile(text, "test/x.test.mjs").map((f) => f.kind);

test("a test that can never fail is rejected, whichever way it is written", () => {
	assert.deepEqual(kinds('test("t", () => { setup(); });'), ["no-assertion"]);
	assert.deepEqual(kinds('test("t", () => { assert.ok(true); });'), ["tautology"]);
	assert.deepEqual(kinds('test("t", () => { assert.strictEqual(x, x); });'), ["tautology"]);
	assert.deepEqual(kinds('test("t", () => { assert.equal(typeof f, "function"); });'), ["shape-only"]);
	assert.deepEqual(kinds('test("t", () => { assert.ok(!!x); });'), ["tautology"]);
});

test("a test that pins a real law passes, and one weak assertion beside a strong one is tolerated", () => {
	assert.deepEqual(kinds('test("t", () => { assert.equal(clamp(9, 5, 5), 5); });'), []);
	assert.deepEqual(kinds('test("t", () => { assert.deepEqual(order(xs), ["a", "b"]); });'), []);
	assert.deepEqual(kinds('test("t", () => { assert.ok(xs.length > 0); assert.deepEqual(order(xs), sorted); });'), []);
	assert.deepEqual(kinds('test("t", () => { assert.ok(result); });'), []);
	assert.deepEqual(kinds('test("t", () => { assert.match(p, /c1/); });'), []);
});

test("the scan sees each test separately, so one bad test cannot hide behind a good one", () => {
	const text = ['test("good", () => { assert.equal(a, 1); });', 'test("bad", () => { assert.ok(true); });'].join("\n");
	const findings = analyzeTestFile(text, "test/x.test.mjs");
	assert.equal(findings.length, 1);
	assert.equal(findings[0].name, "bad");
	assert.equal(findings[0].line, 2);
});

test("nested calls and string commas do not confuse the assertion parser", () => {
	const parsed = assertions('assert.deepEqual(f(1, 2), ["a,b", "c"]);');
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].method, "deepEqual");
	assert.deepEqual(parsed[0].args, ["f(1, 2)", '["a,b", "c"]']);
});

test("blocks are delimited by test( declarations, not by blank lines", () => {
	const blocks = testBlocks('test("a", () => {\n\n  assert.ok(x);\n});\ntest("b", () => {});\n');
	assert.deepEqual(blocks.map((b) => b.name), ["a", "b"]);
	assert.equal(blocks[1].line, 5);
});

test("test files are recognised by path and by suffix, source files are not", () => {
	assert.equal(isTestFile("test/a.test.mjs"), true);
	assert.equal(isTestFile("tests/e2e/x.ts"), true);
	assert.equal(isTestFile("src/a.test.ts"), true);
	assert.equal(isTestFile("src/a.ts"), false);
	assert.equal(isTestFile("src/contest.ts"), false);
});

test("the repo's own tests contain no filler: the rule is enforced on the real tree", () => {
	const files = walk(join(here, "test")).filter((f) => /\.(test|spec)\.mjs$/.test(f)).filter((f) => !f.endsWith("test-quality.test.mjs"));
	assert.ok(files.length > 20, `expected the real suites, found ${files.length}`);
	const findings = files.flatMap((f) => analyzeTestFile(readFileSync(f, "utf8"), f.replace(here, "")));
	assert.deepEqual(findings.map((f) => `${f.file}:${f.line} ${f.kind}`), [], formatTestFindings(findings));
});

test("every test file is a real file with real content (no placeholders, no empty suites)", () => {
	const suites = walk(join(here, "test")).filter((p) => /\.test\.mjs$/.test(p));
	for (const f of suites) {
		if (f.endsWith("test-quality.test.mjs")) continue;
		const text = readFileSync(f, "utf8");
		assert.ok(statSync(f).size > 100, `${f} is suspiciously small`);
		assert.ok(text.includes("test("), `${f} declares no test`);
		assert.ok(!/TODO|FIXME|it\.skip\(|test\.skip\(/.test(text), `${f} must not ship skipped/placeholder tests`);
	}
});

test("weak-test detection is not JavaScript-only", async () => {
	const { analyzeTestFile: analyze, testBlocksFor } = await import("../extensions/finisher/index.ts");
	const py = "def test_law():\n    assert clamp(9, 5, 5) == 5\n\ndef test_filler():\n    pass\n";
	assert.deepEqual(analyze(py, "pkg/x_test.py").map((f) => f.name + ":" + f.kind), ["test_filler:no-assertion"]);
	const go = "func TestLaw(t *testing.T) {\n\tif x != 5 { t.Fatalf(1) }\n}\nfunc TestFiller(t *testing.T) {\n}\n";
	assert.equal(testBlocksFor(go, "svc/x_test.go").length, 2);
	assert.deepEqual(analyze(go, "svc/x_test.go").map((f) => f.name), ["TestFiller"]);
});

test("test files are recognised across languages, source files never are", async () => {
	const { isTestFile } = await import("../extensions/finisher/index.ts");
	for (const p of ["test/test_foo.py", "pkg/user_test.py", "svc/handler_test.go", "spec/a_spec.rb", "src/FooTest.java"]) assert.equal(isTestFile(p), true, p);
	for (const p of ["src/app.py", "src/contest.ts", "src/attest.go", "src/latest.ts"]) assert.equal(isTestFile(p), false, p);
});

test("one entry point decides every rule, so no path can skip the check", async () => {
	const { reviewWrittenFile, buildFileReviewReport } = await import("../extensions/finisher/index.ts");
	const comment = reviewWrittenFile("src/app.py", "# note\nx = 1");
	assert.equal(comment.ok, false);
	assert.match(buildFileReviewReport(comment), /no comments|comment/i);
	assert.equal(reviewWrittenFile("src/app.py", "x = 1").ok, true);
	assert.equal(reviewWrittenFile("pkg/x_test.py", "def test_filler():\n    pass\n").ok, false);
	const big = Array.from({ length: 501 }, () => "x = 1").join("\n");
	assert.equal(reviewWrittenFile("app/engine.py", big).ok, false);
	const both = reviewWrittenFile("pkg/x_test.py", `${big}\n# note\ndef test_filler():\n    pass\n`);
	assert.equal(both.violations.length > 0 && both.weakTests.length > 0, true);
	assert.match(buildFileReviewReport(both), /finisher-hygiene-allow/);
});

test("writes hidden inside a bash command are found, plain commands are not", async () => {
	const { commandWritePaths, scriptWrites, stdinTargets } = await import("../extensions/finisher/index.ts");
	assert.deepEqual(commandWritePaths("cat > src/app.py <<EOF\nprint(1)\nEOF"), ["src/app.py"]);
	assert.deepEqual(commandWritePaths("tee -a pkg/x_test.py >/dev/null"), ["pkg/x_test.py"]);
	assert.deepEqual(commandWritePaths("git status --short"), []);
	assert.equal(scriptWrites("python3 - <<'PY'\nprint(1)\nPY"), true);
	assert.deepEqual(stdinTargets("python3 - <<'PY' > src/gen.py\nprint(1)\nPY"), ["src/gen.py"]);
	assert.equal(scriptWrites("npm test"), false);
});
