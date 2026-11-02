import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PLAN_DEFAULT_CONCURRENCY, type PlanResult, type PlanRunner, type PlanStatus, type PlanTask, runPlan, scopedPlan, statusOf } from "./check-runner.ts";
import { normalizeCommand, type RecordedCall } from "./evidence-record.ts";
import { gitOk } from "./worktree.ts";

const execFileAsync = promisify(execFile);

export const CHECK_ORDER = ["typecheck", "lint", "test"] as const;

export const CHECK_SCRIPT_PATHS_MAX = 8;

export const CHECK_CACHE_MAX = 240;

export const CHECK_CUSTOM_MAX = 8;

export const CASE_CHECK_PREFIX = "case:";

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

const CHECK_NAME = /^(?:typecheck|types?|lint|test|tests|e2e|spec|unit|functional|integration|coverage|jest|vitest|mocha|ava|tap|cypress|playwright)(?:[-:][\w:-]+)?$/i;

const TEST_RUNNER = /(?:^|[\s;&|(])(?:jest|vitest|mocha|ava|tap|playwright|cypress)\b|node\s+--?[\w-]*\s*--test\b|--test\b/;

export const isCheckScript = (name: string, body?: unknown): boolean => {
	const scriptName = String(name ?? "").trim();
	if (!scriptName) return false;
	if (CHECK_NAME.test(scriptName)) return true;
	return typeof body === "string" && TEST_RUNNER.test(body);
};

const STATIC_CHECK = /^(?:typecheck|types?|lint)(?:[-:][\w:-]+)?$/i;

export const isBehaviourCheck = (name: string, body?: unknown): boolean =>
	!STATIC_CHECK.test(String(name ?? "").trim()) && isCheckScript(name, body);

const checkRank = (name: string): number => {
	const at = (CHECK_ORDER as readonly string[]).indexOf(name);
	return at >= 0 ? at : CHECK_ORDER.length;
};

export const detectChecks = (pkg: { scripts?: Record<string, unknown> } | undefined): DeterministicCheck[] => {
	const scripts = pkg?.scripts ?? {};
	const found: DeterministicCheck[] = [];
	for (const [name, body] of Object.entries(scripts)) {
		if (typeof body !== "string" || !body.trim()) continue;
		if (!isCheckScript(name, body)) continue;
		found.push({ name, command: "npm", args: ["run", "--silent", name] });
	}
	return found.sort((a, b) => checkRank(a.name) - checkRank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

const topSegment = (token: string): string | undefined => {
	const clean = token.replace(/^\.\//, "").replace(/\\/g, "/").replace(/^["'`]|["'`]$/g, "");
	if (!clean || clean.startsWith("-") || clean.startsWith("@") || /^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) return undefined;
	if (!clean.includes("/")) return undefined;
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

export interface CustomCheckRequest {
	name?: unknown;
	command?: unknown;
}

export interface CustomCheckEntry {
	check: DeterministicCheck;
	command: string;
}

const CUSTOM_ID = /^[a-z0-9][a-z0-9._-]*$/i;

const uniqueName = (base: string, used: Set<string>): string => {
	let name = base;
	for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
	return name;
};

export const customCheckEntries = (list: unknown): CustomCheckEntry[] => {
	const out: CustomCheckEntry[] = [];
	const used = new Set<string>();
	for (const raw of Array.isArray(list) ? list : []) {
		const entry = (typeof raw === "string" ? { command: raw } : raw) as CustomCheckRequest | undefined;
		const command = typeof entry?.command === "string" ? entry.command.trim() : "";
		if (!command || out.length >= CHECK_CUSTOM_MAX) continue;
		const given = typeof entry?.name === "string" ? entry.name.trim().replace(CASE_CHECK_PREFIX, "") : "";
		const base = `${CASE_CHECK_PREFIX}${given && CUSTOM_ID.test(given) ? given : `check-${out.length + 1}`}`;
		const name = uniqueName(base, used);
		used.add(name);
		out.push({ check: { name, command: "bash", args: ["-lc", command] }, command });
	}
	return out;
};

export const customChecks = (list: unknown): DeterministicCheck[] => customCheckEntries(list).map((entry) => entry.check);

export const checkTask = (check: DeterministicCheck, pkg?: { scripts?: Record<string, unknown> }): PlanTask => {
	const body = pkg?.scripts?.[check.name];
	const derived = isBehaviourCheck(check.name, body) ? [] : scriptPaths(typeof body === "string" ? body : "");
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
	const seen = new Set<string>();
	for (const line of result.out.split(/\r?\n/))
		for (const path of statusLinePaths(line))
			if (!CHANGE_IGNORED.test(path) && !seen.has(path)) {
				seen.add(path);
				out.push(path);
			}
	return out;
};

export const WORKSPACE_STAMP_MAX = 200;

export const workspaceStamp = (cwd: string, paths: string[] = changedPaths(cwd)): number => {
	let newest = 0;
	for (const rel of (Array.isArray(paths) ? paths : []).slice(0, WORKSPACE_STAMP_MAX)) {
		try {
			newest = Math.max(newest, statSync(join(cwd, rel)).mtimeMs);
		} catch {
		}
	}
	return Number.isFinite(newest) ? Math.max(0, Math.floor(newest)) : 0;
};

const fresh = (call: RecordedCall, after?: number): boolean => !Number.isFinite(after) || call.at === undefined || call.at >= (after as number);

export const freshCalls = (calls: RecordedCall[], after?: number): RecordedCall[] => (Array.isArray(calls) ? calls : []).filter((call) => fresh(call, after));

export const checkCommandForms = (name: string): string[] => [
	`npm run --silent ${name}`,
	`npm run ${name}`,
	`npm run-script ${name}`,
	...(name === "test" ? ["npm test"] : []),
];

export const runsScript = (command: string, check: DeterministicCheck, body?: unknown): boolean => {
	const normalized = normalizeCommand(command);
	if (!normalized) return false;
	if (checkCommandForms(check.name).map(normalizeCommand).includes(normalized)) return true;
	const script = normalizeCommand(typeof body === "string" ? body : "");
	return !!script && normalized === script;
};

export const recordedCheckOk = (calls: RecordedCall[], check: DeterministicCheck, after?: number, body?: unknown): boolean =>
	freshCalls(calls, after).some((call) => call.ok && runsScript(call.command, check, body));

export const provesCommand = (checks: CheckResult[], command: string): boolean => provenByRun(checks, command) !== undefined;

const runForms = (run: CheckResult): string[] => [...checkCommandForms(run.name), run.command].map(normalizeCommand).filter(Boolean);

export const provesRun = (run: CheckResult, command: string): boolean => {
	const wanted = normalizeCommand(command);
	if (!wanted || checkStatusOf(run) !== "pass") return false;
	return runForms(run).includes(wanted);
};

export const provenByRun = (checks: CheckResult[], command: string): CheckResult | undefined =>
	(Array.isArray(checks) ? checks : []).find((run) => provesRun(run, command));

export const caseProvenCommands = (checks: CheckResult[]): string[] =>
	(Array.isArray(checks) ? checks : [])
		.filter((run) => String(run.name ?? "").startsWith(CASE_CHECK_PREFIX) && checkStatusOf(run) === "pass")
		.map((run) => run.command);

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

const label = (check: DeterministicCheck): string =>
	check.name.startsWith(CASE_CHECK_PREFIX) ? String(check.args[check.args.length - 1] ?? "") : `${check.command} ${check.args.join(" ")}`;

export interface CheckStageOptions {
	cwd: string;
	timeoutMs: number;
	lastModifiedAt?: number;
	changed?: string[];
	custom?: CustomCheckRequest[];
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
	const bodyOf = (check: DeterministicCheck): unknown => opts.pkg?.scripts?.[check.name];
	const packageTasks = checkTasks(list, opts.pkg);
	const packageRecorded = packageTasks.map((_task, at) => recordedCheckOk(opts.calls ?? [], list[at], opts.lastModifiedAt, bodyOf(list[at])));
	const pendingPackages = packageTasks.filter((_task, at) => !packageRecorded[at]);
	const inScopePackages = new Set(scopedPlan(pendingPackages, opts.changed ?? []).map((task) => task.id));
	const covering = list.filter((_check, at) => packageRecorded[at] || inScopePackages.has(packageTasks[at].id));
	const covered = new Set(covering.flatMap((check) => checkCommandForms(check.name)).map(normalizeCommand));
	const custom = customCheckEntries(opts.custom).filter((entry) => !covered.has(normalizeCommand(entry.command)));
	const all = [...custom.map((entry) => entry.check), ...list];
	const bodies: unknown[] = [...custom.map((entry) => entry.command), ...list.map(bodyOf)];
	const tasks = [...custom.map((entry) => ({ id: entry.check.name, command: entry.check.command, args: entry.check.args })), ...packageTasks];
	const recordedAt = tasks.map((task, at) => recordedCheckOk(opts.calls ?? [], all[at], opts.lastModifiedAt, bodies[at]));
	const recorded = tasks.filter((task, at) => recordedAt[at]).map((task) => task.id);
	const pending = tasks.filter((task, at) => !recordedAt[at]);
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
	const results = all.map((check, at): CheckResult => {
		const task = tasks[at];
		if (recordedAt[at]) return { name: check.name, command: label(check), exitCode: 0, tail: "", status: "pass", ms: 0, cached: true };
		if (scoped.includes(task.id)) return { name: check.name, command: label(check), exitCode: 0, tail: "", status: "scoped", ms: 0, cached: false };
		const hit = ran.find((r) => r.id === task.id);
		if (!hit) return { name: check.name, command: label(check), exitCode: 1, tail: "the check never ran", status: "fail", ms: 0, cached: false };
		return { name: check.name, command: label(check), exitCode: hit.exitCode, tail: hit.output, status: hit.status, ms: hit.ms, cached: hit.cached };
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

export const provedByChecks = (checks: CheckResult[], commands: Map<string, string>): string[] =>
	[...commands].filter(([, command]) => provesCommand(checks, command)).map(([caseId]) => caseId);

interface SpawnedFailure {
	code?: number | string | null;
	status?: number | null;
	signal?: string | null;
	stdout?: unknown;
	stderr?: unknown;
	message?: string;
}

const numericStatus = (e: SpawnedFailure): number | undefined => {
	for (const value of [e.status, e.code]) if (typeof value === "number") return value;
	return undefined;
};

const spawnFailure = (err: unknown): { exitCode: number; tail: string; timedOut: boolean } => {
	const e = err as SpawnedFailure;
	const stdout = typeof e.stdout === "string" ? e.stdout : "";
	const stderr = typeof e.stderr === "string" ? e.stderr : "";
	const killed = !!e.signal;
	const status = numericStatus(e);
	const exitCode = status ?? (killed ? 124 : 1);
	return { exitCode, tail: `${stdout}\n${stderr}`.trim() || (e.message ?? "the command produced no output"), timedOut: status === undefined && killed };
};

const SPAWN_OPTS = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 };

export const runCheck = async (check: DeterministicCheck, cwd: string, timeoutMs: number): Promise<CheckResult> => {
	const name = `${check.command} ${check.args.join(" ")}`;
	try {
		const out = await execFileAsync(check.command, check.args, { ...SPAWN_OPTS, cwd, timeout: Math.max(1_000, timeoutMs) });
		return { name: check.name, command: name, exitCode: 0, tail: String(out.stdout ?? "").trim(), status: "pass" };
	} catch (err) {
		const { exitCode, tail, timedOut } = spawnFailure(err);
		return { name: check.name, command: name, exitCode, tail, status: statusOf({ exitCode, output: tail, ...(timedOut ? { timedOut: true } : {}) }) };
	}
};

export const runChecks = async (checks: DeterministicCheck[], cwd: string, timeoutMs: number): Promise<CheckResult[]> =>
	Promise.all((Array.isArray(checks) ? checks : []).map((check) => runCheck(check, cwd, timeoutMs)));

export const runCommand = async (command: string, cwd: string, timeoutMs: number): Promise<CheckResult> => {
	try {
		const out = await execFileAsync("bash", ["-lc", command], { ...SPAWN_OPTS, cwd, timeout: Math.max(1_000, timeoutMs) });
		return { name: command, command, exitCode: 0, tail: String(out.stdout ?? "").trim(), status: "pass" };
	} catch (err) {
		const { exitCode, tail, timedOut } = spawnFailure(err);
		return { name: command, command, exitCode, tail, status: statusOf({ exitCode, output: tail, ...(timedOut ? { timedOut: true } : {}) }) };
	}
};
