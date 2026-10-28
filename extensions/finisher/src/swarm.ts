import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";
import { STATE_HOME_LABEL } from "./project-dir.ts";
import { withTimeout } from "./timeout.ts";
import { MAX_EFFORT } from "./budget.ts";

export const SWARM_SLOT_KEYS = ["priority1", "priority2", "priority3", "priority4", "priority5"] as const;
export const SWARM_DEFAULT_CONCURRENCY = 5;
export const SWARM_DEFAULT_MAX_ATTEMPTS = 2;
export const SWARM_MAX_CONCURRENCY = 16;
export const SWARM_MAX_ATTEMPTS = MAX_EFFORT;
export const ATTEMPT_FORWARD_SLACK_MS = 120_000;

export const clampAttempts = (requested: number | undefined): number => {
	const n = Math.floor(Number(requested ?? SWARM_DEFAULT_MAX_ATTEMPTS));
	if (!Number.isFinite(n)) return SWARM_DEFAULT_MAX_ATTEMPTS;
	return Math.max(1, Math.min(n, SWARM_MAX_ATTEMPTS));
};

export interface SwarmSlot {
	id: string;
	model?: string;
	priority: number;
}

export interface SwarmTaskRun {
	ok: boolean;
	output: string;
}

export interface SwarmTask<T = unknown> {
	id: string;
	dependsOn?: string[];
	payload?: T;
}

export interface SwarmAttempt {
	taskId: string;
	slotId: string;
	model?: string;
	attempt: number;
	ok: boolean;
	error?: string;
	queuedMs?: number;
	ms?: number;
}

export interface SwarmResult<T = unknown> {
	id: string;
	ok: boolean;
	output: string;
	slotId?: string;
	model?: string;
	attempts: number;
	failures: SwarmAttempt[];
	blockedBy?: string[];
	queuedMs?: number;
	wallMs?: number;
	payload?: T;
}

export interface SwarmMetrics {
	wallMs: number;
	queueWaitMs: number;
	attemptMs: number;
	coderMs: number;
	reworkCount: number;
	recovered: number;
	blocked: number;
	attempts: number;
}

export const swarmMetrics = (results: SwarmResult[], wallMs: number): SwarmMetrics => {
	const attempts = results.flatMap((r) => r.failures);
	return {
		wallMs,
		queueWaitMs: results.reduce((n, r) => n + (r.queuedMs ?? 0), 0),
		attemptMs: attempts.reduce((n, a) => n + (a.ms ?? 0), 0),
		coderMs: results.reduce((n, r) => n + (r.wallMs ?? 0), 0),
		reworkCount: results.filter((r) => r.attempts > 1).length,
		recovered: results.filter((r) => r.ok && r.attempts > 1).length,
		blocked: results.filter((r) => (r.blockedBy ?? []).length > 0).length,
		attempts: results.reduce((n, r) => n + r.attempts, 0),
	};
};

export const metricsLine = (m: SwarmMetrics): string =>
	`⏱ wall ${Math.round(m.wallMs / 1000)}s · coder ${Math.round(m.coderMs / 1000)}s · wait ${Math.round(m.queueWaitMs / 1000)}s · ${m.attempts} attempt(s) · ${m.reworkCount} reworked${m.recovered ? ` (${m.recovered} recovered)` : ""}${m.blocked ? ` · ${m.blocked} blocked` : ""}`;

export interface SwarmOptions<T = unknown> {
	attemptMs?: number;
	slots: SwarmSlot[];
	concurrency?: number;
	maxAttempts?: number;
	run: (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => Promise<SwarmTaskRun>;
	onAttempt?: (attempt: SwarmAttempt) => void;
}

export const swarmSlots = (patterns: string[]): SwarmSlot[] =>
	patterns
		.map((p) => (typeof p === "string" ? p.trim() : ""))
		.filter(Boolean)
		.map((model, i) => ({ id: `slot${i + 1}`, model, priority: i + 1 }));

export const SWARM_LADDER_MAX = 5;

export const ladderPatterns = (cfg: Record<string, unknown>): string[] => {
	const declared = Array.isArray(cfg.priority) ? cfg.priority : SWARM_SLOT_KEYS.map((k) => cfg[k]);
	const out: string[] = [];
	for (const raw of declared) {
		if (out.length >= SWARM_LADDER_MAX) break;
		if (typeof raw !== "string") continue;
		const model = raw.trim();
		if (!model || out.includes(model)) continue;
		out.push(model);
	}
	return out;
};

const readJsonObject = (file: string): Record<string, unknown> => {
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	} catch {
		return {};
	}
	return {};
};

const readFinisherJson = (cwd: string, name: string): Record<string, unknown> => readJsonObject(join(finisherDir(cwd), name));

export const readModelLadder = (cwd: string): string[] =>
	[...ladderPatterns(readFinisherJson(cwd, "models.json")), ...ladderPatterns(readFinisherJson(cwd, "config.json"))].filter((m, i, all) => all.indexOf(m) === i).slice(0, SWARM_LADDER_MAX);

