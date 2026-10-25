import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHECK_RESULT_STATUS,
	appendCheck,
	caseCheckEntries,
	checkFileLines,
	checkStatusOf,
	checkTask,
	clearCheckCache,
	detectChecks,
	failingChecks,
	judgeDeterministic,
	readChecks,
	readPackage,
	runCheckStage,
	scriptPaths,
	skippedChecks,
	writesFiles,
} from "../extensions/finisher/index.ts";

const repo = (scripts) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-stage-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stage", scripts }));
	return dir;
};

const CHECK = { name: "test", command: "npm", args: ["run", "--silent", "test"] };

const green = (at) => [{ command: "npm test", ok: true, ...(at === undefined ? {} : { at }) }];

const stageOf = async (calls, lastModifiedAt) => {
	let ran = 0;
	const stage = await runCheckStage([CHECK], {
		cwd: repo({}),
		timeoutMs: 5_000,
		calls,
		...(lastModifiedAt === undefined ? {} : { lastModifiedAt }),
		run: async () => {
			ran++;
			return { exitCode: 0, output: "" };
		},
	});
	return { ran, status: checkStatusOf(stage.results[0]), recorded: stage.recorded.length };
};

test("a green recording is proof only while it is newer than the last edit — existence is not freshness", async () => {
	const edit = 10_000;
	for (const at of [edit, edit + 1, undefined]) assert.deepEqual(await stageOf(green(at), edit), { ran: 0, status: "pass", recorded: 1 }, `a green recording at ${String(at)} is fresh enough`);
	for (const [calls, modified] of [
		[green(edit - 1), edit],
		[{ command: "npm test", ok: false, at: edit + 1 }, edit],
		[[], edit],
		[{ command: "npm run build", ok: true, at: edit + 1 }, edit],
		[{ command: "npm test", ok: false, at: edit + 1 }, undefined],
		[[], undefined],
	]) {
		const out = await stageOf(calls, modified);
		assert.equal(out.ran, 1, `the check must run again for ${JSON.stringify(calls)} with lastModifiedAt=${String(modified)}`);
		assert.equal(out.recorded, 0);
	}
	assert.deepEqual(await stageOf(green(1), undefined), { ran: 0, status: "pass", recorded: 1 }, "with no edit on record, staleness cannot be claimed");
});

test("only a check that names its own paths can be scoped away, and a scoped check's silence is never a failure", async () => {
	assert.deepEqual(scriptPaths("node --no-warnings --test test/a.test.mjs test/b.test.mjs"), ["test"], "the paths a check owns come from its own script");
	assert.deepEqual(scriptPaths("tsc --noEmit --module esnext --allowImportingTsExtensions extensions/finisher/index.ts"), ["extensions"]);
	assert.deepEqual(scriptPaths("eslint ."), [], "a script that names no path owns nothing in particular");
	assert.equal(checkTask(CHECK, { scripts: { test: "eslint ." } }).paths, undefined, "an unscoped check always runs — it can never be skipped by a change set");

	const dir = repo({ test: "node --test test/*.test.mjs", lint: "eslint lib/*.ts" });
	const pkg = readPackage(dir);
	const checks = detectChecks(pkg);
	let ran = 0;
	const stage = await runCheckStage(checks, {
		cwd: dir,
		timeoutMs: 5_000,
		pkg,
		changed: ["README.md"],
		run: async () => {
			ran++;
			return { exitCode: 0, output: "" };
		},
	});
	assert.equal(ran, 0, "a documentation change can affect neither check, so neither is spawned");
	assert.deepEqual(stage.results.map(checkStatusOf), ["scoped", "scoped"]);
	assert.deepEqual(failingChecks(stage.results), [], "not running is not failing");
	assert.equal(skippedChecks(stage.results).length, 2);
	const evidence = judgeDeterministic(["c1"], new Map([["c1", "node check.mjs"]]), [{ command: "node check.mjs", ok: true }], stage.results);
	assert.deepEqual(evidence.map((c) => c.result), ["PASS"], "a skipped check leaves the case to its own recording");
});

