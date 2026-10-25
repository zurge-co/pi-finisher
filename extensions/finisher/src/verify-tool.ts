import { Type, type TSchema } from "typebox";
import { type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildGoalToolText, goalDriverDone, nextGoalDriverStep, resumeOrStart, type GoalRunState } from "./goal-driver.ts";
import { caseKey, NON_GOAL_PREFIX, unconfirmedGoalNote } from "./goal-confirm.ts";
import { buildReport, freshAttempts, renderVerifyReport, type CaseEvidence, type VerifyReport } from "./verify-loop.ts";
import { judgeChecks } from "./evidence-record.ts";
import { appendRecord, doneRecord, gapRecord, journalEnabled, journalPath } from "./lap-journal.ts";
import { reportWithDecisions, writeDecisionsFile } from "./decisions.ts";
import { planOf, verifyGate } from "./goal-phase.ts";
import { readToolTimeout } from "./timeout.ts";
import { type HarnessContext } from "./kit.ts";
import { writeReportFile } from "./report-file.ts";
import { appendCommand } from "./command-record.ts";
import { appendCheck, checkFileLines, type CheckEntry, type CheckStatus } from "./check-file.ts";
import { changedPaths, checkLine, checkStatusOf, detectChecks, failingChecks, freshCalls, readPackage, runCheckStage, runCommand, type CheckOutcome, type CheckResult } from "./verify-checks.ts";
import { type CaseResult } from "./evidence.ts";

export const VERIFY_TOOL = "finisher_verify";

export const VERIFY_STAGE_TIMEOUT_MS = 600_000;

export interface CaseCommand {
	id: string;
	command: string;
}

export interface CaseClaim {
	id: string;
	command?: string;
	human: boolean;
	note?: string;
}

export const caseClaims = (input: unknown): CaseClaim[] => {
	const out: CaseClaim[] = [];
	if (!Array.isArray(input)) return out;
	for (const raw of input) {
		const entry = raw as { id?: unknown; case?: unknown; command?: unknown; human?: unknown; note?: unknown };
		const id = typeof entry.id === "string" ? entry.id.trim() : typeof entry.case === "string" ? entry.case.trim() : "";
		const command = typeof entry.command === "string" ? entry.command.trim() : "";
		const human = entry.human === true;
		const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 160) : "";
		if (!id || (!command && !human)) continue;
		out.push({ id, human, ...(command ? { command } : {}), ...(note ? { note } : {}) });
	}
	return out;
};

export interface BoundClaims {
	commands: Map<string, string>;
	human: Map<string, string>;
	bound: Map<string, string>;
	unbound: { id: string; candidates: string[] }[];
}

const BARE_MIN = 8;
const INSIDE_MIN = 12;

const withoutTruncation = (id: string): string => id.replace(/[…]+|\s*\.{2,}\s*$/g, "").trim();

export const VERB_LEAD = /^(?:fix|make|prove|do|ensure|verify|check|test|rerun|re-run)\s+/i;

export const REMEDY_MARK = /\s+(?:—|–|::|\|)\s+/;

export const claimKey = (id: string): { verbatim: string; withoutRemedy: string; withoutLead: string } => {
	const verbatim = caseKey(withoutTruncation(id));
	const withoutRemedy = verbatim.split(REMEDY_MARK)[0].trim();
	return { verbatim, withoutRemedy, withoutLead: withoutRemedy.replace(VERB_LEAD, "").trim() };
};

const claimKeys = (id: string): string[] => {
	const keys = claimKey(id);
	return [...new Set([keys.verbatim, keys.withoutRemedy, keys.withoutLead])].filter((k) => k.length > 0);
};

const matchKey = (cases: string[], key: string): string[] => {
	const whole = cases.filter((c) => caseKey(c) === key);
	if (whole.length === 1) return whole;
	const namesACase = cases.filter((c) => caseKey(c).length >= BARE_MIN && key.startsWith(caseKey(c)));
	if (namesACase.length === 1) return namesACase;
	const prefix = key.length >= BARE_MIN ? cases.filter((c) => caseKey(c).startsWith(key)) : [];
	if (prefix.length === 1) return prefix;
	const inside = key.length >= INSIDE_MIN ? cases.filter((c) => caseKey(c).includes(key)) : [];
	if (inside.length === 1) return inside;
	return [...new Set([...namesACase, ...prefix, ...inside])];
};