export const readSwarmConcurrency = (cwd: string, fallback = SWARM_DEFAULT_CONCURRENCY): number => {
	const raw = readFinisherJson(cwd, "config.json").swarmConcurrency;
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), SWARM_MAX_CONCURRENCY);
};

export const concurrencyFor = (cwd: string, slotCount: number, taskCount: number): { concurrency: number; source: "config" | "slots" | "tasks" | "none" } => {
	const configured = readFinisherJson(cwd, "config.json").swarmConcurrency;
	const n = typeof configured === "number" ? configured : typeof configured === "string" ? Number(configured) : NaN;
	const wanted = Number.isFinite(n) && n >= 1 ? Math.floor(n) : SWARM_DEFAULT_CONCURRENCY;
	const capped = clampConcurrency(wanted, slotCount, taskCount);
	if (!capped) return { concurrency: 0, source: "none" };
	if (Number.isFinite(n) && n >= 1) return { concurrency: capped, source: "config" };
	if (slotCount <= taskCount) return { concurrency: capped, source: "slots" };
	return { concurrency: capped, source: "tasks" };
};

export const readyTasks = <T,>(tasks: SwarmTask<T>[], done: Set<string>, started: Set<string>, failed: Set<string>): SwarmTask<T>[] =>
	tasks.filter((t) => !started.has(t.id) && !failed.has(t.id) && (t.dependsOn ?? []).every((d) => done.has(d)));

export const attemptDeadlineMs = (timeoutMs: number, forward = ATTEMPT_FORWARD_SLACK_MS): number => Math.max(1_000, Math.floor(timeoutMs) + forward);

export const clampConcurrency = (requested: number | undefined, slotCount: number, taskCount: number): number => {
	const want = Number.isFinite(requested) ? Number(requested) : SWARM_DEFAULT_CONCURRENCY;
	const ceiling = Math.min(slotCount, taskCount);
	if (ceiling < 1) return 0;
	return Math.max(1, Math.min(Math.floor(want), ceiling, SWARM_MAX_CONCURRENCY));
};

export const effectiveLadder = (cwd: string, fallbackPattern?: string): { ladder: string[]; source: "priority" | "main-model" | "none" } => {
	const ladder = readModelLadder(cwd);
	if (ladder.length) return { ladder, source: "priority" };
	const fallback = fallbackPattern?.trim();
	if (fallback) return { ladder: [fallback], source: "main-model" };
	return { ladder: [], source: "none" };
};

export const swarmSlotsFromConfig = (cwd: string, fallbackPattern?: string): SwarmSlot[] => swarmSlots(effectiveLadder(cwd, fallbackPattern).ladder);

export const orderSlots = (slots: SwarmSlot[]): SwarmSlot[] => [...slots].sort((a, b) => a.priority - b.priority);

export const pickSlot = (slots: SwarmSlot[], tried: string[]): SwarmSlot | undefined => {
	const ordered = orderSlots(slots);
	const fresh = ordered.find((s) => !tried.includes(s.id));
	if (fresh) return fresh;
	if (!ordered.length) return undefined;
	return ordered[tried.length % ordered.length];
};

