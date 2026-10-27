import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { finisherDir } from "./types.ts";
import { allLapsDone, lapIndex, planOf, totalPhases, type PhasePlan } from "./goal-phase.ts";
import { type GoalRunState } from "./goal-driver.ts";

export const TRACKER_FILE = "tracker.jsonl";
export const TRACKER_SESSIONS_MAX = 8;
export const TRACKER_RECORDS_MAX = 64;
export const TRACKER_SESSION_MAX = 48;
export const TRACKER_UNKNOWN_SESSION = "unknown";
export const TRACKER_GOAL_MAX = 160;
export const TRACKER_STEP_MAX = 100;
export const TRACKER_CASE_MAX = 80;
export const TRACKER_COMMAND_MAX = 80;
export const TRACKER_STEPS_MAX = 10;
export const TRACKER_NEXT_MAX = 2;
export const TRACKER_CASES_PER_LINE = 2;
export const TRACKER_EVIDENCE_MAX = 5;
export const TRACKER_RENDER_MAX = 1_200;

export type StepState = "done" | "current" | "todo";

export interface TrackerStep {
	id: string;
	text: string;
	state: StepState;
}

export interface TrackerEvidence {
	command: string;
	ok: boolean;
}

export interface LapTracker {
	at: number;
	session: string;
	goal: string;
	round: number;
	lap: number;
	laps: number;
	done: number;
	steps: TrackerStep[];
	current?: TrackerStep;
	next: TrackerStep[];
	cases: string[];
	evidence: TrackerEvidence[];
}

export const clipTrackerText = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

const sessionToken = (sessionId: string): string => {
	const flat = sessionId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return flat ? flat.slice(0, TRACKER_SESSION_MAX) : TRACKER_UNKNOWN_SESSION;
};

const sessionDigest = (sessionId: string): string => createHash("sha1").update(sessionId).digest("hex").slice(0, 8);

export const sessionDirKey = (sessionId = ""): string => {
	const raw = sessionId.trim();
	return `${sessionToken(raw)}-${sessionDigest(raw)}`;
};

export const trackerDir = (cwd: string, sessionId = ""): string => join(finisherDir(cwd), sessionDirKey(sessionId));

export const trackerPath = (cwd: string, sessionId = ""): string => join(trackerDir(cwd, sessionId), TRACKER_FILE);

export const stepStateOf = (plan: PhasePlan, index: number): StepState => {
	const position = index + 1;
	if (position < plan.lap) return "done";
	if (position === plan.lap && !allLapsDone(plan)) return "current";
	return "todo";
};

export const stepsOf = (plan: PhasePlan): TrackerStep[] =>
	plan.phases.map((p, i) => ({ id: p.id, text: clipTrackerText(p.text, TRACKER_STEP_MAX), state: stepStateOf(plan, i) }));

export const trackerEvidence = (calls: { command: string; ok: boolean }[], cap = TRACKER_EVIDENCE_MAX): TrackerEvidence[] => {
	const last = new Map<string, TrackerEvidence>();
	for (const call of calls) {
		const command = call.command.replace(/\s+/g, " ").trim();
		if (!command) continue;
		last.delete(command);
		last.set(command, { command: clipTrackerText(command, TRACKER_COMMAND_MAX), ok: call.ok !== false });
	}
	return [...last.values()].slice(-cap);
};

export const lapNumberOf = (plan: PhasePlan): number => {
	const laps = totalPhases(plan);
	if (!laps) return 0;
	return allLapsDone(plan) ? laps : lapIndex(plan);
};

export const buildLapTracker = (
	goal: GoalRunState | undefined,
	evidence: { command: string; ok: boolean }[] = [],
	at = Date.now(),
	sessionId = "",
): LapTracker | undefined => {
	if (!goal) return undefined;
	const plan = planOf(goal);
	const steps = stepsOf(plan);
	const active = steps.findIndex((s) => s.state === "current");
	const afterActive = active < 0 ? steps.length : active + 1;
	return {
		at,
		session: sessionId,
		goal: goal.goal.trim(),
		round: goal.attempts?.rounds ?? 0,
		lap: lapNumberOf(plan),
		laps: totalPhases(plan),
		done: steps.filter((s) => s.state === "done").length,
		steps,
		...(active < 0 ? {} : { current: steps[active] }),
		next: steps.slice(afterActive, afterActive + TRACKER_NEXT_MAX),
		cases: [...(goal.cases ?? [])],
		evidence: trackerEvidence(evidence),
	};
};

