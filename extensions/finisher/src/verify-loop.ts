import { declaredResult, extractCommands, infraFailure, UNOWNED_PREFIX, type CaseResult, type EvidenceCommand } from "./evidence.ts";

export { declaredResult, extractCommands } from "./evidence.ts";
export type { CaseResult, EvidenceCommand } from "./evidence.ts";

export interface CaseEvidence {
	caseId: string;
	result: CaseResult;
	reason?: string;
	commands: EvidenceCommand[];
}

export interface VerifyReport {
	cases: CaseEvidence[];
	allPass: boolean;
	unverified: string[];
	failed: string[];
	blocked?: string[];
	humanChecks?: string[];
}

export const judgeCase = (caseId: string, output: string, opts: { exitCode?: number } = {}): CaseEvidence => {
	const commands = extractCommands(output);
	const declared = declaredResult(output);
	if (!output.trim() || infraFailure(output))
		return { caseId, result: "BLOCKED", commands, reason: `the verifier never produced a result — ${infraFailure(output) ?? "it returned nothing"}. This is not a failing case: nothing was exercised.` };
	if (declared === "UNVERIFIED")
		return { caseId, result: "UNVERIFIED", commands, reason: "the verifier could not exercise the change directly — a human must test this" };
	if (declared === "FAIL") return { caseId, result: "FAIL", commands, reason: "the verifier declared FAIL" };
	if (!commands.length)
		return { caseId, result: "UNVERIFIED", commands, reason: "no command was run — a claim without executed evidence proves nothing" };
	const ran = commands.filter((c) => !c.command.startsWith(UNOWNED_PREFIX));
	const proven = ran.filter((c) => c.exitCode === 0);
	const failedCommand = commands.find((c) => typeof c.exitCode === "number" && c.exitCode !== 0);
	if (declared === "PASS" && proven.length && !failedCommand) return { caseId, result: "PASS", commands };
	if (failedCommand)
		return {
			caseId,
			result: "FAIL",
			commands,
			reason:
				declared === "PASS"
					? `the result says PASS but \`${failedCommand.command}\` exited ${failedCommand.exitCode} — the report contradicts itself, so this is not proven`
					: `\`${failedCommand.command}\` exited ${failedCommand.exitCode}`,
		};
	if (opts.exitCode !== undefined && opts.exitCode !== 0) return { caseId, result: "FAIL", commands, reason: `the verifier process exited ${opts.exitCode}` };
	if (declared === "PASS")
		return commands.some((c) => c.exitCode === 0)
			? { caseId, result: "PASS", commands }
			: { caseId, result: "UNVERIFIED", commands, reason: "declared PASS but no command reports an exit status of 0 — a claim without a status proves nothing" };
	return { caseId, result: "UNVERIFIED", commands, reason: "the verifier ran commands but never declared a result" };
};

export const provenByMachine = (c: CaseEvidence): boolean => c.result === "PASS" || c.result === "HUMAN";

export const buildReport = (cases: CaseEvidence[]): VerifyReport => ({
	cases,
	allPass: cases.length > 0 && cases.every(provenByMachine),
	unverified: cases.filter((c) => c.result === "UNVERIFIED").map((c) => c.caseId),
	failed: cases.filter((c) => c.result === "FAIL").map((c) => c.caseId),
	blocked: cases.filter((c) => c.result === "BLOCKED").map((c) => c.caseId),
	humanChecks: cases.filter((c) => c.result === "HUMAN").map((c) => c.caseId),
});

export const needsHuman = (report: VerifyReport): string[] => [...report.unverified, ...(report.blocked ?? [])];

export const REPAIRABLE_REASON = /no command was named|never recorded|no command was run|no executed check|no executed command/i;

export const repairableCases = (report: VerifyReport): CaseEvidence[] =>
	report.cases.filter((c) => c.result === "UNVERIFIED" && REPAIRABLE_REASON.test(c.reason ?? ""));

export const humanOnly = (report: VerifyReport): CaseEvidence[] =>
	report.cases.filter((c) => c.result === "HUMAN" || (c.result === "UNVERIFIED" && !REPAIRABLE_REASON.test(c.reason ?? "")));

export const humanCheckNote = (report: VerifyReport): string =>
	(report.humanChecks ?? []).length
		? ["🧑 these cases are the human's to check — they are reported at the end and are NOT counted as a failure; never invent a command to fake them:", ...(report.humanChecks ?? []).map((c) => `  ${c}`)].join("\n")
		: "";

export const isPartial = (report: VerifyReport): boolean => report.failed.length > 0 && needsHuman(report).length > 0;

export interface VerifyAttempts {
	rounds: number;
	lastFingerprint?: string;
}

export const freshAttempts = (): VerifyAttempts => ({ rounds: 0 });