export const runSwarm = async <T = unknown>(tasks: SwarmTask<T>[], opts: SwarmOptions<T>): Promise<SwarmResult<T>[]> => {
	const slots = orderSlots(opts.slots);
	if (!slots.length) throw new Error("runSwarm: at least one slot is required");
	const maxAttempts = clampAttempts(opts.maxAttempts);
	const results: SwarmResult<T>[] = tasks.map((t) => ({
		id: t.id,
		ok: false,
		output: "",
		attempts: 0,
		failures: [],
		...(t.payload === undefined ? {} : { payload: t.payload }),
	}));
	const workerCount = clampConcurrency(opts.concurrency, slots.length, tasks.length);
	if (!workerCount) return results;
	const done = new Set<string>();
	const started = new Set<string>();
	const failed = new Set<string>();
	const blockDependents = (id: string): void => {
		for (const t of tasks) {
			if (!(t.dependsOn ?? []).includes(id) || started.has(t.id) || failed.has(t.id)) continue;
			failed.add(t.id);
			const r = results[tasks.indexOf(t)];
			r.blockedBy = [...(r.blockedBy ?? []), id];
			r.output = r.output || `not attempted: its dependency "${id}" did not succeed`;
		}
	};
	const attemptTask = async (task: SwarmTask<T>, result: SwarmResult<T>, queuedMs: number): Promise<boolean> => {
		const tried: string[] = [];
		while (result.attempts < maxAttempts) {
			const chosen = pickSlot(slots, tried);
			if (!chosen) return false;
			tried.push(chosen.id);
			result.attempts += 1;
			const attemptNo = result.attempts;
			const attemptStart = Date.now();
			let run: SwarmTaskRun;
			try {
				const attemptRun = opts.run(task, chosen, attemptNo);
				const bounded = opts.attemptMs && opts.attemptMs > 0 ? await withTimeout(attemptRun, opts.attemptMs, `swarm attempt ${task.id}`) : undefined;
				if (bounded?.timedOut) run = { ok: false, output: `the slice did not finish within ${Math.round(bounded.ms / 1000)}s — the attempt was abandoned so the other slices keep their slots` };
				else run = bounded ? bounded.value : await attemptRun;
			} catch (e) {
				run = { ok: false, output: `swarm task threw: ${(e as Error)?.message ?? String(e)}` };
			}
			const attempt: SwarmAttempt = {
				taskId: task.id,
				slotId: chosen.id,
				attempt: attemptNo,
				ok: run.ok,
				queuedMs: attemptNo === 1 ? queuedMs : 0,
				ms: Date.now() - attemptStart,
				...(chosen.model ? { model: chosen.model } : {}),
				...(run.ok ? {} : { error: run.output.slice(0, 500) }),
			};
			opts.onAttempt?.(attempt);
			result.output = run.output;
			if (run.ok) {
				result.ok = true;
				result.slotId = chosen.id;
				if (chosen.model) result.model = chosen.model;
				return true;
			}
			result.failures.push(attempt);
		}
		return false;
	};
	const claim = (task: SwarmTask<T>): void => {
		started.add(task.id);
		results[tasks.indexOf(task)].queuedMs = Date.now() - runStart;
	};
	const settle = (task: SwarmTask<T>, ok: boolean): void => {
		if (ok) {
			done.add(task.id);
			return;
		}
		failed.add(task.id);
		for (const t of tasks) {
			if (!(t.dependsOn ?? []).includes(task.id) || started.has(t.id) || failed.has(t.id)) continue;
			const r = results[tasks.indexOf(t)];
			r.blockedBy = [...new Set([...(r.blockedBy ?? []), task.id])];
			r.output = r.output || `not attempted: its dependency "${task.id}" did not succeed`;
		}
	};
	const runStart = Date.now();
	const inFlight = new Set<Promise<void>>();
	for (;;) {
		const ready = readyTasks(tasks, done, started, failed);
		for (const task of ready) {
			if (inFlight.size >= workerCount) break;
			const claimedAt = Date.now();
			claim(task);
			const run = attemptTask(task, results[tasks.indexOf(task)], claimedAt - runStart)
				.then((ok) => {
					results[tasks.indexOf(task)].wallMs = Date.now() - claimedAt;
					settle(task, ok);
				})
				.finally(() => {
					inFlight.delete(run);
				});
			inFlight.add(run);
		}
		if (!inFlight.size) break;
		await Promise.race(inFlight);
	}
	for (const t of tasks) {
		if (done.has(t.id) || failed.has(t.id)) continue;
		const unmet = (t.dependsOn ?? []).filter((d) => !done.has(d));
		const r = results[tasks.indexOf(t)];
		failed.add(t.id);
		if (unmet.length) r.blockedBy = unmet;
		r.output = r.output || (unmet.length ? `not attempted: dependency ${unmet.join(", ")} never completed` : "not attempted: no worker could claim it");
	}
	return results;
};

export const swarmSummaryLine = (results: SwarmResult[]): string => {
	const ok = results.filter((r) => r.ok).length;
	const models = [...new Set(results.filter((r) => r.model).map((r) => r.model as string))];
	return `${ok}/${results.length} task(s) ok${models.length ? ` · models: ${models.join(", ")}` : ""}`;
};

export const SWARM_ROUTING_GUIDELINE = [
	"Parallelism is your default, not a last resort: when a goal needs several independent reads (survey the repo, compare options, locate code) or several independent proofs, call code instead of serialising the work through yourself.",
	"A fan-out report IS the evidence: act on its findings instead of re-reading what a worker already read or re-running what it already ran, and open a file yourself only when the report names a gap.",
	`The CODERS run the configured model ladder (priority1..priority5 in ${STATE_HOME_LABEL}/models.json) at the same time — use every slot the config offers, and never ask the human which model to use.`,
	"Never spawn a lone CODER: fewer than two slices is refused, because a CODER is only worth its cost when at least two run side by side. If the work does not split into two independent slices, do the slice yourself instead of calling code.",
	"While the CODERS run you code your own slice IN THE SAME TURN — your own edits and commands in the same tool block as the fan-out — and you never sit idle waiting for them: main works alongside the coders, then finishes its own slice when their reports come back.",
	"When a command already proves a case, name that command and never run an equivalent again: a script that already passed is evidence, not work to repeat.",
	"A goal is only done when verify proves every case from commands the harness recorded; on FAIL work the fix laps the harness appends, then verify again, reporting only at the end.",
	"The workflow is fixed: goal confirms once, lap declares the plan, one lap done per lap in order, then verify exactly once — verify is gated on every lap being closed.",
	"code is coders only: you explore and plan yourself, and you verify with verify. Never spawn a sub-agent to read or to judge for you.",
].join("\n");
