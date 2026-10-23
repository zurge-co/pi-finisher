export type CaseVerdict = "PASS" | "FAIL" | "UNVERIFIED";

export interface EvidenceCommand {
	command: string;
	exitCode?: number;
	output?: string;
	ranAt?: number;
}

export interface CaseEvidence {
	caseId: string;
	verdict: CaseVerdict;
	reason?: string;
	commands: EvidenceCommand[];
}

export interface VerifyReport {
	cases: CaseEvidence[];
	allPass: boolean;
	unverified: string[];
	failed: string[];
}

const COMMAND_LINE = /^(?:\$\s*|>\s*)?((?:npm|npx|pnpm|yarn|bun|node|deno|python3?|pytest|go|cargo|make|tsc|vitest|jest|deno)\b.*)$/;
const EXIT_LINE = /\bexit(?:\s*code)?[:=]?\s*(-?\d+)\b/i;

export const extractCommands = (output: string): EvidenceCommand[] => {
	const commands: EvidenceCommand[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const m = line.match(COMMAND_LINE);
		if (!m) continue;
		const command = m[1].trim();
		const tail = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
		const exit = tail.match(EXIT_LINE);
		const evidence: EvidenceCommand = { command };
		if (exit) evidence.exitCode = Number(exit[1]);
		const body = lines.slice(i + 1, Math.min(i + 4, lines.length)).map((l) => l.trim()).filter(Boolean).join(" ");
		if (body) evidence.output = body.slice(0, 300);
		commands.push(evidence);
	}
	return commands;
};

export const declaredVerdict = (output: string): CaseVerdict | undefined => {
	const matches = [...output.matchAll(/VERDICT:\s*(PASS|FAIL|UNVERIFIED)\b/gi)];
	if (!matches.length) return undefined;
	return matches[matches.length - 1][1].toUpperCase() as CaseVerdict;
};

export const judgeCase = (caseId: string, output: string, opts: { exitCode?: number } = {}): CaseEvidence => {
	const commands = extractCommands(output);
	const declared = declaredVerdict(output);
	if (declared === "UNVERIFIED")
		return { caseId, verdict: "UNVERIFIED", commands, reason: "the verifier could not exercise the change directly — a human must test this" };
	if (!commands.length)
		return { caseId, verdict: "UNVERIFIED", commands, reason: "no command was run — a claim without executed evidence proves nothing" };
	const failedCommand = commands.find((c) => typeof c.exitCode === "number" && c.exitCode !== 0);
	if (failedCommand) return { caseId, verdict: "FAIL", commands, reason: `\`${failedCommand.command}\` exited ${failedCommand.exitCode}` };
	if (opts.exitCode !== undefined && opts.exitCode !== 0) return { caseId, verdict: "FAIL", commands, reason: `the verifier process exited ${opts.exitCode}` };
	if (declared === "FAIL") return { caseId, verdict: "FAIL", commands, reason: "the verifier declared FAIL" };
	if (declared === "PASS")
		return commands.some((c) => c.exitCode === 0 || c.exitCode === undefined)
			? { caseId, verdict: "PASS", commands }
			: { caseId, verdict: "UNVERIFIED", commands, reason: "declared PASS but no command shows a successful exit" };
	return { caseId, verdict: "UNVERIFIED", commands, reason: "the verifier ran commands but never declared a verdict" };
};

export const buildReport = (cases: CaseEvidence[]): VerifyReport => ({
	cases,
	allPass: cases.length > 0 && cases.every((c) => c.verdict === "PASS"),
	unverified: cases.filter((c) => c.verdict === "UNVERIFIED").map((c) => c.caseId),
	failed: cases.filter((c) => c.verdict === "FAIL").map((c) => c.caseId),
});

export interface VerifyAttempts {
	rounds: number;
	lastFingerprint?: string;
}

export const freshAttempts = (): VerifyAttempts => ({ rounds: 0 });

export const evidenceFingerprint = (report: VerifyReport): string =>
	report.cases
		.map((c) => `${c.caseId}:${c.verdict}:${c.commands.map((x) => `${x.command}=${x.exitCode ?? "?"}`).join(",")}`)
		.sort()
		.join("|");

export type VerifyDecision =
	| { kind: "pass" }
	| { kind: "replan"; reason: string }
	| { kind: "human"; reason: string }
	| { kind: "halt"; reason: string };

export const MAX_LOOP_BATCHES = 3;

export const decideOnce = (report: VerifyReport, attempts: VerifyAttempts, maxBatches = MAX_LOOP_BATCHES): VerifyDecision => {
	if (report.allPass) return { kind: "pass" };
	if (report.failed.length) {
		if (attempts.rounds >= maxBatches) return { kind: "halt", reason: `the same goal failed verification ${attempts.rounds} times — stopping instead of looping forever` };
		return { kind: "replan", reason: `verification failed: ${report.failed.join(", ")}` };
	}
	return { kind: "human", reason: `nothing could be exercised directly (${report.unverified.join(", ") || "no case ran"}) — you have to test this yourself` };
};

export const buildReplanPrompt = (report: VerifyReport, goal: string): string =>
	[
		`verification failed for: ${goal}`,
		...report.cases.filter((c) => c.verdict !== "PASS").map((c) => `  ${c.caseId}: ${c.verdict} — ${c.reason ?? "no reason"}`),
		"plan the next loop yourself: decide what to change, do it, then verify once at the end again.",
		"do not re-run the test suite as proof.",
	].join("\n");

export const buildHumanTestNote = (report: VerifyReport): string =>
	[
		"⚠ not proven — this needs a human:",
		...report.cases.filter((c) => c.verdict === "UNVERIFIED").map((c) => `  ${c.caseId}: ${c.reason ?? "could not be exercised directly"}`),
		"the change was left as it is; nothing else was run.",
	].join("\n");

export const renderVerifyReport = (report: VerifyReport): string => {
	const head = report.allPass ? "✅ verified — every case is backed by executed evidence" : `❌ not verified — ${report.failed.length} failing, ${report.unverified.length} unproven of ${report.cases.length}`;
	const lines = [head, ""];
	for (const c of report.cases) {
		const icon = c.verdict === "PASS" ? "✓" : c.verdict === "FAIL" ? "✗" : "?";
		lines.push(`${icon} ${c.caseId} ${c.verdict}${c.reason ? ` — ${c.reason}` : ""}`);
		for (const cmd of c.commands) lines.push(`    $ ${cmd.command}${typeof cmd.exitCode === "number" ? ` → exit ${cmd.exitCode}` : ""}`);
	}
	return lines.join("\n").trimEnd();
};
