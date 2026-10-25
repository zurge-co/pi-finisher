import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const read = (...parts) => readFileSync(join(here, ...parts), "utf8");
const pkg = JSON.parse(read("package.json"));

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
	assert.match(read("skills", "goal-intake", "SKILL.md"), /finisher_goal/);
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
