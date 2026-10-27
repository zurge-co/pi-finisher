import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir, isLiveTool, RETIRED_TOOLS, SURFACE_TOOLS, SURFACE_COMMANDS } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(here, p), "utf8");
const retiredPrefix = RETIRED_TOOLS[0].slice(0, RETIRED_TOOLS[0].indexOf("_"));
const retiredDir = `.${retiredPrefix}`;

test("state lives in .finisher, never in a retired workspace dir", () => {
	assert.equal(finisherDir("/repo"), "/repo/.finisher");
	const types = read("extensions/finisher/src/types.ts");
	assert.match(types, /\.finisher/);
	assert.ok(!types.includes(`"${retiredDir}"`), "the state dir keeps only one name");
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
