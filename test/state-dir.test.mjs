import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir, SURFACE_TOOLS, SURFACE_COMMANDS } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(here, p), "utf8");

test("state lives in .finisher, not .zense", () => {
	assert.equal(finisherDir("/repo"), "/repo/.finisher");
	const types = read("extensions/finisher/src/types.ts");
	assert.match(types, /\.finisher/);
	assert.doesNotMatch(types, /"\.zense"/);
});

test("there is no migration: an old .zense workspace is left alone, not read or moved", () => {
	for (const f of ["extensions/finisher/index.ts", "extensions/finisher/src/types.ts", "extensions/finisher/src/cycle.ts"]) {
		const src = read(f);
		assert.ok(!/renameSync|cpSync/.test(src), `${f} must not move anything`);
		assert.ok(!src.includes('".zense"'), `${f} must not reference the old workspace`);
	}
});

test("session state is persisted under the new name only", () => {
	const index = read("extensions/finisher/index.ts");
	assert.match(index, /"finisher-state"/);
	assert.ok(!index.includes("zense-state"));
});

test("the live surface carries no old name", () => {
	assert.deepEqual([...SURFACE_TOOLS], ["finisher_goal", "finisher_swarm", "finisher_steer"]);
	assert.deepEqual([...SURFACE_COMMANDS], ["models"]);
	for (const t of SURFACE_TOOLS) assert.ok(!t.startsWith("zense_"), `${t} still carries the old prefix`);
});