const candidatesFor = (cases: string[], id: string): string[] => {
	if (!caseKey(id)) return [];
	const exact = cases.filter((c) => c === id || caseKey(c) === caseKey(id));
	if (exact.length) return exact;
	const keys = claimKeys(id);
	for (const key of keys) {
		const hits = matchKey(cases, key);
		if (hits.length === 1) return hits;
	}
	return [...new Set(keys.flatMap((key) => matchKey(cases, key)))];
};

export const bindClaims = (cases: string[], claims: CaseClaim[]): BoundClaims => {
	const commands = new Map<string, string>();
	const human = new Map<string, string>();
	const bound = new Map<string, string>();
	const unbound: { id: string; candidates: string[] }[] = [];
	for (const claim of claims) {
		const hits = candidatesFor(cases, claim.id);
		if (hits.length !== 1) {
			unbound.push({ id: claim.id, candidates: hits });
			continue;
		}
		const target = hits[0];
		bound.set(claim.id, target);
		if (claim.human) {
			human.set(target, claim.note ?? "");
			commands.delete(target);
		} else if (claim.command) {
			commands.set(target, claim.command);
			human.delete(target);
		}
	}
	return { commands, human, bound, unbound };
};

export const unboundNote = (unbound: { id: string; candidates: string[] }[]): string =>
	unbound.length
		? [
				`⚠ ${unbound.length} named case id(s) matched no single case, so their commands prove nothing — name the case's exact text instead:`,
				...unbound.map((u) => `  ${u.id}${u.candidates.length ? ` (matches ${u.candidates.length} cases)` : " (matches no case)"}`),
				...(unbound.filter((u) => u.candidates.length).length
					? ["", "the ids it could mean — copy one verbatim:", ...unbound.flatMap((u) => u.candidates.slice(0, 6).map((c) => `  ${c}`))]
					: []),
			].join("\n")
		: "";

export const judgeDeterministic = (
	cases: string[],
	commands: Map<string, string>,
	calls: { command: string; ok: boolean }[],
	checks: CheckResult[],
	run?: (command: string) => CheckResult,
	human?: Map<string, string>,
): CaseEvidence[] => {
	const broke = failingChecks(checks);
	return cases.map((caseId) => {
		if (broke.length)
			return {
				caseId,
				result: "FAIL" as const,
				commands: [],
				reason: `the deterministic check \`${broke[0].command}\` exited ${broke[0].exitCode} — a repo that does not pass its own checks cannot satisfy a case`,
			};
		if (human?.has(caseId))
			return {
				caseId,
				result: "HUMAN" as const,
				commands: [],
				reason: `${human.get(caseId) || "this one is the human's to check"} — reported at the end, never counted as a failure`,
			};
		const command = commands.get(caseId);
		if (!command)
			return { caseId, result: "UNVERIFIED" as const, commands: [], reason: "no command was named for this case — a case with no executed check is not proven" };
		const recorded = judgeChecks(calls, [command]);
		if (recorded.result !== "UNVERIFIED" || !run) return { caseId, result: recorded.result, commands: [], ...(recorded.reason ? { reason: recorded.reason } : {}) };
		const ran = run(command);
		return {
			caseId,
			result: ran.exitCode === 0 ? ("PASS" as const) : ("FAIL" as const),
			commands: [],
			reason: ran.exitCode === 0 ? undefined : `\`${command}\` exited ${ran.exitCode} when the harness ran it: ${ran.tail.split("\n").slice(-3).join(" ")}`,
		};
	});
};

export const verifySummaryLines = (checks: CheckResult[], report: VerifyReport): string[] => {
	const lines = checks.length ? [`deterministic stage: ${checks.map((c) => checkSummaryMark(c)).join(" · ")}`] : ["deterministic stage: no typecheck/lint/test script found in package.json"];
	for (const r of failingChecks(checks)) lines.push("", checkLine(r));
	return [...lines, "", renderVerifyReport(report)];
};

const CHECK_MARK: Record<CheckOutcome, string> = {
	pass: "ok",
	fail: "FAILED",
	infra: "skipped (it could not run here)",
	deadline: "TIMEOUT (it hit its deadline)",
	scoped: "not run (no change can affect it)",
};