export const stepWindow = (steps: TrackerStep[], size = TRACKER_STEPS_MAX): { from: number; to: number } => {
	if (steps.length <= size) return { from: 0, to: steps.length };
	const active = steps.findIndex((s) => s.state === "current");
	const at = active < 0 ? steps.length - 1 : active;
	const from = Math.max(0, Math.min(steps.length - size, at - Math.floor(size / 2)));
	return { from, to: Math.min(steps.length, from + size) };
};

const stepMark = (state: StepState): string => (state === "done" ? "✓" : state === "current" ? "▶" : "·");

export const trackerLines = (t: LapTracker): { core: string[]; extra: string[] } => {
	const where = t.laps
		? `where: lap ${Math.max(1, t.lap)}/${t.laps}${t.done ? ` — ${t.done} closed` : ""}`
		: "where: no plan declared yet";
	const core = [
		`[finisher lap tracker] goal: ${clipTrackerText(t.goal, TRACKER_GOAL_MAX)}`,
		where,
		...(t.current ? [`now: ${t.current.text}`] : []),
		...(t.next.length ? [`then: ${t.next.map((s) => s.text).join(" | ")}`] : []),
	];
	const { from, to } = stepWindow(t.steps);
	const extra: string[] = [];
	if (t.steps.length)
		extra.push(from > 0 ? `plan: …${from} lap(s) already behind` : "plan:", ...t.steps.slice(from, to).map((s, i) => `  ${stepMark(s.state)} ${from + i + 1}. ${s.text}`), ...(to < t.steps.length ? [`  …${t.steps.length - to} lap(s) after`] : []));
	if (t.cases.length) extra.push(...caseLines(t.cases.map((c) => clipTrackerText(c, TRACKER_CASE_MAX))));
	if (t.evidence.length) extra.push(`evidence: ${t.evidence.map((e) => `${e.command} ${e.ok ? "exit 0" : "failed"}`).join(" | ")}`);
	return { core, extra };
};

const caseLines = (cases: string[]): string[] => {
	const lines: string[] = [];
	for (let i = 0; i < cases.length; i += TRACKER_CASES_PER_LINE) {
		const chunk = cases.slice(i, i + TRACKER_CASES_PER_LINE).join(" | ");
		lines.push(i === 0 ? `cases: ${chunk}` : `       ${chunk}`);
	}
	return lines;
};

const pack = (lines: string[], budget: number): string[] => {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget) break;
		out.push(line);
		used += line.length + 1;
	}
	return out;
};

export const renderLapTracker = (t: LapTracker, budget = TRACKER_RENDER_MAX): string => {
	const { core, extra } = trackerLines(t);
	const kept = pack(core, budget);
	const used = kept.reduce((sum, line) => sum + line.length + 1, 0);
	return [...kept, ...pack(extra, budget - used)].join("\n");
};

const trackerFrom = (raw: Partial<LapTracker>): LapTracker | undefined => {
	if (typeof raw.goal !== "string" || !Array.isArray(raw.steps)) return undefined;
	return {
		at: typeof raw.at === "number" ? raw.at : 0,
		session: typeof raw.session === "string" ? raw.session : "",
		goal: raw.goal,
		round: typeof raw.round === "number" ? raw.round : 0,
		lap: typeof raw.lap === "number" ? raw.lap : 0,
		laps: typeof raw.laps === "number" ? raw.laps : 0,
		done: typeof raw.done === "number" ? raw.done : 0,
		steps: raw.steps.filter((s) => s && typeof s.id === "string" && typeof s.text === "string" && typeof s.state === "string"),
		...(raw.current && typeof raw.current.text === "string" ? { current: raw.current } : {}),
		next: Array.isArray(raw.next) ? raw.next.filter((s) => s && typeof s.text === "string") : [],
		cases: Array.isArray(raw.cases) ? raw.cases.filter((c) => typeof c === "string") : [],
		evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e) => e && typeof e.command === "string").map((e) => ({ command: e.command, ok: e.ok !== false })) : [],
	};
};

