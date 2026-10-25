import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finisherDir } from "./types.ts";

export const CHECKS_DIR = "checks";
export const CHECKS_FILE = "checks.jsonl";
export const CHECK_FILE_MAX = 400;
export const CHECK_OUTPUT_MAX = 600;

export const checksDir = (cwd: string): string => join(finisherDir(cwd), CHECKS_DIR);
export const checksPath = (cwd: string): string => join(checksDir(cwd), CHECKS_FILE);

export type CheckStatus = "pass" | "fail" | "infra" | "deadline" | "unverified";

const STATUSES: readonly CheckStatus[] = ["pass", "fail", "infra", "deadline", "unverified"];

export interface CheckEntry {
	at: number;
	case: string;
	status: CheckStatus;
	goal?: string;
	command?: string;
	output?: string;
}

export type CheckMark = "PASS" | "FAIL" | "SKIP" | "UNVERIFIED";

const MARK: Record<CheckStatus, CheckMark> = { pass: "PASS", fail: "FAIL", infra: "SKIP", deadline: "SKIP", unverified: "UNVERIFIED" };

export const checkMark = (status: CheckStatus): CheckMark => MARK[status] ?? "UNVERIFIED";

const caseKey = (text: string): string => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const tail = (text: string): string => (text.length <= CHECK_OUTPUT_MAX ? text : text.slice(text.length - CHECK_OUTPUT_MAX));

export const encodeCheck = (entry: CheckEntry): string => {
	const out: Record<string, unknown> = { at: Number.isFinite(entry.at) ? Math.max(0, Math.floor(entry.at)) : 0, status: entry.status };
	if (entry.goal) out.goal = entry.goal;
	if (entry.case) out.case = entry.case;
	if (entry.command) out.command = entry.command;
	if (entry.output) out.output = tail(String(entry.output));
	return JSON.stringify(out);
};

export const parseCheckLine = (line: string): CheckEntry | undefined => {
	const text = typeof line === "string" ? line.trim() : "";
	if (!text) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	const at = typeof r.at === "number" && Number.isFinite(r.at) ? r.at : undefined;
	const caseId = typeof r.case === "string" ? r.case.trim() : "";
	const status = typeof r.status === "string" && (STATUSES as readonly string[]).includes(r.status) ? (r.status as CheckStatus) : undefined;
	if (at === undefined || !caseId || !status) return undefined;
	const entry: CheckEntry = { at, case: caseId, status };
	if (typeof r.goal === "string" && r.goal) entry.goal = r.goal;
	if (typeof r.command === "string" && r.command) entry.command = r.command;
	if (typeof r.output === "string" && r.output) entry.output = tail(r.output);
	return entry;
};

export const parseChecks = (text: string): CheckEntry[] => {
	const out: CheckEntry[] = [];
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const entry = parseCheckLine(line);
		if (entry) out.push(entry);
	}
	return out;
};

export const readChecks = (cwd: string): CheckEntry[] => {
	try {
		const path = checksPath(cwd);
		return existsSync(path) ? parseChecks(readFileSync(path, "utf8")) : [];
	} catch {
		return [];
	}
};

export const writeChecks = (cwd: string, entries: CheckEntry[]): boolean => {
	try {
		const list = (Array.isArray(entries) ? entries : []).slice(-CHECK_FILE_MAX);
		mkdirSync(checksDir(cwd), { recursive: true });
		writeFileSync(checksPath(cwd), list.length ? `${list.map(encodeCheck).join("\n")}\n` : "");
		return true;
	} catch {
		return false;
	}
};

export const appendCheck = (cwd: string, entry: CheckEntry): boolean => writeChecks(cwd, [...readChecks(cwd), entry]);

export const caseStatus = (entries: CheckEntry[], caseId: string): CheckStatus => {
	const target = caseKey(caseId);
	let found: CheckStatus = "unverified";
	for (const entry of Array.isArray(entries) ? entries : []) if (caseKey(entry.case) === target && entry.status) found = entry.status;
	return found;
};

export const caseChecks = (entries: CheckEntry[], cases: string[]): { caseId: string; status: CheckStatus }[] =>
	(Array.isArray(cases) ? cases : []).map((caseId) => ({ caseId, status: caseStatus(entries, caseId) }));

const distinctCases = (entries: CheckEntry[]): string[] => {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of entries) {
		const text = String(entry.case ?? "").trim();
		if (!text || seen.has(caseKey(text))) continue;
		seen.add(caseKey(text));
		out.push(text);
	}
	return out;
};

export const checkFileLines = (entries: CheckEntry[], cases?: string[]): string[] => {
	const list = Array.isArray(entries) ? entries : [];
	const wanted = Array.isArray(cases) && cases.length ? cases : distinctCases(list);
	return wanted.map((caseId) => `${checkMark(caseStatus(list, caseId))}  ${caseId}`);
};

export const renderCheckFile = (entries: CheckEntry[], cases?: string[]): string => {
	const list = Array.isArray(entries) ? entries : [];
	const goals = [...new Set(list.map((entry) => entry.goal).filter((goal): goal is string => typeof goal === "string" && goal.length > 0))];
	const head = goals.length === 1 ? [`goal: ${goals[0]}`, ""] : [];
	return [...head, ...checkFileLines(list, cases)].join("\n");
};
