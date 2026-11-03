import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStateBox, groundPlan, groundingNote, pathTokens, scriptTokens } from "../extensions/finisher/index.ts";
import { registerTools } from "../extensions/finisher/src/tools.ts";

const repo = ({ scripts = {}, files = [] } = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "finisher-ground-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ground", scripts }));
	for (const rel of files) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), "x");
	}
	return dir;
};

const kinds = (dir, texts) => groundPlan(dir, texts).gaps.map((gap) => `${gap.kind}:${gap.token}`);

test("a plan naming what the repo really has is grounded, and nothing is reported", () => {
	const dir = repo({ scripts: { test: "node --test", build: "tsc" }, files: ["src/a.ts"] });
	assert.deepEqual(kinds(dir, ["edit `src/a.ts`", "run `npm test`", "then `npm run build`"]), []);
	assert.equal(groundPlan(dir, ["edit `src/a.ts`"]).checked, 1, "the path was really checked, not skipped");
});

test("a path or a package script the repo does not have is a gap, named exactly", () => {
	const dir = repo({ scripts: { test: "node --test" }, files: ["src/a.ts"] });
	assert.deepEqual(kinds(dir, ["edit `src/missing.ts`", "run `npm run lint`"]), ["path:src/missing.ts", "script:lint"]);
	assert.match(groundingNote(groundPlan(dir, ["edit `src/missing.ts`"])), /src\/missing\.ts — no such path/);
	assert.match(groundingNote(groundPlan(dir, ["run `npm run lint`"])), /package\.json has no "lint" script/);
});

test("a lap that creates the path is grounded, and a later lap may refer to it", () => {
	const dir = repo({ files: ["src/a.ts"] });
	assert.deepEqual(kinds(dir, ["create `src/new.ts`"]), [], "the creation verb is the permission");
	assert.deepEqual(kinds(dir, ["add `src/new.ts`", "`src/new.ts` parses the input"]), [], "a later lap may use what an earlier lap creates");
	assert.deepEqual(kinds(dir, ["`src/new.ts` parses the input", "create `src/new.ts`"]), [], "order in the plan does not matter to what it creates");
});

test("URLs, home paths, globs, placeholders and bare filenames are never plan gaps", () => {
	const dir = repo({ files: ["package.json"] });
	assert.deepEqual(kinds(dir, ["see `https://example.com/src/x.ts`", "see `~/src/x.ts`", "match `src/*.ts`", "`...`", "`package.json`", "`foo(a)`"]), []);
	assert.deepEqual(kinds(dir, ["import `node:fs/promises`", "use `@scope/pkg`", "open `file:///x/y.ts`"]), [], "module specifiers are not workspace paths");
	assert.deepEqual(pathTokens("`src/a.ts` and `https://x/y.ts` and `src/*.ts`"), ["src/a.ts"]);
});

test("a cd in the lap moves the base a path and a script are resolved against", () => {
	const dir = repo({ scripts: { test: "node --test" }, files: ["app/src/x.ts"] });
	writeFileSync(join(dir, "app", "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
	assert.deepEqual(kinds(dir, ["cd app && edit `src/x.ts` and run `npm run build`"]), []);
});

test("only real package scripts are checked: builtins and bare bun runners are not scripts", () => {
	assert.deepEqual(scriptTokens("`bun test`"), [], "bun test is a builtin runner, not a package script");
	assert.deepEqual(scriptTokens("`bun run build`"), ["build"]);
	assert.deepEqual(scriptTokens("`npm install`"), [], "install is a builtin");
	assert.deepEqual(scriptTokens("`npm test`"), ["test"]);
	assert.deepEqual(scriptTokens("`npm run --silent typecheck`"), ["typecheck"]);
	const dir = repo({ files: ["src/a.ts"] });
	assert.deepEqual(kinds(dir, ["run `bun test`"]), [], "a repo with no package script is not asked for one");
});

const session = (cwd) => {
	const defs = [];
	const box = createStateBox({ phase: "implementation", turnsUsed: 0, tokensUsed: 0, escalations: [], trajectoryFlags: [], subagentRuns: [] });
	const asked = [];
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
		launchSubagent: async () => ({ ok: true, output: "", logPath: "/tmp/x.log", calls: [] }),
	});
	const ctx = { cwd, hasUI: true, mode: "tui", model: { provider: "p", id: "m" }, ui: { notify: () => {} }, sessionManager: { getEntries: () => [], getSessionId: () => "sess-ground" } };
	const run = (name, params) => defs.find((def) => def.name === name).execute("1", params, undefined, undefined, ctx);
	return { box, asked, run };
};

test("goal refuses cases that name what the repo does not have, before the human is ever asked", async () => {
	const s = session(repo({ files: ["src/a.ts"] }));
	const refused = await s.run("goal", { goal: "ship it", cases: ["`src/nope.ts` parses the input"] });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /src\/nope\.ts/);
	assert.match(refused.content[0].text, /read the code/i);
	assert.equal(s.asked.length, 0, "the confirm dialog was never opened");
	assert.equal(s.box.get().goalDriver, undefined, "nothing was confirmed");

	const accepted = await s.run("goal", { goal: "ship it", cases: ["`src/a.ts` parses the input"] });
	assert.equal(accepted.isError, undefined);
	assert.equal(s.asked.length, 1, "a grounded list opens the dialog exactly once");
	assert.equal(s.box.get().goalDriver.cases[0], "`src/a.ts` parses the input");
});

test("lap refuses a plan built on names the repo does not have, and stores no lap", async () => {
	const s = session(repo({ files: ["src/a.ts"] }));
	await s.run("goal", { goal: "ship it", cases: ["the check passes"] });
	const refused = await s.run("lap", { plan: ["edit `src/nope.ts`", "run `npm run ghost`"] });
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /src\/nope\.ts/);
	assert.match(refused.content[0].text, /ghost/);
	assert.equal(s.box.get().goalDriver.phases.length, 0, "an ungrounded plan is not declared");

	const accepted = await s.run("lap", { plan: ["edit `src/a.ts`", "create `src/b.ts`"] });
	assert.equal(accepted.isError, undefined);
	assert.equal(s.box.get().goalDriver.phases.length, 2, "a grounded plan is declared whole");
	assert.equal(s.box.get().goalDriver.lap, 1);
});