export const recordEvidence = (attempts: VerifyAttempts, report: VerifyReport): VerifyAttempts => ({ ...attempts, lastFingerprint: evidenceFingerprint(report) });

export const evidenceFingerprint = (report: VerifyReport): string =>
	report.cases
		.map((c) => `${c.caseId}:${c.result}:${c.commands.map((x) => `${x.command}=${x.exitCode ?? "?"}`).join(",")}`)
		.sort()
		.join("|");

export const UNUSABLE_REASON = /no command was run|never declared a result|no command reports an exit status|the report contradicts itself|the verifier never produced a result/i;

export const unusableCase = (c: CaseEvidence): boolean =>
	c.result === "BLOCKED" || UNUSABLE_REASON.test(c.reason ?? "") || (c.result === "UNVERIFIED" && !c.reason);

export const unusableCases = (report: VerifyReport): CaseEvidence[] => report.cases.filter(unusableCase);

export const isDeclaredFailure = (c: CaseEvidence): boolean => c.result === "FAIL" && !UNUSABLE_REASON.test(c.reason ?? "");

export const repairNote = (cases: CaseEvidence[], bound?: string): string =>
	[
		"⚠ your previous report was not usable as evidence — this is a FORMAT problem, not a code problem. Fix your report, do not change the repo:",
		...cases.map((c) => `  ${c.caseId}: ${c.reason ?? "no usable evidence"}`),
		"",
		"Do exactly this:",
		"  1. run the one command that exercises the case, and make it exit 0 (fix the check, not the product, if it was broken)",
		"  2. write a line that says exactly `EVIDENCE:`, then one line per command with its own exit status on that same line, then your result line",
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
	const repairable = repairableCases(report);
	if (repairable.length) {
		if (attempts.rounds >= maxBatches) return { kind: "halt", reason: `no command proved ${repairable.map((c) => c.caseId).join(", ")} after ${attempts.rounds} rounds — stopping instead of looping forever` };
		return { kind: "replan", reason: `no command proved ${repairable.map((c) => c.caseId).join(", ")}` };
	}
	return { kind: "human", reason: `nothing could be exercised directly (${report.unverified.join(", ") || "no case ran"}) — you have to test this yourself` };
};

export const buildReplanPrompt = (report: VerifyReport, goal: string): string =>
	[
		`verification failed for: ${goal}`,
		...report.cases.filter((c) => c.result !== "PASS").map((c) => `  ${c.caseId}: ${c.result} — ${c.reason ?? "no reason"}`),
		"plan the next loop yourself: decide what to change, do it, then verify once at the end again.",
		"do not re-run the test suite as proof.",
	].join("\n");

export const buildHumanTestNote = (report: VerifyReport): string => {
	const human = humanOnly(report);
	const failing = report.cases.filter((c) => c.result === "FAIL");
	const lines = ["⚠ not proven — this needs a human:", ...human.map((c) => `  ${c.caseId}: ${c.reason ?? "could not be exercised directly"}`)];
	if (failing.length) {
		const passesNow = report.cases.filter((c) => c.result === "PASS").length;
		lines.push(`  ${failing.length} case(s) also still fail (${failing.map((c) => c.caseId).join(", ")}), so fixing this is not the only work left.`);
		lines.push(`  what was actually proven: ${passesNow} of ${report.cases.length} (${report.cases.filter((c) => c.result === "PASS").map((c) => c.caseId).join(", ") || "nothing"}).`);
	}
	lines.push("the change was left as it is; nothing else was run.");
	return lines.join("\n");
};

export const renderVerifyReport = (report: VerifyReport): string => {
	const human = report.cases.filter((c) => c.result === "HUMAN");
	const head = report.allPass
		? human.length
			? `✅ verified — every machine-checkable case is backed by executed evidence; ${human.length} case(s) are yours to check`
			: "✅ verified — every case is backed by executed evidence"
		: `❌ not verified — ${report.failed.length} failing, ${(report.unverified.length ?? 0) + (report.blocked?.length ?? 0)} unproven of ${report.cases.length}`;
	const lines = [head, ""];
	for (const c of report.cases) {
		const icon = c.result === "PASS" ? "✓" : c.result === "FAIL" ? "✗" : c.result === "HUMAN" ? "🧑" : c.result === "BLOCKED" ? "⊘" : "?";
		lines.push(`${icon} ${c.caseId} ${c.result}${c.reason ? ` — ${c.reason}` : ""}`);
		for (const cmd of c.commands) lines.push(`    $ ${cmd.command}${typeof cmd.exitCode === "number" ? ` → exit ${cmd.exitCode}` : ""}`);
	}
	if (human.length) lines.push("", "🧑 your check — reported, not a failure:", ...human.map((c) => `  ${c.caseId}${c.reason ? ` — ${c.reason}` : ""}`));
	return lines.join("\n").trimEnd();
};
