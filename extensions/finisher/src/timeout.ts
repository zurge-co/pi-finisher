import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";
import { MAX_TIMER_MS } from "./goal-run.ts";

export const DEFAULT_TOOL_TIMEOUT_MS = 900_000;
export const MAX_BASH_TIMEOUT_SECONDS = 3_600;
export const MIN_TIMEOUT_MS = 1_000;

export interface TimedOut {
	timedOut: true;
	label: string;
	ms: number;
}

export interface TimedValue<T> {
	timedOut: false;
	value: T;
}

export type TimeoutResult<T> = TimedValue<T> | TimedOut;

export const TIMED_OUT = Symbol("timedOut");

export const readToolTimeout = (cwd: string, tool = "default"): number => {
	const fromConfig = (): { all?: unknown; per?: unknown } => {
		const f = join(finisherDir(cwd), "config.json");
		if (!existsSync(f)) return {};
		try {
			const raw = JSON.parse(readFileSync(f, "utf8")) as { toolTimeoutMs?: unknown };
			const v = raw.toolTimeoutMs;
			if (typeof v === "number") return { all: v };
			if (v && typeof v === "object" && !Array.isArray(v)) return { per: (v as Record<string, unknown>)[tool] };
			return {};
		} catch {
			return {};
		}
	};
	const cfg = fromConfig();
	for (const candidate of [cfg.per, cfg.all]) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= MIN_TIMEOUT_MS) return Math.floor(candidate);
	}
	return DEFAULT_TOOL_TIMEOUT_MS;
};

export const withTimeout = async <T>(run: Promise<T>, ms: number, label: string): Promise<TimeoutResult<T>> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stopper = new Promise<typeof TIMED_OUT>((res) => {
		timer = setTimeout(() => res(TIMED_OUT), Math.min(MAX_TIMER_MS, Math.max(MIN_TIMEOUT_MS, ms)));
	});
	try {
		const winner = await Promise.race([run, stopper]);
		return winner === TIMED_OUT ? { timedOut: true, label, ms } : { timedOut: false, value: winner as T };
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const settleWithTimeout = async <T>(run: Promise<T>, ms: number, label: string, onTimeout: () => T): Promise<T> => {
	const r = await withTimeout(run, ms, label);
	return r.timedOut ? onTimeout() : r.value;
};

export const timeoutSeconds = (ms: number): number => Math.max(1, Math.min(MAX_BASH_TIMEOUT_SECONDS, Math.ceil(ms / 1000)));

export const isValidBashTimeout = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_BASH_TIMEOUT_SECONDS;

export const ensureBashTimeout = (input: unknown, ms: number): { changed: boolean; timeout: number } => {
	const box = input as { timeout?: unknown } | undefined;
	const wanted = timeoutSeconds(ms);
	if (!box || typeof box !== "object") return { changed: false, timeout: wanted };
	if (isValidBashTimeout(box.timeout)) return { changed: false, timeout: box.timeout };
	box.timeout = wanted;
	return { changed: true, timeout: wanted };
};

export const TOOL_TIMEOUT_LABEL = (name: string): string => `tool ${name}`;

export const timeoutNote = (t: TimedOut): string => `⏱ ${t.label} exceeded its ${Math.round(t.ms / 1000)}s limit — the harness stopped waiting for it`;

export const applyBashTimeout = (toolName: string, input: unknown, cwd: string): boolean => {
	if (toolName !== "bash") return false;
	return ensureBashTimeout(input, readToolTimeout(cwd, "bash")).changed;
};

export const TIMED_TOOLS = ["bash", "powershell"] as const;

export interface EnforcedDeadline {
	changed: boolean;
	timeout: number;
	blocked: boolean;
	reason?: string;
	note?: string;
}

export const TIMEOUT_RULE = [	"Every command you run carries a deadline. bash/powershell calls must pass `timeout` in SECONDS; the harness injects one when you omit it and refuses a call whose timeout cannot be bounded (0, negative, NaN, a string, or above the maximum pi accepts).",
	"Pick the smallest deadline that still lets the command finish: a test suite 120–300s, a build 300–600s, a search 60s. A deadline is not a budget — it is what stops a hang from eating the whole run.",
].join("\n");

export const TIMEOUT_BINARIES = ["/usr/bin/timeout", "/bin/timeout", "/usr/local/bin/timeout", "/opt/homebrew/bin/timeout"] as const;

export const hasTimeoutBinary = (): boolean => TIMEOUT_BINARIES.some((p) => existsSync(p));

export const boundWrapper = (hasTimeout = hasTimeoutBinary()): string =>
	hasTimeout
		? "prefix it: `timeout 120 <command>` (seconds, then the command)"
		: "this host has no `timeout` binary — wrap it: `perl -e 'alarm 120; exec @ARGV' -- <command>` (alarm takes seconds)";

export const enforceDeadline = (toolName: string, input: unknown, cwd: string): EnforcedDeadline => {
	if (!(TIMED_TOOLS as readonly string[]).includes(toolName)) return { changed: false, timeout: 0, blocked: false };
	const box = input as { timeout?: unknown } | undefined;
	const requested = box?.timeout;
	if (requested !== undefined && !isValidBashTimeout(requested)) {
		const repaired = ensureBashTimeout(box, readToolTimeout(cwd, toolName));
		return {
			changed: repaired.changed,
			timeout: repaired.timeout,
			blocked: true,
			reason: `${toolName}: timeout ${JSON.stringify(requested)} is not a valid deadline (1..${MAX_BASH_TIMEOUT_SECONDS} seconds). Pass an explicit positive number of seconds, e.g. ${repaired.timeout}.`,
		};
	}
	const r = ensureBashTimeout(box, readToolTimeout(cwd, toolName));
	return { changed: r.changed, timeout: r.timeout, blocked: false, ...(r.changed ? { note: `${toolName} ran with an injected ${r.timeout}s deadline — pass your own timeout whenever the command can hang.` } : {}) };
};

export type ToolLike = { name: string; execute: (...args: any[]) => Promise<any> };

export const boundToolExecute = <A extends any[]>(name: string, cwdOf: (args: unknown[]) => string, execute: (...args: A) => Promise<unknown>) =>
	async (...args: A): Promise<unknown> => {
		const r = await withTimeout(Promise.resolve(execute(...args)), readToolTimeout(cwdOf(args), name), TOOL_TIMEOUT_LABEL(name));
		if (!r.timedOut) return r.value;
		return { content: [{ type: "text", text: timeoutNote(r) }], details: { timedOut: true, tool: name }, isError: true };
	};

