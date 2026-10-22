import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanSource } from "../extensions/zense-harness/index.ts";

const here = new URL("..", import.meta.url).pathname;
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
		return [p];
	});

const files = walk(join(here, "extensions")).filter((f) => /\.(ts|mjs)$/.test(f));

test("the harness sources carry no code comments and no over-long files", () => {
	const violations = files.flatMap((f) => scanSource(readFileSync(f, "utf8"), f.replace(here, "")).violations);
	const report = violations.slice(0, 15).map((v) => `${v.path}${v.line ? `:${v.line}` : ""} ${v.kind} — ${v.detail}`).join("\n");
	assert.deepEqual(violations.map((v) => `${v.path}:${v.line ?? 0}:${v.kind}`), [], `code comments are not allowed in code:\n${report}`);
});

test("a documented exemption still passes, and a bare marker does not", () => {
	const allowed = scanSource("const a = 1;\n// zense-hygiene-allow: upstream snippet kept verbatim\n", "x.ts");
	assert.deepEqual(allowed.violations, []);
	assert.equal(allowed.ignored.length, 1);
	const bare = scanSource("const a = 1;\n// zense-hygiene-allow\n", "x.ts");
	assert.equal(bare.violations[0].kind, "exempt-without-reason");
});

test("a comment that hides inside a string literal is not a comment", () => {
	const text = ['const url = "https://example.com//path";', "const s = 'a // b';", "const t = `/* not a comment */`;"].join("\n");
	assert.deepEqual(scanSource(text, "x.ts").violations, []);
});
