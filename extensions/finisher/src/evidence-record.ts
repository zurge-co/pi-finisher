import { type CaseVerdict } from "./evidence.ts";

export interface RecordedCall {
	command: string;
	ok: boolean;
	at?: number;
}

export interface CaseJudgement {
	verdict: CaseVerdict;
	reason?: string;
}

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

export const normalizeCommand = (command: string): string => command.replace(/\s+/g, " ").trim();

export const judgeChecks = (calls: RecordedCall[], required: string[]): CaseJudgement => {
	const wanted = [...new Set(required.map(normalizeCommand).filter(Boolean))];
	if (!wanted.length) return { verdict: "UNVERIFIED", reason: "no command was named for this case — a case with no executed check proves nothing" };
	const status = new Map<string, boolean>();
	for (const c of calls) status.set(normalizeCommand(c.command), c.ok);
	const missing = wanted.filter((w) => !status.has(w));
	if (missing.length) return { verdict: "UNVERIFIED", reason: `the harness never recorded \`${missing[0]}\` running — a case with no executed command is not proven` };
	const failed = wanted.filter((w) => status.get(w) === false);
	if (failed.length) return { verdict: "FAIL", reason: `\`${failed[0]}\` exited non-zero in the harness recording` };
	return { verdict: "PASS" };
};
