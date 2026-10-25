import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_DEFAULT_CONCURRENCY, type PlanResult, type PlanRunner, type PlanStatus, type PlanTask, runPlan, scopedPlan, statusOf } from "./check-runner.ts";
import { normalizeCommand, type RecordedCall } from "./evidence-record.ts";
import { gitOk } from "./worktree.ts";

export const CHECK_ORDER = ["typecheck", "lint", "test"] as const;

export const CHECK_SCRIPT_PATHS_MAX = 8;

export const CHECK_CACHE_MAX = 240;

export interface DeterministicCheck {
	name: string;
	command: string;
	args: string[];
}

export type CheckOutcome = PlanStatus | "scoped";

export interface CheckResult {
	name: string;
	command: string;
	exitCode: number;
	tail: string;
	status?: CheckOutcome;
	ms?: number;
	cached?: boolean;
}

export const detectChecks = (pkg: { scripts?: Record<string, unknown> } | undefined): DeterministicCheck[] => {
	const scripts = pkg?.scripts ?? {};
	const found: DeterministicCheck[] = [];
	for (const name of CHECK_ORDER) {
		const body = scripts[name];
		if (typeof body !== "string" || !body.trim()) continue;
		found.push({ name, command: "npm", args: ["run", "--silent", name] });
	}
	return found;
};

export const readPackage = (cwd: string): { scripts?: Record<string, unknown> } | undefined => {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> };
	} catch {
		return undefined;
	}
};