export const checkSummaryMark = (check: CheckResult): string => {
	const status = checkStatusOf(check);
	if (status === "fail") return `${check.name} FAILED (${check.exitCode})`;
	return `${check.name} ${CHECK_MARK[status] ?? status}`;
};

export const CHECK_RESULT_STATUS: Record<CaseResult, CheckStatus> = { PASS: "pass", FAIL: "fail", UNVERIFIED: "unverified", BLOCKED: "infra", HUMAN: "unverified" };

export const caseCheckEntries = (evidence: CaseEvidence[], commands: Map<string, string>, goal?: string, at = Date.now()): CheckEntry[] =>
	evidence.map((c) => {
		const command = commands.get(c.caseId);
		return {
			at,
			case: c.caseId,
			status: CHECK_RESULT_STATUS[c.result] ?? "unverified",
			...(goal ? { goal } : {}),
			...(command ? { command } : {}),
			...(c.reason ? { output: c.reason } : {}),
		};
	});

export const verifyToolDefinition = (ctx: HarnessContext): ToolDefinition<TSchema, Record<string, unknown>> => {
	const persist = ctx.persist;
	const state = ctx.state;
	const updateWidget = ctx.updateWidget;
	const armGoalRound = ctx.armGoalRound;

	return {
		name: VERIFY_TOOL,
		label: "finisher · verify",
		description:
			"Verify a confirmed goal yourself — no sub-agent is spawned. Stage 1 runs the repo's own checks (typecheck, lint, test scripts) through a scoped, parallel, cached plan: a check whose changed paths cannot affect it is skipped, a green recording made after the last edit is not re-run, and a toolchain that cannot run here is reported as skipped instead of failing every case. Stage 2 judges each case from the commands the harness itself watched you run: name one command per case, and a case whose command was never recorded stays UNVERIFIED. Every case outcome is written to .finisher/checks.",
		promptSnippet: "Verify the goal deterministically first, from commands the harness recorded",
		promptGuidelines: [
			`Call ${VERIFY_TOOL} once after every lap is closed with finisher_phase done — it is refused while a lap is still open.`,
			"Name one command per case (cases: [{ id, command }]) that actually exercises it. A case with no recorded command is UNVERIFIED — never claim PASS for it.",
			"Proof is a recorded check, not another test: verify writes one line per case to .finisher/checks (PASS/FAIL/SKIP/UNVERIFIED) — never add a test file to prove a case.",
			"A case only the human can check is separated, not failed: pass { id, human: true, note } and it is listed in the report for them at the end.",
			"If the deterministic stage fails, fix the cause and call it again: the failing check is quoted back to you.",
			"A not-passing result hands the next loop back to you: fix it, use finisher_swarm to get coders working in parallel, then verify again.",
			"Do not spawn a sub-agent to verify — you are the verifier, and the harness records what you actually ran.",
		],
		parameters: Type.Object({
			cases: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "the case id (or its exact text — a truncated id binds when it matches exactly one case) this claim is about" }),
						command: Type.Optional(Type.String({ description: "the command you ran that exercises this case — required unless human is true" })),
						human: Type.Optional(Type.Boolean({ description: "true when only the human can check this case: it is reported to them at the end and never counted as a failure" })),
						note: Type.Optional(Type.String({ description: "what the human should look at, when human is true" })),
					}),
					{ description: "one claim per case — a command, or human: true for what only a human can check. A case left out stays UNVERIFIED" },
				),
			),
			goal: Type.Optional(Type.String({ description: "the goal being verified (only needed when no goal is open)" })),
			skipDeterministic: Type.Optional(Type.Boolean({ description: "skip stage 1 (only when the repo has no checks that apply)" })),
		}),
		async execute(_id: string, p: any, _sig: AbortSignal | undefined, _on: unknown, toolCtx: ExtensionContext) {
			const active = state.goalDriver as GoalRunState | undefined;
			const gate = verifyGate(planOf(active as { phases?: never; lap?: number } | undefined));
			if (gate.allowed === false) return { content: [{ type: "text", text: gate.note }], details: { gated: true }, isError: true };

			const cwd = toolCtx.cwd;
			const timeoutMs = Math.min(readToolTimeout(cwd, VERIFY_TOOL), VERIFY_STAGE_TIMEOUT_MS);
			const pkg = readPackage(cwd);
			const stage = p.skipDeterministic
				? { results: [] as CheckResult[], ran: [], recorded: [], scoped: [] }
				: await runCheckStage(detectChecks(pkg), { cwd, timeoutMs, pkg, lastModifiedAt: state.lastModifiedAt, changed: changedPaths(cwd), calls: state.verifyCalls ?? [] });
			const checks = stage.results;

			const openGoal = !!active && !goalDriverDone(active);
			const cases = openGoal ? (active.cases ?? []) : (p.goal ? [p.goal] : []);
			const named = bindClaims(cases, caseClaims(p.cases));
			const calls = freshCalls((state.verifyCalls ?? []) as { command: string; ok: boolean; at?: number }[], state.lastModifiedAt);
			const evidence = judgeDeterministic(cases, named.commands, calls, checks, (command) => {
				const result = runCommand(command, cwd, timeoutMs);
				state.verifyCalls = appendCommand(state.verifyCalls ?? [], { toolName: "bash", input: { command }, isError: result.exitCode !== 0 });
				return result;
			}, named.human);
			const report = buildReport(evidence);
			const verified = `${NON_GOAL_PREFIX}${evidence.map((c) => c.caseId).join(", ") || "run"}`;
			const driver = openGoal ? active : { ...resumeOrStart(undefined, p.goal?.trim() || verified, Date.now(), cases), attempts: freshAttempts() };
			const step = nextGoalDriverStep(driver, report);
			const entries = caseCheckEntries(evidence, named.commands, openGoal ? active.goal : p.goal?.trim());
			for (const entry of entries) appendCheck(cwd, entry);
			const summary = [verifySummaryLines(checks, report).join("\n"), ["evidence: .finisher/checks/checks.jsonl", ...checkFileLines(entries, cases)].join("\n"), unboundNote(named.unbound)].filter(Boolean).join("\n\n");

			if (!openGoal) {
				persist();
				updateWidget(toolCtx);
				return {
					content: [{ type: "text", text: [summary, "", unconfirmedGoalNote(report.allPass), "", step.text].join("\n") }],
					details: { report, verifiedOnly: true, checks, decision: { kind: step.action } },
					...(report.allPass ? {} : { isError: true }),
				};
			}
			const finalText = reportWithDecisions(step.text, state.decisions ?? []);
			if (step.action !== "replan") writeDecisionsFile(cwd, driver.goal, state.decisions ?? []);
			const before = state.goalDriver as GoalRunState;
			state.goalDriver = step.state;
			if (step.action !== "replan") {
				const written = writeReportFile(cwd, {
					goal: driver.goal,
					outcome: step.state.outcome ?? "halted",
					at: step.state.doneAt ?? Date.now(),
					laps: (step.state.phases ?? []).length,
					round: step.round,
					body: [summary, "", finalText].join("\n"),
				});
				if (written) state.lastReport = written;
			}
			persist();
			updateWidget(toolCtx);
			if (journalEnabled()) {
				const journal = journalPath();
				const plan = (state.goalDriver as GoalRunState).phases ?? [];
				if (step.action === "replan")
					appendRecord(
						journal,
						gapRecord({
							repo: cwd,
							goal: driver.goal,
							round: step.round,
							lap: Math.min(plan.length, Math.max(1, state.goalDriver.lap ?? 1)),
							laps: plan.length,
							added: plan.slice((before.phases ?? []).length).map((ph) => ph.text),
							cases: report.cases.map((c) => ({ id: c.caseId, result: c.result, ...(c.reason ? { reason: c.reason } : {}) })),
							models: [],
							outcome: step.action,
						}),
					);
				if (step.action !== "replan")
					appendRecord(journal, doneRecord({ repo: cwd, goal: driver.goal, rounds: step.round, laps: plan.length, outcome: step.state.outcome ?? "halted" }));
			}
			if (step.action === "replan") armGoalRound(step.text);
			return {
				content: [{ type: "text", text: [buildGoalToolText(driver, step, finalText), "", summary].join("\n") }],
				details: { report, checks, decision: { kind: step.action }, step: step.action, outcome: step.state.outcome },
				...(report.allPass ? {} : { isError: true }),
			};
		},
	} as unknown as ToolDefinition<TSchema, Record<string, unknown>>;
};