export const trackerRecords = (raw: string, cap = TRACKER_RECORDS_MAX): string[] => {
	const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
	return cap > 0 ? lines.slice(Math.max(0, lines.length - cap)) : lines;
};

export const lastTrackerRecord = (raw: string): LapTracker | undefined => {
	const lines = trackerRecords(raw);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const tracker = trackerFrom(JSON.parse(lines[i]) as Partial<LapTracker>);
			if (tracker) return tracker;
		} catch {}
	}
	return undefined;
};

export const readLapTrackerFile = (path: string): LapTracker | undefined => {
	if (!existsSync(path)) return undefined;
	try {
		return lastTrackerRecord(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
};

export const readLapTracker = (cwd: string, sessionId = ""): LapTracker | undefined => readLapTrackerFile(trackerPath(cwd, sessionId));

export const trackerForSession = (
	cwd: string,
	sessionId: string,
	goal: GoalRunState | undefined,
	evidence: { command: string; ok: boolean }[] = [],
	at = Date.now(),
): LapTracker | undefined => {
	const live = buildLapTracker(goal, evidence, at, sessionId);
	const stored = readLapTracker(cwd, sessionId);
	if (!stored || !live) return live ?? stored;
	if (stored.goal !== live.goal) return live;
	if (live.steps.length) return live;
	return stored;
};

export const clearLapTracker = (cwd: string, sessionId = ""): boolean => {
	try {
		rmSync(trackerDir(cwd, sessionId), { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
};

export const isSessionDirName = (name: string): boolean => /^[a-z0-9_-]{1,48}-[0-9a-f]{8}$/.test(name);

export const sessionTrackers = (cwd: string): { path: string; at: number }[] => {
	const root = finisherDir(cwd);
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && isSessionDirName(String(entry.name)))
			.map((entry) => {
				const path = join(root, String(entry.name));
				try {
					return { path, at: statSync(join(path, TRACKER_FILE)).mtimeMs };
				} catch {
					return { path, at: 0 };
				}
			})
			.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
	} catch {
		return [];
	}
};

export const pruneTrackers = (cwd: string, keep = TRACKER_SESSIONS_MAX): number => {
	const files = sessionTrackers(cwd);
	let pruned = 0;
	for (const old of files.slice(Math.max(0, keep))) {
		try {
			rmSync(old.path, { recursive: true, force: true });
			pruned++;
		} catch {}
	}
	return pruned;
};

let tmpSeq = 0;

const trackerTempPath = (path: string): string => {
	tmpSeq += 1;
	return join(dirname(path), `${basename(path)}.${process.pid}.${tmpSeq}.tmp`);
};

export const trackerAppend = (existing: string, tracker: LapTracker, cap = TRACKER_RECORDS_MAX): string => {
	const line = JSON.stringify(tracker);
	const kept = trackerRecords(existing, cap > 0 ? cap - 1 : 0);
	return `${[...kept, line].join("\n")}\n`;
};

export const writeLapTracker = (
	cwd: string,
	sessionId: string,
	goal: GoalRunState | undefined,
	evidence: { command: string; ok: boolean }[] = [],
	at = Date.now(),
): string | undefined => {
	const path = trackerPath(cwd, sessionId);
	const tracker = buildLapTracker(goal, evidence, at, sessionId);
	if (!tracker || goal?.doneAt) {
		clearLapTracker(cwd, sessionId);
		pruneTrackers(cwd);
		return undefined;
	}
	const tmp = trackerTempPath(path);
	try {
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, trackerAppend(existing, tracker));
		renameSync(tmp, path);
	} catch {
		rmSync(tmp, { force: true });
		return undefined;
	}
	pruneTrackers(cwd);
	return path;
};
