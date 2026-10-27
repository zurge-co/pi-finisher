import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_COMMANDS, SURFACE_COMMANDS } from "../extensions/finisher/index.ts";

const here = new URL("..", import.meta.url).pathname;
const read = (...parts) => readFileSync(join(here, ...parts), "utf8");
const pkg = JSON.parse(read("package.json"));

const HOST_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];

const importedPackages = () => {
	const found = new Set();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(?:ts|mjs|js)$/.test(entry.name))
				for (const hit of readFileSync(path, "utf8").matchAll(/from\s+"([^".][^"]*)"/g)) {
					if (hit[1].startsWith("node:")) continue;
					found.add(hit[1].startsWith("@") ? hit[1].split("/").slice(0, 2).join("/") : hit[1].split("/")[0]);
				}
		}
	};
	walk(join(here, "extensions"));
	return [...found].sort();
};

const skillDirs = () => readdirSync(join(here, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

const frontmatter = (text) => {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
	return match ? match[1] : "";
};

test("the package ships the resources it declares, and declares nothing it does not have", () => {
	for (const dir of ["extensions", "skills", "themes"]) assert.ok(pkg.files.includes(dir), `${dir}/ must be in package.files to ship`);
	for (const dir of pkg.files) assert.ok(existsSync(join(here, dir)), `${dir} is declared but missing on disk`);
	assert.equal(pkg.pi.skills, undefined, "skills are found by convention, so no manifest key may be needed");
});

test("every host package the extension imports is a peer with a '*' range, so pi never installs a second copy", () => {
	const imported = importedPackages();
	assert.ok(imported.length > 0, "the extension imports something");
	for (const name of imported) {
		assert.ok(HOST_PACKAGES.includes(name), `${name} must be a pi-provided package`);
		assert.equal(pkg.dependencies?.[name], undefined, `${name} must never be a dependency — a physical copy duplicates pi's own classes`);
		assert.equal(pkg.peerDependencies?.[name], "*", `${name} is declared as a peer with range '*'`);
	}
	for (const name of Object.keys(pkg.peerDependencies ?? {})) assert.ok(imported.includes(name), `${name} is declared a peer but never imported`);
});

test("the manifest carries no junk: no escape-nobody-needs file, no blank metadata, and a gallery keyword", () => {
	assert.equal(existsSync(join(here, ".npmignore")), false, ".npmignore is gone — package.files is the one allowlist");
	assert.ok(pkg.keywords.includes("pi-package"), "pi-package is what makes the package discoverable in the gallery");
	for (const key of ["author", "bin", "main", "types"]) assert.equal(pkg[key], undefined, `${key} would be a field nobody reads`);
	for (const value of Object.values(pkg).filter((v) => typeof v === "string")) assert.ok(value.trim().length > 0, "no blank string field");
});

test("every shipped skill is discoverable by pi: its own directory, its own name, and a description of when to load it", () => {
	const dirs = skillDirs();
	assert.deepEqual(dirs, ["goal-intake", "verify-checks"]);
	for (const dir of dirs) {
		const text = read("skills", dir, "SKILL.md");
		const front = frontmatter(text);
		assert.ok(front, `${dir}/SKILL.md must start with frontmatter`);
		assert.match(front, new RegExp(`^name: ${dir}$`, "m"), "the name must match the directory");
		const description = (front.match(/^description: (.+)$/m) ?? [])[1] ?? "";
		assert.ok(description.length > 40, "the description must say what it does and when to use it");
		assert.ok(description.includes("Use "), "the description states when it applies");
	}
});

test("the shipped skills carry the rules they are named for, not a title alone", () => {
	assert.match(read("skills", "goal-intake", "SKILL.md"), /goal/);
	assert.match(read("skills", "goal-intake", "SKILL.md"), /before/);
	assert.match(read("skills", "verify-checks", "SKILL.md"), /\.finisher\/checks/);
	assert.match(read("skills", "verify-checks", "SKILL.md"), /UNVERIFIED/);
});

test("the human's words are check and result, never probe or verdict", () => {
	const humanFacing = [read("README.md"), ...skillDirs().map((dir) => read("skills", dir, "SKILL.md"))];
	for (const text of humanFacing) assert.doesNotMatch(text, /probe|verdict/i);
	assert.match(read("README.md"), /check/i);
});

test("the skill and the README carry one and the same bound for a vague goal", () => {
	const sources = [
		["skills/goal-intake/SKILL.md", read("skills", "goal-intake", "SKILL.md")],
		["README.md", read("README.md")],
	];
	for (const [name, text] of sources) {
		assert.match(text, /at most 3 questions/i, `${name} states the cap`);
		assert.match(text, /options/i, `${name} says the human picks instead of typing`);
		assert.match(text, /as I said is enough/i, `${name} names the escape`);
		assert.match(text, /reading the code/i, `${name} names the question that may never be asked`);
	}
});

test("the README states that no configuration is needed after install", () => {
	const readme = read("README.md");
	assert.match(readme, /## Nothing to configure/);
	assert.match(readme, /\.finisher\/checks/);
});

test("the README documents every command the harness registers, and nothing it does not", () => {
	const readme = read("README.md");
	const commands = readme.slice(readme.indexOf("## Commands"), readme.indexOf("## Nothing to configure"));
	assert.match(commands, /## Commands/, "the section exists");
	for (const name of SURFACE_COMMANDS) assert.ok(commands.includes(`/finisher ${name}`), `README's Commands table omits /finisher ${name}`);
	for (const retired of RETIRED_COMMANDS) assert.ok(!commands.includes(`/finisher ${retired}`), `README's Commands table advertises the retired /finisher ${retired}`);
});

test("the README carries an install section that names the package the manifest ships", () => {
	const readme = read("README.md");
	const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## Quick start"));
	assert.match(install, /## Install/, "the section exists");
	assert.ok(install.includes(`npm:${pkg.name}`), "the npm source is the package.json name, so a rename cannot leave the docs behind");
	for (const dir of pkg.pi.extensions.concat(pkg.pi.themes)) {
		const base = dir.replace(/^\.\//, "").replace(/\/$/, "");
		assert.ok(install.includes(base), `install never says what it brings: ${base}`);
	}
});
