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

export const MAX_VERIFY_ROUNDS = 3;

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
	const matches = [...output.matchAll(/VERDICT:\s*(PASS|FAIL)\b/gi)];
	if (!matches.length) return undefined;
	return matches[matches.length - 1][1].toUpperCase() as CaseVerdict;
};

export const judgeCase = (caseId: string, output: string, opts: { exitCode?: number } = {}): CaseEvidence => {
	const commands = extractCommands(output);
	const declared = declaredVerdict(output);
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

export interface VerifyLoopState {
	round: number;
	fingerprints: string[];
	caseRounds: Record<string, number>;
}

export const freshVerifyLoop = (): VerifyLoopState => ({ round: 0, fingerprints: [], caseRounds: {} });

export const evidenceFingerprint = (report: VerifyReport): string =>
	report.cases
		.map((c) => `${c.caseId}:${c.verdict}:${c.commands.map((x) => `${x.command}=${x.exitCode ?? "?"}`).join(",")}`)
		.sort()
		.join("|");

export type VerifyDecision = { kind: "pass" } | { kind: "retry"; round: number; fix: string[] } | { kind: "stop"; reason: string; halt: boolean };

export const nextVerifyRound = (state: VerifyLoopState, report: VerifyReport, maxRounds = MAX_VERIFY_ROUNDS): VerifyDecision => {
	if (report.allPass) return { kind: "pass" };
	const fingerprint = evidenceFingerprint(report);
	if (state.fingerprints.includes(fingerprint))
		return { kind: "stop", halt: false, reason: `the same evidence came back again (round ${state.round}) — repeating the verification cannot change the verdict, so stop and report it` };
	const open = [...report.failed, ...report.unverified];
	if (state.round + 1 > maxRounds) return { kind: "stop", halt: true, reason: `${maxRounds} verify round(s) used up and ${open.join(", ")} still not proven — report exactly what is unproven and what was tried` };
	return { kind: "retry", round: state.round + 1, fix: open };
};

export const advanceLoop = (state: VerifyLoopState, report: VerifyReport): VerifyLoopState => {
	const fingerprint = evidenceFingerprint(report);
	const caseRounds = { ...state.caseRounds };
	for (const c of report.cases) caseRounds[c.caseId] = (caseRounds[c.caseId] ?? 0) + 1;
	return { round: state.round + 1, fingerprints: [...state.fingerprints, fingerprint], caseRounds };
};

export const buildFixPrompt = (report: VerifyReport, round: number, maxRounds: number): string =>
	[
		`verify round ${round}/${maxRounds} did not prove the goal — fix the real cause for these case(s), then run the verification again:`,
		...report.cases
			.filter((c) => c.verdict !== "PASS")
			.map((c) => `  ${c.caseId} (${c.verdict})${c.reason ? `: ${c.reason}` : ""}${c.commands.length ? ` — tried: ${c.commands.map((x) => x.command).join("; ")}` : ""}`),
		"do not claim PASS without a command whose exit status shows it; do not ask the human — decide and continue",
	].join("\n");

export const renderVerifyReport = (report: VerifyReport, state?: VerifyLoopState): string => {
	const head = report.allPass ? "✅ verified — every case is backed by executed evidence" : `❌ not verified — ${report.failed.length} failing, ${report.unverified.length} unproven of ${report.cases.length}`;
	const lines = [head, state ? `rounds used: ${state.round}` : "", ""].filter((l, i) => l !== "" || i > 0);
	for (const c of report.cases) {
		const icon = c.verdict === "PASS" ? "✓" : c.verdict === "FAIL" ? "✗" : "?";
		lines.push(`${icon} ${c.caseId} ${c.verdict}${c.reason ? ` — ${c.reason}` : ""}`);
		for (const cmd of c.commands) lines.push(`    $ ${cmd.command}${typeof cmd.exitCode === "number" ? ` → exit ${cmd.exitCode}` : ""}`);
	}
	return lines.join("\n").trimEnd();
};
