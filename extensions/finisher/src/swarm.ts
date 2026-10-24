import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";
import { declaredVerdict } from "./evidence.ts";

export const SWARM_SLOT_KEYS = ["priority1", "priority2", "priority3", "priority4", "priority5"] as const;
export const SWARM_DEFAULT_CONCURRENCY = 5;
export const SWARM_DEFAULT_MAX_ATTEMPTS = 2;
export const SWARM_MAX_CONCURRENCY = 16;

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
	payload?: T;
}

export interface SwarmAttempt {
	taskId: string;
	slotId: string;
	model?: string;
	attempt: number;
	ok: boolean;
	error?: string;
}

export interface SwarmResult<T = unknown> {
	id: string;
	ok: boolean;
	output: string;
	slotId?: string;
	model?: string;
	attempts: number;
	failures: SwarmAttempt[];
	payload?: T;
}

export interface SwarmOptions<T = unknown> {
	slots: SwarmSlot[];
	concurrency?: number;
	maxAttempts?: number;
	run: (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => Promise<SwarmTaskRun>;
	onAttempt?: (attempt: SwarmAttempt) => void;
	stopOnDeclaredAnswer?: boolean;
}

export const decisiveAnswer = (output: string): boolean => {
	const verdict = declaredVerdict(output);
	return verdict === "FAIL" || verdict === "UNVERIFIED";
};

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
	const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? SWARM_DEFAULT_MAX_ATTEMPTS));
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
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			const task = tasks[index];
			if (!task) return;
			const result = results[index];
			const tried: string[] = [];
			while (result.attempts < maxAttempts) {
				const slot = pickSlot(slots, tried);
				if (!slot) return;
				tried.push(slot.id);
				result.attempts += 1;
				const attemptNo = result.attempts;
				let run: SwarmTaskRun;
				try {
					run = await opts.run(task, slot, attemptNo);
				} catch (e) {
					run = { ok: false, output: `swarm task threw: ${(e as Error)?.message ?? String(e)}` };
				}
				const attempt: SwarmAttempt = {
					taskId: task.id,
					slotId: slot.id,
					attempt: attemptNo,
					ok: run.ok,
					...(slot.model ? { model: slot.model } : {}),
					...(run.ok ? {} : { error: run.output.slice(0, 500) }),
				};
				opts.onAttempt?.(attempt);
				result.output = run.output;
				if (run.ok) {
					result.ok = true;
					result.slotId = slot.id;
					if (slot.model) result.model = slot.model;
					break;
				}
				result.failures.push(attempt);
				if (opts.stopOnDeclaredAnswer && decisiveAnswer(run.output)) break;
			}
		}
	};
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
};

export const swarmSummaryLine = (results: SwarmResult[]): string => {
	const ok = results.filter((r) => r.ok).length;
	const models = [...new Set(results.filter((r) => r.model).map((r) => r.model as string))];
	return `${ok}/${results.length} task(s) ok${models.length ? ` · models: ${models.join(", ")}` : ""}`;
};

export const fanOutPrompt = (instruction: string, taskId: string): string =>
	[
		`You are swarm worker ${taskId} in a parallel read-only fan-out.`,
		"Do only the assigned slice; other workers handle the rest at the same time.",
		"Do not write or edit files. Answer with concrete findings only, no preamble.",
		"",
		instruction,
	].join("\n");

export const SWARM_ROUTING_GUIDELINE = [
	"Parallelism is your default, not a last resort: when a goal needs several independent reads (survey the repo, compare options, locate code) or several independent proofs, call finisher_swarm instead of serialising the work through yourself.",
	"A fan-out report IS the evidence: act on its findings instead of re-reading what a worker already read or re-running what it already ran, and open a file yourself only when the report names a gap.",
	"The swarm runs the configured model ladder (priority1..priority5 in .finisher/models.json) at the same time — use every slot the config offers, and never ask the human which model to use.",
	"A goal is only done when finisher_swarm verify returns VERDICT: PASS for it; on FAIL work the fix laps the harness appends, then verify again, reporting only at the end.",
	"The workflow is fixed: finisher_goal confirms once, finisher_phase declares the plan, one finisher_phase done per lap in order, then finisher_swarm mode=verify exactly once — verify is gated on every lap being closed.",
].join("\n");

export interface FanOutArgs {
	mode: "explore" | "verify";
	subtasks: { id: string; instruction: string }[];
	goal?: string;
	boundHint?: string;
}

export const buildFanOutPrompt = (args: FanOutArgs, subtask: { id: string; instruction: string }, attempt: number): string => {
	const retry = attempt > 1 ? `\n(retry ${attempt}: your previous answer was unusable — be concrete and complete)` : "";
	if (args.mode === "verify")
		return [
			`You are swarm verifier ${subtask.id}. This runs ONCE, at the end.`,
			"",
			`GOAL (the point of the whole run): ${args.goal ?? "(goal supplied by the main agent)"}`,
			`CASE (the one result you judge): ${subtask.instruction}`,
			"DESIRED RESULT: the case is true only if the change makes it observably true for a human reading your output. Not plausible, not plausible-looking — observable.",
			"",
			"DO THIS, IN THIS ORDER, AND NOTHING ELSE:",
			"  1. Read the change once: `git diff --stat` then the diff of the files your case names. Do not open modules the diff already shows.",
			`  2. Write the smallest command that makes the desired result visible, and run it — a temp script, a node -e, a single file run.${args.boundHint ? ` If it can hang, ${args.boundHint}.` : ""}`,
			"  3. Make that command pass. If your own probe was wrong, fix the probe and run it again.",
			"  4. Put your commands in an evidence block: a line reading exactly `EVIDENCE:`, then one command per line STARTING AT COLUMN 0 with its own exit status (`$ node probe.mjs \u2192 exit 0`); indent its output under it. Nothing outside that block is read as evidence; inside it only a column-0 command line counts, and an indented line is read as its output.",
			"",
			"Then call finisher_verdict with your judgement — that record, plus the commands the harness itself watched you run, is the whole decision. PASS needs a command that succeeded and none that failed. If the desired result does not hold, record FAIL and name the single thing that is missing. If it cannot be exercised from a command, record UNVERIFIED.",
			"Rules: never edit files; never fake a pass; a green suite is not proof — do not run the test suite or a build as your evidence.",
			"If the case genuinely cannot be exercised from a command, run NOTHING else and answer exactly: VERDICT: UNVERIFIED — then one line naming what a human must test by hand.",
			"Evidence: you no longer report exit statuses — the harness records every command you run and its real status, and judges your verdict against that recording. So make the command you rely on actually exit 0 before you record PASS; a re-run of the same command is fine, its last status is what counts.",
			"Never write into the repo: the harness refuses file edits from a verifier and treats a changed working tree as a wasted run. Put scratch files outside the repo.",
			"Last line, exactly one of: VERDICT: PASS | VERDICT: FAIL | VERDICT: UNVERIFIED, then the reason on the same or the next line.",
			retry,
		].join("\n");
	return [
		`You are swarm explorer ${subtask.id}. GOAL: ${args.goal ?? "(goal supplied by the main agent)"}`,
		"Explore only your slice and report what the main agent needs: files with line ranges, how it works today, what must change, and any risk.",
		"Never edit files. No preamble, no restating the goal — findings only.",
		retry,
		"",
		`Your slice (${subtask.id}): ${subtask.instruction}`,
	].join("\n");
};
