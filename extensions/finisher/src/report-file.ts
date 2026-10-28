import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type GoalOutcome } from "./compaction-guard.ts";
import { statePath } from "./project-dir.ts";

export const REPORT_FILE = "report.md";
export const REPORT_MAX_BYTES = 96 * 1024;
export const REPORT_HEAD_BYTES = 512;

export const reportPath = (cwd: string): string => statePath(cwd, REPORT_FILE);

export interface ReportMeta {
	path: string;
	at: number;
	outcome: GoalOutcome;
	goal: string;
	laps: number;
	round: number;
	bytes: number;
}

export interface ReportInput {
	goal: string;
	outcome: GoalOutcome;
	at: number;
	laps: number;
	round: number;
	body: string;
}

export interface ReportBrief {
	outcome: GoalOutcome;
	laps: number;
	at: number;
	goal: string;
}

export const reportHeading = (i: Omit<ReportInput, "body">): string =>
	[
		`# finisher report — ${i.outcome}`,
		"",
		`goal: ${i.goal}`,
		`laps: ${i.laps} · round: ${i.round}`,
		`written: ${new Date(i.at).toISOString()}`,
	].join("\n");

const truncationNote = (max: number): string => `\n… (report truncated at ${max} bytes)`;

const fitBytes = (text: string, max: number): string => {
	if (max <= 0) return "";
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > max) break;
		out += ch;
		used += size;
	}
	return out;
};

export const capReport = (text: string, max = REPORT_MAX_BYTES): string => {
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	const note = truncationNote(max);
	const room = max - Buffer.byteLength(note, "utf8");
	if (room <= 0) return fitBytes(text, Math.max(0, max));
	return `${fitBytes(text, room)}${note}`;
};

export const reportDocument = (i: ReportInput, max = REPORT_MAX_BYTES): string =>
	capReport(`${reportHeading(i)}\n\n${i.body}`, max);

export const writeReportFile = (cwd: string, input: ReportInput): ReportMeta | undefined => {
	const path = reportPath(cwd);
	const text = reportDocument(input);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		return { path, at: input.at, outcome: input.outcome, goal: input.goal, laps: input.laps, round: input.round, bytes: Buffer.byteLength(text, "utf8") };
	} catch {
		return undefined;
	}
};

export const readReportFile = (path: string): string | undefined => {
	try {
		if (!existsSync(path)) return undefined;
		const text = readFileSync(path, "utf8");
		return text.trim() ? text : undefined;
	} catch {
		return undefined;
	}
};

const OUTCOMES: readonly GoalOutcome[] = ["verified", "needs-human", "halted"];

const readHead = (path: string): string | undefined => {
	try {
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(REPORT_HEAD_BYTES);
			return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
};

export const parseReportBrief = (head: string): ReportBrief | undefined => {
	const lines = head.split(/\r?\n/);
	const first = /^# finisher report — (\S+)/.exec(lines[0] ?? "");
	const outcome = OUTCOMES.find((o) => o === first?.[1]);
	if (!outcome) return undefined;
	const field = (name: string): string => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
	const laps = Number.parseInt(field("laps"), 10);
	const at = Date.parse(field("written"));
	return { outcome, laps: Number.isFinite(laps) ? laps : 0, at: Number.isFinite(at) ? at : 0, goal: field("goal") };
};

export const reportMetaFromFile = (cwd: string | undefined): ReportMeta | undefined => {
	if (!cwd) return undefined;
	const path = reportPath(cwd);
	const brief = parseReportBrief(readHead(path) ?? "");
	if (!brief) return undefined;
	let bytes = 0;
	try {
		bytes = statSync(path).size;
	} catch {
		return undefined;
	}
	return { path, at: brief.at, outcome: brief.outcome, goal: brief.goal, laps: brief.laps, round: 0, bytes };
};

export const currentReport = (cwd: string | undefined, meta?: ReportMeta): ReportBrief | undefined => {
	const live = liveReport(meta);
	if (live) return live;
	const disk = reportMetaFromFile(cwd);
	return disk ? { outcome: disk.outcome, laps: disk.laps, at: disk.at, goal: disk.goal } : undefined;
};

export const liveReport = (meta: ReportMeta | undefined): ReportBrief | undefined => {
	if (!meta) return undefined;
	try {
		if (!existsSync(meta.path) || statSync(meta.path).size <= 0) return undefined;
	} catch {
		return undefined;
	}
	return { outcome: meta.outcome, laps: meta.laps, at: meta.at, goal: meta.goal };
};