test("a toolchain that cannot run here, or a check cut by its deadline, never fails the cases the harness can still judge", () => {
	const cases = ["c1", "c2"];
	const calls = [{ command: "node a.mjs", ok: true }];
	const commands = new Map([["c1", "node a.mjs"], ["c2", "node b.mjs"]]);
	const missing = { name: "typecheck", command: "npm run --silent typecheck", exitCode: 127, tail: "sh: tsc: command not found", status: "infra" };
	const killed = { ...missing, status: "deadline", exitCode: 124, tail: "" };
	for (const check of [missing, killed]) {
		const evidence = judgeDeterministic(cases, commands, calls, [check]);
		assert.deepEqual(evidence.map((c) => c.result), ["PASS", "UNVERIFIED"], `${check.status} is not the repo being broken`);
		assert.deepEqual(failingChecks([check]), []);
	}
	const broken = { ...missing, status: "fail", exitCode: 1, tail: "1 failing" };
	assert.deepEqual(judgeDeterministic(cases, commands, calls, [broken]).map((c) => c.result), ["FAIL", "FAIL"], "a real failure still fails every case");
});

test("an edit is what changes the tree: a search never invalidates the checks, a write always does", () => {
	for (const command of ["grep -rn intake extensions", "git status --porcelain", "npm run typecheck", "node --test test/a.test.mjs", "cat src/a.ts"])
		assert.equal(writesFiles("bash", { command }), false, `${command} only reads, so it cannot make a recorded check stale`);
	for (const command of ["sed -i s/a/b/ src/a.ts", "printf x > src/a.ts", "mv a b", "rm -rf dist", "npm install"])
		assert.equal(writesFiles("bash", { command }), true, `${command} writes, so the next verify must not trust an older green`);
	for (const tool of ["write", "edit", "apply_patch"]) assert.equal(writesFiles(tool, {}), true);
	for (const tool of ["read", "grep", "finisher_verify"]) assert.equal(writesFiles(tool, {}), false);
});

test("the check cache is keyed by the tree, not by the clock: the same edit state spawns nothing, a newer edit runs again", async () => {
	clearCheckCache();
	const dir = repo({ test: "node -e 0" });
	const [check] = detectChecks(readPackage(dir));
	let ran = 0;
	const run = async () => {
		ran++;
		return { exitCode: 0, output: "" };
	};
	const opts = { cwd: dir, timeoutMs: 5_000, run };
	const first = await runCheckStage([check], { ...opts, lastModifiedAt: 5 });
	const second = await runCheckStage([check], { ...opts, lastModifiedAt: 5 });
	const third = await runCheckStage([check], { ...opts, lastModifiedAt: 6 });
	assert.equal(ran, 2, "the second pass over the same edit state never reaches the runner");
	assert.equal(first.results[0].cached, false);
	assert.equal(second.results[0].cached, true);
	assert.equal(third.results[0].cached, false, "a newer edit is not answered from the old result");
});

test("the check file keeps one line per case, and only a PASS case may say PASS", () => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-stage-file-"));
	const evidence = Object.keys(CHECK_RESULT_STATUS).map((result) => ({ caseId: `case ${result}`, result, commands: [] }));
	const entries = caseCheckEntries(evidence, new Map([["case PASS", "node check.mjs"]]), "ship it", 1_000);
	for (const entry of entries) appendCheck(dir, entry);
	const kept = readChecks(dir);
	assert.deepEqual(
		kept.map((e) => [e.case, e.status]),
		Object.entries(CHECK_RESULT_STATUS).map(([result, status]) => [`case ${result}`, status]),
		"the file says exactly what each case came to",
	);
	assert.equal(kept.filter((e) => e.status === "pass").length, 1, "a pass is written only for a pass");
	assert.ok(kept.every((e) => e.goal === "ship it" && e.at === 1_000), "every line belongs to this goal, all at once");
	assert.equal(kept.find((e) => e.case === "case PASS").command, "node check.mjs");
	assert.deepEqual(checkFileLines(kept, ["case PASS", "case FAIL"]), ["PASS  case PASS", "FAIL  case FAIL"]);
});
