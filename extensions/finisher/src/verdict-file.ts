import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { finisherDir } from "./types.ts";
import { isRecordedVerdict, type RecordedVerdict } from "./evidence-record.ts";

export const VERDICT_ENV = "FINISHER_VERDICT_FILE";
export const ROLE_ENV = "FINISHER_ROLE";

export const verdictDir = (cwd: string): string => join(finisherDir(cwd), "verdicts");

export const verdictPath = (cwd: string, caseId: string): string =>
	join(verdictDir(cwd), `${caseId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "case"}.jsonl`);

export const verdictLine = (v: RecordedVerdict): string =>
	JSON.stringify({ verdict: v.verdict, why: v.why.slice(0, 600), ...(v.caseId ? { caseId: v.caseId } : {}), at: v.at ?? Date.now() });

export const appendVerdict = (path: string, v: RecordedVerdict): void => {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${verdictLine(v)}\n`);
};

export const parseVerdicts = (text: string): RecordedVerdict[] => {
	const out: RecordedVerdict[] = [];
	for (const line of text.split("\n")) {
		const body = line.trim();
		if (!body) continue;
		try {
			const parsed = JSON.parse(body) as unknown;
			if (isRecordedVerdict(parsed)) out.push(parsed);
		} catch {
		}
	}
	return out;
};

export const lastVerdict = (path: string): RecordedVerdict | undefined => {
	if (!path || !existsSync(path)) return undefined;
	try {
		const records = parseVerdicts(readFileSync(path, "utf8"));
		return records[records.length - 1];
	} catch {
		return undefined;
	}
};

export const resetVerdict = (path: string): void => {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
	}
};

export const verdictFileFor = (): string | undefined => {
	const p = process.env[VERDICT_ENV];
	return p && p.trim() ? p.trim() : undefined;
};

export const childRole = (): string | undefined => {
	const r = process.env[ROLE_ENV];
	return r && r.trim() ? r.trim() : undefined;
};
