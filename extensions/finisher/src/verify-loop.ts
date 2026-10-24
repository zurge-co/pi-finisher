import { declaredVerdict, extractCommands, infraFailure, UNOWNED_PREFIX, type CaseVerdict, type EvidenceCommand } from "./evidence.ts";

export { declaredVerdict, extractCommands } from "./evidence.ts";
export type { CaseVerdict, EvidenceCommand } from "./evidence.ts";

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
	blocked?: string[];
}

export const judgeCase = (caseId: string, output: string, opts: { exitCode?: number } = {}): CaseEvidence => {
	const commands = extractCommands(output);
	const declared = declaredVerdict(output);
	if (!output.trim() || infraFailure(output))
		return { caseId, verdict: "BLOCKED", commands, reason: `the verifier never produced a verdict — ${infraFailure(output) ?? "it returned nothing"}. This is not a failing case: nothing was exercised.` };
	if (declared === "UNVERIFIED")
		return { caseId, verdict: "UNVERIFIED", commands, reason: "the verifier could not exercise the change directly — a human must test this" };
	if (!commands.length)
		return { caseId, verdict: "UNVERIFIED", commands, reason: "no command was run — a claim without executed evidence proves nothing" };
	const ran = commands.filter((c) => !c.command.startsWith(UNOWNED_PREFIX));
	const proven = ran.filter((c) => c.exitCode === 0);
	const failedCommand = commands.find((c) => typeof c.exitCode === "number" && c.exitCode !== 0);
	if (declared === "PASS" && proven.length && !failedCommand) return { caseId, verdict: "PASS", commands };
	if (failedCommand)
		return {
			caseId,
			verdict: "FAIL",
			commands,
			reason:
				declared === "PASS"
					? `the verdict says PASS but \`${failedCommand.command}\` exited ${failedCommand.exitCode} — the report contradicts itself, so this is not proven`
					: `\`${failedCommand.command}\` exited ${failedCommand.exitCode}`,
		};
	if (opts.exitCode !== undefined && opts.exitCode !== 0) return { caseId, verdict: "FAIL", commands, reason: `the verifier process exited ${opts.exitCode}` };
	if (declared === "FAIL") return { caseId, verdict: "FAIL", commands, reason: "the verifier declared FAIL" };
	if (declared === "PASS")
		return commands.some((c) => c.exitCode === 0)
			? { caseId, verdict: "PASS", commands }
			: { caseId, verdict: "UNVERIFIED", commands, reason: "declared PASS but no command reports an exit status of 0 — a claim without a status proves nothing" };
	return { caseId, verdict: "UNVERIFIED", commands, reason: "the verifier ran commands but never declared a verdict" };
};

export const buildReport = (cases: CaseEvidence[]): VerifyReport => ({
	cases,
	allPass: cases.length > 0 && cases.every((c) => c.verdict === "PASS"),
	unverified: cases.filter((c) => c.verdict === "UNVERIFIED").map((c) => c.caseId),
	failed: cases.filter((c) => c.verdict === "FAIL").map((c) => c.caseId),
	blocked: cases.filter((c) => c.verdict === "BLOCKED").map((c) => c.caseId),
});

export const needsHuman = (report: VerifyReport): string[] => [...report.unverified, ...(report.blocked ?? [])];

export const isPartial = (report: VerifyReport): boolean => report.failed.length > 0 && needsHuman(report).length > 0;

export interface VerifyAttempts {
	rounds: number;
	lastFingerprint?: string;
}

export const freshAttempts = (): VerifyAttempts => ({ rounds: 0 });

export const recordEvidence = (attempts: VerifyAttempts, report: VerifyReport): VerifyAttempts => ({ ...attempts, lastFingerprint: evidenceFingerprint(report) });

export const evidenceFingerprint = (report: VerifyReport): string =>
	report.cases
		.map((c) => `${c.caseId}:${c.verdict}:${c.commands.map((x) => `${x.command}=${x.exitCode ?? "?"}`).join(",")}`)
		.sort()
		.join("|");

export const UNUSABLE_REASON = /no command was run|never declared a verdict|no command reports an exit status|the report contradicts itself|the verifier never produced a verdict/i;

