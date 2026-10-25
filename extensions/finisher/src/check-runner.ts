import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const PLAN_DEFAULT_TIMEOUT_MS = 120_000;
export const PLAN_DEFAULT_CONCURRENCY = 4;
export const PLAN_OUTPUT_MAX = 4000;

export const PLAN_INFRA_MARKERS: readonly string[] = [
	"command not found",
	"enoent",
	"cannot find module",
	"no such file or directory",
	"is not recognized as an internal or external command",
	"permission denied",
	"not found in path",
];

export interface PlanTask {
	id: string;
	command: string;
	args?: string[];
	paths?: string[];
}

export type PlanStatus = "pass" | "fail" | "infra" | "deadline";

export interface PlanResult {
	id: string;
	command: string;
	status: PlanStatus;
	exitCode: number;
	output: string;
	ms: number;
	cached: boolean;
}

export const isInfraOutput = (output: string): boolean => {
	const text = String(output ?? "").toLowerCase();
	return PLAN_INFRA_MARKERS.some((marker) => text.includes(marker));
};

export type PlanRunner = (task: PlanTask, timeoutMs: number) => Promise<{ exitCode: number; output: string; timedOut?: boolean }>;

export const statusOf = (r: { exitCode: number; output: string; timedOut?: boolean }): PlanStatus => {
	if (r.timedOut) return "deadline";
	if (r.exitCode === 0) return "pass";
	return isInfraOutput(r.output) ? "infra" : "fail";
};

export const planBroke = (results: PlanResult[]): boolean => (Array.isArray(results) ? results : []).some((r) => r?.status === "fail");

const clampTimeout = (ms: number | undefined): number => (Number.isFinite(ms) ? Math.max(1_000, Math.floor(ms as number)) : PLAN_DEFAULT_TIMEOUT_MS);

const execFileAsync = promisify(execFile);

const tail = (text: string): string => (text.length <= PLAN_OUTPUT_MAX ? text : text.slice(text.length - PLAN_OUTPUT_MAX));

export const processRunner = (cwd: string): PlanRunner =>
	async (task, timeoutMs) => {
		try {
			const result = await execFileAsync(task.command, task.args ?? [], {
				cwd,
				timeout: clampTimeout(timeoutMs),
				maxBuffer: 8 * 1024 * 1024,
				encoding: "utf8",
			});
			return { exitCode: 0, output: tail(`${result.stdout ?? ""}${result.stderr ?? ""}`) };
		} catch (err) {
			const e = err as { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
			const stdout = typeof e?.stdout === "string" ? e.stdout : "";
			const stderr = typeof e?.stderr === "string" ? e.stderr : "";
			const timedOut = e?.killed === true || e?.signal === "SIGTERM";
			const exitCode = timedOut ? 124 : typeof e?.code === "number" ? e.code : 1;
			const output = tail(`${stdout}${stderr}`);
			return { exitCode, output: output || String(e?.message ?? ""), ...(timedOut ? { timedOut: true } : {}) };
		}
	};

const norm = (path: string): string => String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();

const covers = (taskPath: string, changedPath: string): boolean =>
	changedPath === taskPath || changedPath.startsWith(`${taskPath}/`) || taskPath.startsWith(`${changedPath}/`);

export const scopedPlan = (tasks: PlanTask[], changed: string[]): PlanTask[] => {
	const list = Array.isArray(tasks) ? tasks : [];
	const touched = (Array.isArray(changed) ? changed : []).map(norm).filter(Boolean);
	if (!touched.length) return [...list];
	return list.filter((task) => {
		const paths = (task.paths ?? []).map(norm).filter(Boolean);
		if (!paths.length) return true;
		return touched.some((c) => paths.some((p) => covers(p, c)));
	});
};

export const planKey = (task: PlanTask): string => `${task.command} ${(task.args ?? []).join(" ")}`.trim();

export const cacheKeyOf = (task: PlanTask, fingerprint: string): string => `${planKey(task)}@${String(fingerprint ?? "")}`;

export interface PlanOptions {
	cwd?: string;
	timeoutMs?: number;
	concurrency?: number;
	fingerprint?: string;
	run?: PlanRunner;
	cache?: Map<string, PlanResult>;
	changed?: string[];
}

export const runPlan = async (tasks: PlanTask[], opts: PlanOptions = {}): Promise<PlanResult[]> => {
	const plan = scopedPlan(tasks, opts.changed ?? []);
	if (!plan.length) return [];
	const run = opts.run ?? processRunner(opts.cwd ?? process.cwd());
	const timeoutMs = clampTimeout(opts.timeoutMs);
	const cache = opts.cache;
	const fingerprint = opts.fingerprint;
	const limit = Math.min(plan.length, Math.max(1, Math.floor(Number.isFinite(opts.concurrency) ? (opts.concurrency as number) : PLAN_DEFAULT_CONCURRENCY)));
	const results: PlanResult[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const at = next++;
			if (at >= plan.length) return;
			const task = plan[at];
			const key = fingerprint === undefined ? "" : cacheKeyOf(task, fingerprint);
			const hit = cache && fingerprint !== undefined ? cache.get(key) : undefined;
			if (hit) {
				results[at] = { ...hit, cached: true };
				continue;
			}
			const started = Date.now();
			const raw = await run(task, timeoutMs).catch(
				(err: unknown): { exitCode: number; output: string; timedOut?: boolean } => ({ exitCode: 1, output: String((err as Error)?.message ?? err) }),
			);
			const result: PlanResult = {
				id: task.id,
				command: planKey(task),
				status: statusOf(raw),
				exitCode: raw.timedOut ? 124 : raw.exitCode,
				output: tail(String(raw.output ?? "")),
				ms: Date.now() - started,
				cached: false,
			};
			if (cache && fingerprint !== undefined) cache.set(key, { ...result });
			results[at] = result;
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));
	return plan.map((task, at) => results[at] ?? { id: task.id, command: planKey(task), status: "fail" as const, exitCode: 1, output: "", ms: 0, cached: false });
};

const MARK_OF: Record<PlanStatus, string> = { pass: "PASS", fail: "FAIL", infra: "SKIP", deadline: "TIMEOUT" };

export const planLines = (results: PlanResult[]): string[] =>
	(Array.isArray(results) ? results : []).map((r) => `${MARK_OF[r.status] ?? "SKIP"}  ${r.command}  ${Math.max(0, Math.floor(r.ms))}ms`);
