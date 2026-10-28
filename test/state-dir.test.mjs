import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testFinisherHome } from "./helpers/finisher-home.mjs";
import {
	PROJECT_HASH_LEN,
	PROJECT_KEY_MAX,
	finisherDir,
	finisherHome,
	isLiveTool,
	projectKey,
	RETIRED_TOOLS,
	SURFACE_TOOLS,
	SURFACE_COMMANDS,
} from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(here, p), "utf8");
const retiredPrefix = RETIRED_TOOLS[0].slice(0, RETIRED_TOOLS[0].indexOf("_"));
const retiredDir = `.${retiredPrefix}`;

test("harness state lives outside the working directory: one dir per project under the finisher home", () => {
	const home = testFinisherHome();
	const one = finisherDir("/repo/one");
	const two = finisherDir("/repo/two");
	assert.ok(one.startsWith(`${home}/`), `a project's state sits under FINISHER_HOME, not next to the code: ${one}`);
	assert.equal(finisherHome(), home, "FINISHER_HOME is the root every project dir hangs under");
	assert.equal(one, finisherDir("/repo/one"), "one cwd always resolves to the same dir");
	assert.notEqual(one, two, "two projects never share a state dir");
	assert.ok(!one.startsWith("/repo/one"), "and nothing is placed inside the project itself");
	const types = read("extensions/finisher/src/types.ts");
	assert.ok(!types.includes(`"${retiredDir}"`), "the state dir keeps only one name");
});

test("a project key is a safe, bounded file name for any cwd, and two cwds never collide", () => {
	const longest = `/${"x".repeat(400)}`;
	for (const cwd of ["/repo/one", "/repo one/with space", "/ÜNICODE/Σ", "/", "/a/b/../c", longest]) {
		const key = projectKey(cwd);
		assert.match(key, /^[A-Za-z0-9._-]+$/, `${cwd.slice(0, 40)}: the key is safe as a file name: ${key}`);
		assert.ok(key.length <= PROJECT_KEY_MAX + 1 + PROJECT_HASH_LEN, `${cwd.slice(0, 40)}: the key stays bounded: ${key.length}`);
	}
	assert.notEqual(projectKey("/a/b"), projectKey("/a-b"), "two cwds that flatten to the same words stay two dirs");
	assert.equal(projectKey("/a/b"), projectKey("/a/b/"), "one path spelled two ways is one key");
	assert.equal(projectKey("/a/b"), projectKey("/a/b/../b"), "and so is a path that walks back to itself");
});

test("there is no migration: a retired workspace dir is left alone, not read or moved", () => {
	for (const f of ["extensions/finisher/index.ts", "extensions/finisher/src/types.ts", "extensions/finisher/src/cycle.ts"]) {
		const src = read(f);
		assert.ok(!/renameSync|cpSync/.test(src), `${f} must not move anything`);
		assert.ok(!src.includes(`"${retiredDir}"`), `${f} must not reference the retired workspace`);
	}
});

test("session state is persisted under the new name only", () => {
	const index = read("extensions/finisher/index.ts");
	assert.match(index, /"finisher-state"/);
	assert.ok(!index.includes(`${retiredPrefix}-state`), "the retired state key must not be persisted or restored");
});

test("the live surface carries no prefix at all: no retired name, no finisher_ wrapper", () => {
	assert.deepEqual([...SURFACE_TOOLS], ["goal", "lap", "code", "verify", "steer"]);
	assert.deepEqual([...SURFACE_COMMANDS], ["models", "gaps"]);
	for (const t of SURFACE_TOOLS) {
		assert.ok(!t.startsWith(`${retiredPrefix}_`), `${t} still carries the retired prefix`);
		assert.ok(!t.includes("_"), `${t} must be a bare tool name, so a call is goal, not finisher_goal`);
	}
	for (const t of RETIRED_TOOLS) assert.ok(!SURFACE_TOOLS.includes(t), `${t} is retired but still live`);
	for (const t of SURFACE_TOOLS) assert.equal(isLiveTool(t), true, `${t} is on the surface, so it must be live`);
});
