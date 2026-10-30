import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
	GC_MARKER_AGE_MS,
	GC_PRUNE_MAX,
	PROJECT_HASH_LEN,
	PROJECT_KEY_MAX,
	PROJECT_MARKER_FILE,
	STATE_HOME_LABEL,
	checksDir,
	decisionsPath,
	finisherDir,
	finisherHome,
	handoffPath,
	modelsPath,
	projectKey,
	pruneProjectDirs,
	readConsultMode,
	reportPath,
	shortHome,
	stateLabel,
	statePath,
	trackerDir,
	writeProjectMarker,
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

const goneWorkspace = () => join(tmpdir(), `finisher-gone-${randomUUID()}`);
const liveWorkspace = () => mkdtempSync(join(tmpdir(), "finisher-live-"));

const backdate = (path, now = Date.now()) => {
	const old = new Date(now - GC_MARKER_AGE_MS - 60_000);
	utimesSync(path, old, old);
};

const markedDir = (home, name, workspace, { age = true, now = Date.now() } = {}) => {
	const dir = join(home, name);
	mkdirSync(dir, { recursive: true });
	const marker = join(dir, PROJECT_MARKER_FILE);
	writeFileSync(marker, `${JSON.stringify({ cwd: workspace })}\n`);
	if (age) backdate(marker, now);
	return dir;
};

test("a project directory is pruned only when its marker aged and its workspace is gone", () => {
	const home = mkdtempSync(join(tmpdir(), "finisher-gc-law-"));
	const now = Date.now();
	const stale = markedDir(home, "stale", goneWorkspace(), { now });
	const keeps = {
		"workspace alive at any age": markedDir(home, "alive", liveWorkspace(), { now }),
		"marker fresh with a dead workspace": markedDir(home, "fresh", goneWorkspace(), { age: false, now }),
		"no marker is never identified": join(home, "foreign"),
	};
	mkdirSync(keeps["no marker is never identified"], { recursive: true });
	writeFileSync(join(home, "not-a-dir"), "x");
	const pruned = pruneProjectDirs(home, "", now);
	assert.equal(pruned, 1, "exactly the aged marker with the dead workspace is pruned");
	assert.equal(existsSync(stale), false, "the stale project is gone");
	for (const [why, dir] of Object.entries(keeps)) assert.ok(existsSync(dir), `${why} must survive`);
	assert.ok(existsSync(join(home, "not-a-dir")), "a plain file is never removed");
});

test("the current project survives even when its record points at a dead workspace", () => {
	const home = mkdtempSync(join(tmpdir(), "finisher-gc-current-"));
	const now = Date.now();
	const dead = goneWorkspace();
	const self = markedDir(home, "self", dead, { now });
	const other = markedDir(home, "other", goneWorkspace(), { now });
	assert.equal(pruneProjectDirs(home, dead, now), 1, "only the non-current stale project is pruned");
	assert.ok(existsSync(self), "the running session's own project is untouchable");
	assert.equal(existsSync(other), false);
	assert.equal(pruneProjectDirs(home, "", now), 1, "without the current-cwd guard the same directory is pruned");
	assert.equal(existsSync(self), false, "the guard alone is what saved it");
});

test("a junk or unreadable marker never identifies a directory, however old it is", () => {
	const home = mkdtempSync(join(tmpdir(), "finisher-gc-junk-"));
	const now = Date.now();
	const junk = { empty: "", "not json": "%%{", "cwd not a string": '{"cwd":42}', "cwd blank": '{"cwd":"   "}' };
	const dirs = Object.entries(junk).map(([name, body]) => {
		const dir = join(home, `junk-${name}`);
		mkdirSync(dir, { recursive: true });
		const marker = join(dir, PROJECT_MARKER_FILE);
		writeFileSync(marker, body);
		backdate(marker, now);
		return dir;
	});
	assert.equal(pruneProjectDirs(home, "", now), 0, "no junk marker ever earns a delete");
	for (const dir of dirs) assert.ok(existsSync(dir));
	assert.equal(pruneProjectDirs(join(home, "no-such-home"), "", now), 0, "a missing home is not an error");
});

test("one pass never prunes more than GC_PRUNE_MAX however many candidates exist", () => {
	const home = mkdtempSync(join(tmpdir(), "finisher-gc-bound-"));
	const now = Date.now();
	const total = GC_PRUNE_MAX + 4;
	for (let i = 0; i < total; i++) markedDir(home, `stale-${i}`, goneWorkspace(), { now });
	assert.equal(pruneProjectDirs(home, "", now), GC_PRUNE_MAX, "the cap holds");
	assert.equal(pruneProjectDirs(home, "", now), total - GC_PRUNE_MAX, "a second pass finishes the rest");
	assert.equal(pruneProjectDirs(home, "", now), 0, "and then the home is clean");
});

test("the session marker round-trips: written by the project key, read back as the resolved workspace", () => {
	const cwd = liveWorkspace();
	const path = writeProjectMarker(cwd);
	assert.equal(path, join(finisherDir(cwd), PROJECT_MARKER_FILE), "the marker lives in the one project directory");
	assert.equal(JSON.parse(readFileSync(path, "utf8")).cwd, resolve(cwd), "the record is the workspace itself");
});