export const unusableCase = (c: CaseEvidence): boolean =>
	c.verdict === "BLOCKED" || UNUSABLE_REASON.test(c.reason ?? "") || (c.verdict === "UNVERIFIED" && !c.reason);

export const unusableCases = (report: VerifyReport): CaseEvidence[] => report.cases.filter(unusableCase);

export const isDeclaredFailure = (c: CaseEvidence): boolean => c.verdict === "FAIL" && !UNUSABLE_REASON.test(c.reason ?? "");

export const repairNote = (cases: CaseEvidence[], bound?: string): string =>
	[
		"⚠ your previous report was not usable as evidence — this is a FORMAT problem, not a code problem. Fix your report, do not change the repo:",
		...cases.map((c) => `  ${c.caseId}: ${c.reason ?? "no usable evidence"}`),
		"",
		"Do exactly this:",
		"  1. run the one command that exercises the case, and make it exit 0 (fix the probe, not the product, if it was broken)",
		"  2. write a line that says exactly `EVIDENCE:`, then one line per command with its own exit status on that same line, then your verdict line",
		"  3. keep quotes, narration and any failing command OUTSIDE that block — a non-zero status inside it is read as the case failing",
		...(bound ? [`  4. hard bound for a hanging command: ${bound}`] : []),
	].join("\n");

export type VerifyDecision =
	| { kind: "pass" }
	| { kind: "replan"; reason: string }
	| { kind: "human"; reason: string }
	| { kind: "halt"; reason: string };

export const MAX_LOOP_BATCHES = 3;

export const decideOnce = (report: VerifyReport, attempts: VerifyAttempts, maxBatches = MAX_LOOP_BATCHES): VerifyDecision => {
	if (report.allPass) return { kind: "pass" };
	const blocked = report.blocked ?? [];
	if (blocked.length) return { kind: "human", reason: `the verifier could not run at all for ${blocked.join(", ")} — a broken verifier is not evidence, so this is yours to check` };
	if (report.failed.length) {
		if (attempts.rounds > 0 && attempts.lastFingerprint === evidenceFingerprint(report))
			return { kind: "halt", reason: "identical evidence to the previous round — the same commands with the same results cannot prove anything new" };
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

export const buildHumanTestNote = (report: VerifyReport): string => {
	const human = report.cases.filter((c) => c.verdict === "UNVERIFIED" || c.verdict === "BLOCKED");
	const failing = report.cases.filter((c) => c.verdict === "FAIL");
	const lines = ["⚠ not proven — this needs a human:", ...human.map((c) => `  ${c.caseId}: ${c.reason ?? "could not be exercised directly"}`)];
	if (failing.length) {
		const passesNow = report.cases.filter((c) => c.verdict === "PASS").length;
		lines.push(`  ${failing.length} case(s) also still fail (${failing.map((c) => c.caseId).join(", ")}), so fixing this is not the only work left.`);
		lines.push(`  what was actually proven: ${passesNow} of ${report.cases.length} (${report.cases.filter((c) => c.verdict === "PASS").map((c) => c.caseId).join(", ") || "nothing"}).`);
	}
	lines.push("the change was left as it is; nothing else was run.");
	return lines.join("\n");
};

export const renderVerifyReport = (report: VerifyReport): string => {
	const head = report.allPass ? "✅ verified — every case is backed by executed evidence" : `❌ not verified — ${report.failed.length} failing, ${(report.unverified.length ?? 0) + (report.blocked?.length ?? 0)} unproven of ${report.cases.length}`;
	const lines = [head, ""];
	for (const c of report.cases) {
		const icon = c.verdict === "PASS" ? "✓" : c.verdict === "FAIL" ? "✗" : c.verdict === "BLOCKED" ? "⊘" : "?";
		lines.push(`${icon} ${c.caseId} ${c.verdict}${c.reason ? ` — ${c.reason}` : ""}`);
		for (const cmd of c.commands) lines.push(`    $ ${cmd.command}${typeof cmd.exitCode === "number" ? ` → exit ${cmd.exitCode}` : ""}`);
	}
	return lines.join("\n").trimEnd();
};