const PATH_TOKEN = /[^\s"'`=]+/g;
const PATH_EXT = /\.(?:ts|tsx|js|mjs|cjs|jsx|json|sh|py)$/i;

const topSegment = (token: string): string | undefined => {
	const clean = token.replace(/^\.\//, "").replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");
	if (!clean || clean.startsWith("-") || clean.startsWith("@") || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return undefined;
	if (!clean.includes("/") && !PATH_EXT.test(clean)) return undefined;
	const head = clean.split("/")[0];
	if (!head || head === "." || head === ".." || head === "node_modules" || head.includes("$")) return undefined;
	return head;
};

export const scriptPaths = (body: string): string[] => {
	const out: string[] = [];
	for (const token of String(body ?? "").match(PATH_TOKEN) ?? []) {
		const head = topSegment(token);
		if (!head || out.includes(head)) continue;
		out.push(head);
	}
	return out.slice(0, CHECK_SCRIPT_PATHS_MAX);
};

export const checkTask = (check: DeterministicCheck, pkg?: { scripts?: Record<string, unknown> }): PlanTask => {
	const body = pkg?.scripts?.[check.name];
	const derived = scriptPaths(typeof body === "string" ? body : "");
	const paths = derived.length ? [...new Set([...derived, "package.json"])] : [];
	return { id: check.name, command: check.command, args: check.args, ...(paths.length ? { paths } : {}) };
};

export const checkTasks = (checks: DeterministicCheck[], pkg?: { scripts?: Record<string, unknown> }): PlanTask[] =>
	(Array.isArray(checks) ? checks : []).map((check) => checkTask(check, pkg));

const CHANGE_IGNORED = /^(?:\.finisher\/|\.git\/|node_modules\/|dist\/|build\/)/;

const statusLinePaths = (line: string): string[] => {
	const body = line.length > 3 ? line.slice(3).trim() : "";
	if (!body) return [];
	const pair = body.includes(" -> ") ? body.split(" -> ") : [body];
	return pair.map((p) => p.trim().replace(/^"|"$/g, "").replace(/\\/g, "/")).filter(Boolean);
};

export const changedPaths = (cwd: string): string[] => {
	const result = gitOk(["status", "--porcelain", "--untracked-files=all"], cwd);
	if (!result.ok) return [];
	const out: string[] = [];
	for (const line of result.out.split(/\r?\n/))
		for (const path of statusLinePaths(line)) if (!CHANGE_IGNORED.test(path) && !out.includes(path)) out.push(path);
	return out;
};

const fresh = (call: RecordedCall, after?: number): boolean => !Number.isFinite(after) || call.at === undefined || call.at >= (after as number);

export const freshCalls = (calls: RecordedCall[], after?: number): RecordedCall[] => (Array.isArray(calls) ? calls : []).filter((call) => fresh(call, after));

const checkCommandForms = (name: string): string[] => [`npm run --silent ${name}`, `npm run ${name}`, ...(name === "test" ? ["npm test"] : [])];

export const recordedCheckOk = (calls: RecordedCall[], check: DeterministicCheck, after?: number): boolean => {
	const wanted = new Set(checkCommandForms(check.name).map(normalizeCommand));
	return freshCalls(calls, after).some((call) => call.ok && wanted.has(normalizeCommand(call.command)));
};

const checkCache = new Map<string, PlanResult>();

const WRITE_TOOL = /^(?:write|edit|multi_edit|apply_patch|patch|str_replace_editor|create_file)$/;

const WRITE_COMMAND = /(?:^|[\s;&|])(?:sed\s+-i|tee\b|mv\b|cp\b|rm\b|touch\b|mkdir\b|patch\b|git\s+apply\b|npm\s+(?:i|install|ci)\b)|(?<![0-9&])>{1,2}\s*(?!&|\/dev\/null)([^\s&|<>]+)/;

export const writesFiles = (toolName: string, input?: { command?: unknown }): boolean => {
	const name = String(toolName ?? "").trim().toLowerCase();
	if (WRITE_TOOL.test(name)) return true;
	if (name !== "bash" && name !== "powershell") return false;
	const command = typeof input?.command === "string" ? input.command : "";
	return WRITE_COMMAND.test(command);
};

export const clearCheckCache = (): void => {
	checkCache.clear();
};

const cacheFor = (): Map<string, PlanResult> => {
	if (checkCache.size > CHECK_CACHE_MAX) checkCache.clear();
	return checkCache;
};

const label = (check: DeterministicCheck): string => `${check.command} ${check.args.join(" ")}`;

export interface CheckStageOptions {
	cwd: string;
	timeoutMs: number;
	lastModifiedAt?: number;
	changed?: string[];
	calls?: RecordedCall[];
	pkg?: { scripts?: Record<string, unknown> };
	concurrency?: number;
	run?: PlanRunner;
}

export interface CheckStage {
	results: CheckResult[];
	ran: PlanResult[];
	recorded: string[];
	scoped: string[];
}

export const checkFingerprint = (cwd: string, lastModifiedAt?: number): string => `${cwd}@${Number.isFinite(lastModifiedAt) ? lastModifiedAt : 0}`;

export const runCheckStage = async (checks: DeterministicCheck[], opts: CheckStageOptions): Promise<CheckStage> => {
	const list = Array.isArray(checks) ? checks : [];
	const tasks = checkTasks(list, opts.pkg);
	const recorded = tasks.filter((task) => {
		const check = list.find((c) => c.name === task.id);
		return check ? recordedCheckOk(opts.calls ?? [], check, opts.lastModifiedAt) : false;
	}).map((task) => task.id);
	const pending = tasks.filter((task) => !recorded.includes(task.id));
	const inScope = scopedPlan(pending, opts.changed ?? []);
	const scoped = pending.filter((task) => !inScope.includes(task)).map((task) => task.id);
	const ran = inScope.length
		? await runPlan(inScope, {
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				concurrency: Number.isFinite(opts.concurrency) ? (opts.concurrency as number) : PLAN_DEFAULT_CONCURRENCY,
				fingerprint: checkFingerprint(opts.cwd, opts.lastModifiedAt),
				cache: cacheFor(),
				...(opts.run ? { run: opts.run } : {}),
			})
		: [];
	const results = list.map((check): CheckResult => {
		if (recorded.includes(check.name)) return { name: check.name, command: label(check), exitCode: 0, tail: "", status: "pass", ms: 0, cached: true };
		if (scoped.includes(check.name)) return { name: check.name, command: label(check), exitCode: 0, tail: "", status: "scoped", ms: 0, cached: false };
		const hit = ran.find((r) => r.id === check.name);
		if (!hit) return { name: check.name, command: label(check), exitCode: 1, tail: "the check never ran", status: "fail", ms: 0, cached: false };
		return { name: check.name, command: hit.command, exitCode: hit.exitCode, tail: hit.output, status: hit.status, ms: hit.ms, cached: hit.cached };
	});
	return { results, ran, recorded, scoped };
};

export const checkStatusOf = (r: CheckResult): CheckOutcome => r.status ?? (r.exitCode === 0 ? "pass" : "fail");

export const checkLine = (r: CheckResult): string => `$ ${r.command}\n   exit ${r.exitCode}${r.tail ? `\n   ${r.tail.split("\n").slice(-6).join("\n   ")}` : ""}`;

export const failingChecks = (results: CheckResult[]): CheckResult[] => (Array.isArray(results) ? results : []).filter((r) => checkStatusOf(r) === "fail");

export const skippedChecks = (results: CheckResult[]): CheckResult[] =>
	(Array.isArray(results) ? results : []).filter((r) => {
		const status = checkStatusOf(r);
		return status !== "fail" && status !== "pass";
	});

export const runCheck = (check: DeterministicCheck, cwd: string, timeoutMs: number): CheckResult => {
	const name = `${check.command} ${check.args.join(" ")}`;
	try {
		const out = execFileSync(check.command, check.args, { cwd, timeout: Math.max(1_000, timeoutMs), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
		return { name: check.name, command: name, exitCode: 0, tail: String(out ?? "").trim(), status: "pass" };
	} catch (err) {
		const e = err as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown; message?: string };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const timedOut = typeof e.status !== "number" && !!e.signal;
		const exitCode = typeof e.status === "number" ? e.status : e.signal ? 124 : 1;
		const tail = `${stdout}\n${stderr}`.trim() || (e.message ?? "the check produced no output");
		return { name: check.name, command: name, exitCode, tail, status: statusOf({ exitCode, output: tail, ...(timedOut ? { timedOut: true } : {}) }) };
	}
};

export const runChecks = (checks: DeterministicCheck[], cwd: string, timeoutMs: number): CheckResult[] =>
	(Array.isArray(checks) ? checks : []).map((check) => runCheck(check, cwd, timeoutMs));

export const runCommand = (command: string, cwd: string, timeoutMs: number): CheckResult => {
	try {
		const out = execFileSync("bash", ["-lc", command], { cwd, timeout: Math.max(1_000, timeoutMs), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
		return { name: command, command, exitCode: 0, tail: String(out ?? "").trim(), status: "pass" };
	} catch (err) {
		const e = err as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown; message?: string };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const exitCode = typeof e.status === "number" ? e.status : e.signal ? 124 : 1;
		const tail = `${stdout}\n${stderr}`.trim() || (e.message ?? "the command produced no output");
		return { name: command, command, exitCode, tail, status: exitCode === 0 ? "pass" : "fail" };
	}
};
