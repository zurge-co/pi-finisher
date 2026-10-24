import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_TOOLS } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
		return [p];
	});

const shipped = [...walk(join(here, "extensions")), ...walk(join(here, "themes"))].filter((f) => /\.(ts|mjs|json)$/.test(f));
const docs = [join(here, "README.md"), join(here, "AGENTS.md"), join(here, "package-lock.json")];
const retiredPrefix = RETIRED_TOOLS[0].slice(0, RETIRED_TOOLS[0].indexOf("_"));
const theme = () => JSON.parse(readFileSync(join(here, "themes/finisher.json"), "utf8"));

test("nothing shipped, documented or locked carries the retired brand name, in any casing", () => {
	const brand = new RegExp(retiredPrefix, "i");
	const hits = [...shipped, ...docs].flatMap((f) => {
		const src = readFileSync(f, "utf8");
		return src
			.split("\n")
			.map((line, i) => ({ f: f.replace(here, ""), i: i + 1, line }))
			.filter(({ line }) => brand.test(line) && !RETIRED_TOOLS.some((t) => line.includes(t)));
	});
	assert.deepEqual(hits.map((h) => `${h.f}:${h.i} ${h.line.trim()}`), [], "the only allowed mention is a retired tool name");
});

test("the theme covers every token pi's own dark theme defines, so no token falls back silently", () => {
	const piTheme = join(here, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json");
	if (!existsSync(piTheme)) return;
	const required = Object.keys(JSON.parse(readFileSync(piTheme, "utf8")).colors);
	const mine = new Set(Object.keys(theme().colors));
	assert.deepEqual(required.filter((k) => !mine.has(k)), [], "a missing token is one pi has to guess");
});

test("the theme carries the new finisher identity, not the retired green/gold palette", () => {
	const t = theme();
	assert.equal(t.name, "finisher");
	assert.equal(t.appearance, "dark");
	const declared = Object.values(t.colors).filter((v) => typeof v === "string" && v !== "");
	const resolved = declared.map((v) => (v.startsWith("#") ? v : t.vars[v]));
	assert.equal(resolved.filter(Boolean).length, declared.length, "every token that names a colour resolves to one");
	for (const retired of ["#00c55a", "#6cdd25", "#facd04"]) assert.ok(!resolved.includes(retired), `${retired} belongs to the retired palette`);
	assert.equal(t.vars[t.colors.accent], t.vars.violet, "violet is the accent");
	assert.equal(t.vars[t.colors.success], t.vars.mint, "mint means done");
	assert.equal(t.vars[t.colors.error], t.vars.rose);
});

test("every var reference in the theme resolves, and the base is dark", () => {
	const t = theme();
	const dangling = Object.entries(t.colors).filter(([, v]) => typeof v === "string" && v && !v.startsWith("#") && !(v in t.vars));
	assert.deepEqual(dangling.map(([k]) => k), [], "a colour that is neither hex nor a var is a broken theme");
	const luma = (hex) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	assert.ok(luma(t.export.pageBg) < 0.2, "the page is graphite dark, so the theme must declare it");
});
