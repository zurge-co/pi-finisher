import { type CaseVerdict } from "./evidence.ts";

export interface RecordedCall {
	command: string;
	ok: boolean;
	at?: number;
}

export interface RecordedVerdict {
	verdict: "PASS" | "FAIL" | "UNVERIFIED";
	why: string;
	caseId?: string;
	at?: number;
}

export interface CaseJudgement {
	verdict: CaseVerdict;
	reason?: string;
}

export const isRecordedVerdict = (v: unknown): v is RecordedVerdict => {
	const r = v as RecordedVerdict | undefined;
	return !!r && (r.verdict === "PASS" || r.verdict === "FAIL" || r.verdict === "UNVERIFIED") && typeof r.why === "string";
};

export const recordCall = (calls: RecordedCall[], event: { name?: string; args?: unknown; isError?: boolean; command?: unknown }, at = Date.now()): RecordedCall[] => {
	if (event.name !== "bash") return calls;
	if (typeof event.command === "string" && event.command.trim()) return [...calls, { command: event.command.trim().slice(0, 400), ok: event.isError !== true, at }];
	const command = (event.args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string" || !command.trim()) return calls;
	return [...calls, { command: command.trim().slice(0, 400), ok: event.isError !== true, at }];
};

export const finalStatus = (calls: RecordedCall[]): Map<string, boolean> => {
	const seen = new Map<string, boolean>();
	for (const c of calls) seen.set(c.command, c.ok);
	return seen;
};

export const recordedFailures = (calls: RecordedCall[]): RecordedCall[] =>
	[...finalStatus(calls)].filter(([, ok]) => !ok).map(([command]) => ({ command, ok: false }));

export const recordedSuccesses = (calls: RecordedCall[]): RecordedCall[] =>
	[...finalStatus(calls)].filter(([, ok]) => ok).map(([command]) => ({ command, ok: true }));

export const judgeRecording = (calls: RecordedCall[], verdict: RecordedVerdict | undefined): CaseJudgement => {
	if (!verdict) return { verdict: "UNVERIFIED", reason: "the verifier wrote no verdict record — nothing was judged, so nothing is proven" };
	if (verdict.verdict === "UNVERIFIED") return { verdict: "UNVERIFIED", reason: verdict.why || "the verifier could not exercise the change directly — a human must test this" };
	if (verdict.verdict === "FAIL") return { verdict: "FAIL", reason: verdict.why || "the verifier declared FAIL" };
	const failures = recordedFailures(calls);
	const successes = recordedSuccesses(calls);
	if (failures.length)
		return {
			verdict: "FAIL",
			reason: `the verdict says PASS but the harness recorded \`${failures[0].command}\` failing — the run contradicts its own verdict`,
		};
	if (!successes.length) return { verdict: "UNVERIFIED", reason: "no command was recorded, so the verdict proves nothing" };
	return { verdict: "PASS" };
};

export const recordingLine = (calls: RecordedCall[]): string => {
	if (!calls.length) return "no command was recorded";
	const statuses = [...finalStatus(calls)];
	return statuses.map(([command, ok]) => `${ok ? "ok  " : "FAIL"} ${command}`).join("\n");
};
