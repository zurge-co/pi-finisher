import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	PROJECT_HASH_LEN,
	PROJECT_KEY_MAX,
	STATE_HOME_LABEL,
	checksDir,
	decisionsPath,
	finisherDir,
	finisherHome,
	handoffPath,
	modelsPath,
	projectKey,
	readConsultMode,
	reportPath,
	shortHome,
	stateLabel,
	statePath,
	trackerDir,
} from "../extensions/finisher/index.ts";
import { testFinisherHome } from "./helpers/finisher-home.mjs";

const here = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(here, p), "utf8");
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const CWDS = ["/repo", "/repo/nested/dir", "/repo with space", "/a-b", "/a/b", "/Ünïcode-проект", `/${"deep/".repeat(40)}repo`];

test("state lives under one home, one directory per project, and never inside the workspace", () => {
	const home = finisherHome();
	assert.equal(home, resolve(testFinisherHome()), "the home is FINISHER_HOME when it is set");
	for (const cwd of CWDS) {
		const dir = finisherDir(cwd);
		assert.ok(inside(dir, home), `${dir} escapes the home ${home}`);
		assert.equal(inside(dir, resolve(cwd)), false, `${dir} is inside the workspace ${cwd}`);
		assert.equal(dir, join(home, projectKey(cwd)), "the project directory is the home plus its key");
		const key = projectKey(cwd);
		assert.equal(key.includes(sep), false, `${key} carries a path separator`);
		assert.equal(key.split(sep).includes(".."), false, `${key} climbs out`);
		assert.ok(key.length <= PROJECT_KEY_MAX + 1 + PROJECT_HASH_LEN, `${key} is unbounded`);
	}
});

test("the project key is stable for one workspace and unique across two, however their paths are spelled", () => {
	for (const cwd of CWDS) {
		const key = projectKey(cwd);
		for (const spelling of [cwd, `${cwd}/`, `${cwd}/./`, `${cwd}/../${cwd.slice(cwd.lastIndexOf("/") + 1)}`]) assert.equal(projectKey(spelling), key, `${spelling} is the same workspace as ${cwd}`);
	}
	assert.notEqual(projectKey("/a-b"), projectKey("/a/b"), "two paths that flatten to the same word stay two projects");
	assert.notEqual(projectKey("/repo"), projectKey("/repo/nested"), "a nested directory is its own project");
	assert.equal(projectKey("/"), "root-" + projectKey("/").slice(-PROJECT_HASH_LEN), "the root has a name, not an empty one");
});

test("every state file resolves under the one project directory", () => {
	for (const cwd of CWDS) {
		const dir = finisherDir(cwd);
		const files = [statePath(cwd, "config.json"), modelsPath(cwd), reportPath(cwd), decisionsPath(cwd), handoffPath(cwd), checksDir(cwd), trackerDir(cwd, "sess"), stateLabel(cwd)];
		for (const file of files) assert.ok(inside(file, dir), `${file} escapes ${dir}`);
		assert.equal(statePath(cwd, "checks", "checks.jsonl"), join(dir, "checks", "checks.jsonl"), "a nested state file keeps its place");
		assert.equal(modelsPath(cwd), statePath(cwd, "models.json"), "models.json is a state file, not a second root");
	}
});

test("the home is FINISHER_HOME, else ~/.pi/finisher — a blank or junk setting never falls back to the workspace", () => {
	const saved = process.env.FINISHER_HOME;
	try {
		delete process.env.FINISHER_HOME;
		assert.equal(finisherHome("/home/me"), join("/home/me", ".pi", "finisher"), "with no setting the home is ~/.pi/finisher");
		for (const junk of ["", "   ", "\t"]) {
			process.env.FINISHER_HOME = junk;
			assert.equal(finisherHome("/home/me"), join("/home/me", ".pi", "finisher"), `${JSON.stringify(junk)} is no home at all`);
		}
		process.env.FINISHER_HOME = "  /custom/state  ";
		assert.equal(finisherHome("/home/me"), resolve("/custom/state"), "a setting wins and is trimmed");
		assert.equal(STATE_HOME_LABEL, "~/.pi/finisher/<project>", "the one label the tools print names the real home");
	} finally {
		if (saved === undefined) delete process.env.FINISHER_HOME;
		else process.env.FINISHER_HOME = saved;
	}
});

test("a label never shortens a path it does not own", () => {
	assert.equal(shortHome("/home/me/.pi/finisher/k", "/home/me"), "~/.pi/finisher/k");
	assert.equal(shortHome("/home/me", "/home/me"), "~");
	assert.equal(shortHome("/home/other/x", "/home/me"), "/home/other/x", "a sibling home is not this home");
	assert.equal(shortHome("/home/melon/x", "/home/me"), "/home/melon/x", "and a prefix is not a parent");
});

test("there is no migration: a workspace .finisher is left alone, never read, never moved", () => {
	const cwd = mkdtempSync(join(tmpdir(), "finisher-legacy-"));
	const legacy = join(cwd, ".finisher");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "config.json"), JSON.stringify({ consultMode: "off", handoffModel: "legacy/model" }));
	const before = readdirSync(legacy).sort();
	assert.equal(readConsultMode(cwd), "auto", "a legacy config is not this harness's config");
	assert.equal(existsSync(finisherDir(cwd)), false, "reading state never creates the new directory");
	assert.deepEqual(readdirSync(legacy).sort(), before, "the legacy directory is not moved, copied or pruned");
});

test("no module recreates a state directory inside the workspace", () => {
	const root = join(here, "extensions/finisher");
	const files = [...readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).map((f) => join(root, "src", f)), join(root, "index.ts")];
	const offenders = files.filter((f) => /(?:mkdirSync|writeFileSync|appendFileSync|createWriteStream)\([^)]*\.finisher/.test(readFileSync(f, "utf8")));
	assert.deepEqual(offenders, [], `these modules write a workspace state dir: ${offenders.join(", ")}`);
});
