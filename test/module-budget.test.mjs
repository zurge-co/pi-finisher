import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HYGIENE_MAX_LINES, countLines } from "../extensions/zense-harness/index.ts";

const here = new URL("..", import.meta.url).pathname;
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
		return [p];
	});

const sources = walk(join(here, "extensions")).filter((f) => /\.(ts|mjs)$/.test(f));

test("every extension source file stays under the read-in-one-go budget", () => {
	assert.ok(sources.length > 10, `expected the extension sources to be found, got ${sources.length}`);
	const over = sources.map((f) => [f.replace(here, ""), countLines(readFileSync(f, "utf8")), statSync(f).size]).filter(([, n]) => n > HYGIENE_MAX_LINES);
	assert.deepEqual(over.map(([f, n]) => `${f}: ${n}`), [], `files over ${HYGIENE_MAX_LINES} lines must be split`);
});

test("the entry point is only wiring: no file carries the whole harness", () => {
	const index = countLines(readFileSync(join(here, "extensions/zense-harness/index.ts"), "utf8"));
	assert.ok(index < 500, `index.ts is ${index} lines — it must stay a thin entry point`);
	const src = readdirSync(join(here, "extensions/zense-harness/src")).filter((f) => f.endsWith(".ts"));
	assert.ok(src.length >= 20, `the harness must be split across many modules, found ${src.length}`);
});

test("the budget is a real bound: a synthetic file just over it is rejected", () => {
	const atLimit = Array.from({ length: HYGIENE_MAX_LINES }, () => "x").join("\n");
	const over = `${atLimit}\nx`;
	assert.equal(countLines(atLimit), HYGIENE_MAX_LINES);
	assert.ok(countLines(over) > HYGIENE_MAX_LINES);
});

test("shell scripts keep their shebang and stay executable (a comment stripper must never eat line 1)", async () => {
	const { existsSync, statSync } = await import("node:fs");
	const scripts = walk(join(here, "scripts")).filter((f) => f.endsWith(".sh"));
	assert.ok(scripts.length > 0, "expected at least one release script");
	for (const f of scripts) {
		const first = readFileSync(f, "utf8").split("\n")[0];
		assert.match(first, /^#!\//, `${f} must start with a shebang`);
		assert.ok((statSync(f).mode & 0o111) !== 0, `${f} must stay executable`);
	}
	assert.ok(existsSync(join(here, "scripts", "release.sh")));
});
