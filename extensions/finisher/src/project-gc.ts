import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { finisherDir, finisherHome } from "./project-dir.ts";

export const PROJECT_MARKER_FILE = "project.json";
export const GC_MARKER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const GC_DIRS_SCAN_MAX = 400;
export const GC_PRUNE_MAX = 16;
export const GC_BUDGET_MS = 250;

const markerPath = (dir: string): string => join(dir, PROJECT_MARKER_FILE);

export const writeProjectMarker = (cwd: string): string | undefined => {
	const dir = finisherDir(cwd);
	const path = markerPath(dir);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${JSON.stringify({ cwd: resolve(cwd) })}\n`);
		return path;
	} catch {
		return undefined;
	}
};

const markerWorkspace = (dir: string): string | undefined => {
	let raw: string;
	try {
		raw = readFileSync(markerPath(dir), "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { cwd?: unknown };
		return typeof parsed.cwd === "string" && parsed.cwd.trim() ? resolve(parsed.cwd) : undefined;
	} catch {
		return undefined;
	}
};

const aged = (dir: string, now: number): boolean => {
	try {
		return now - statSync(markerPath(dir)).mtimeMs >= GC_MARKER_AGE_MS;
	} catch {
		return false;
	}
};

export const pruneProjectDirs = (home: string = finisherHome(), currentCwd = "", now = Date.now()): number => {
	const deadline = now + GC_BUDGET_MS;
	const current = currentCwd.trim() ? resolve(currentCwd) : "";
	let entries: Dirent[];
	try {
		entries = readdirSync(home, { withFileTypes: true });
	} catch {
		return 0;
	}
	let pruned = 0;
	let scanned = 0;
	for (const entry of entries) {
		if (scanned >= GC_DIRS_SCAN_MAX || pruned >= GC_PRUNE_MAX || Date.now() > deadline) break;
		if (!entry.isDirectory()) continue;
		scanned += 1;
		const dir = join(home, String(entry.name));
		const workspace = markerWorkspace(dir);
		if (!workspace) continue;
		if (current && workspace === current) continue;
		if (!aged(dir, now)) continue;
		if (existsSync(workspace)) continue;
		try {
			lstatSync(dir);
			rmSync(dir, { recursive: true, force: true });
			pruned += 1;
		} catch {}
	}
	return pruned;
};
