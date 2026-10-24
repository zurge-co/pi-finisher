import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export const VERIFY_TOOL = "finisher_verify";

export const VERIFY_STAGE_TIMEOUT_MS = 600_000;

export interface DeterministicCheck {
	name: string;
	command: string;
	args: string[];
}

export const CHECK_ORDER = ["typecheck", "lint", "test"] as const;

export const detectChecks = (pkg: { scripts?: Record<string, unknown> } | undefined): DeterministicCheck[] => {
	const scripts = pkg?.scripts ?? {};
	const found: DeterministicCheck[] = [];
	for (const name of CHECK_ORDER) {
		const body = scripts[name];
		if (typeof body !== "string" || !body.trim()) continue;
		found.push({ name, command: "npm", args: ["run", "--silent", name] });
	}
	return found;
};

export const readPackage = (cwd: string): { scripts?: Record<string, unknown> } | undefined => {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, unknown> };
	} catch {
		return undefined;
	}
};

export interface CheckResult {
	name: string;
	command: string;
	exitCode: number;
	tail: string;
}

export const checkLine = (r: CheckResult): string => `$ ${r.command}\n   exit ${r.exitCode}${r.tail ? `\n   ${r.tail.split("\n").slice(-6).join("\n   ")}` : ""}`;

export const failingChecks = (results: CheckResult[]): CheckResult[] => results.filter((r) => r.exitCode !== 0);

export const runCheck = (check: DeterministicCheck, cwd: string, timeoutMs: number): CheckResult => {
	const label = `${check.command} ${check.args.join(" ")}`;
	try {
		const out = execFileSync(check.command, check.args, { cwd, timeout: Math.max(1_000, timeoutMs), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
		return { name: check.name, command: label, exitCode: 0, tail: String(out ?? "").trim() };
	} catch (err) {
		const e = err as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown; message?: string };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const exitCode = typeof e.status === "number" ? e.status : e.signal ? 124 : 1;
		const tail = `${stdout}\n${stderr}`.trim() || (e.message ?? "the check produced no output");
		return { name: check.name, command: label, exitCode, tail };
	}
};

export const runChecks = (checks: DeterministicCheck[], cwd: string, timeoutMs: number): CheckResult[] => checks.map((check) => runCheck(check, cwd, timeoutMs));

export const runCommand = (command: string, cwd: string, timeoutMs: number): CheckResult => {
	const label = command;
	try {
		const out = execFileSync("bash", ["-lc", command], { cwd, timeout: Math.max(1_000, timeoutMs), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
		return { name: command, command: label, exitCode: 0, tail: String(out ?? "").trim() };
	} catch (err) {
		const e = err as { status?: number | null; signal?: string | null; stdout?: unknown; stderr?: unknown; message?: string };
		const stdout = typeof e.stdout === "string" ? e.stdout : "";
		const stderr = typeof e.stderr === "string" ? e.stderr : "";
		const exitCode = typeof e.status === "number" ? e.status : e.signal ? 124 : 1;
		return { name: command, command: label, exitCode, tail: `${stdout}\n${stderr}`.trim() || (e.message ?? "the command produced no output") };
	}
};

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

const candidatesFor = (cases: string[], id: string): string[] => {
	const key = caseKey(id);
	if (!key) return [];
	const exact = cases.filter((c) => c === id || caseKey(c) === key);
	if (exact.length) return exact;
	const bare = caseKey(withoutTruncation(id));
	const prefix = bare.length >= BARE_MIN ? cases.filter((c) => caseKey(c).startsWith(bare)) : [];
	if (prefix.length === 1) return prefix;
	const inside = bare.length >= INSIDE_MIN ? cases.filter((c) => caseKey(c).includes(bare)) : [];
	if (inside.length === 1) return inside;
	return [...new Set([...prefix, ...inside])];
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
				verdict: "FAIL" as const,
				commands: [],
				reason: `the deterministic check \`${broke[0].command}\` exited ${broke[0].exitCode} — a repo that does not pass its own checks cannot satisfy a case`,
			};
		if (human?.has(caseId))
			return {
				caseId,
				verdict: "HUMAN" as const,
				commands: [],
				reason: `${human.get(caseId) || "this one is the human's to check"} — reported at the end, never counted as a failure`,
			};
		const command = commands.get(caseId);
		if (!command)
			return { caseId, verdict: "UNVERIFIED" as const, commands: [], reason: "no command was named for this case — a case with no executed check is not proven" };
		const recorded = judgeChecks(calls, [command]);
		if (recorded.verdict !== "UNVERIFIED" || !run) return { caseId, verdict: recorded.verdict, commands: [], ...(recorded.reason ? { reason: recorded.reason } : {}) };
		const ran = run(command);
		return {
			caseId,
			verdict: ran.exitCode === 0 ? ("PASS" as const) : ("FAIL" as const),
			commands: [],
			reason: ran.exitCode === 0 ? undefined : `\`${command}\` exited ${ran.exitCode} when the harness ran it: ${ran.tail.split("\n").slice(-3).join(" ")}`,
		};
	});
};

export const verifySummaryLines = (checks: CheckResult[], report: VerifyReport): string[] => {
	const lines = checks.length ? [`deterministic stage: ${checks.map((c) => `${c.name} ${c.exitCode === 0 ? "ok" : `FAILED (${c.exitCode})`}`).join(" · ")}`] : ["deterministic stage: no typecheck/lint/test script found in package.json"];
	for (const r of failingChecks(checks)) lines.push("", checkLine(r));
	return [...lines, "", renderVerifyReport(report)];
};

export const verifyToolDefinition = (ctx: HarnessContext): ToolDefinition<TSchema, Record<string, unknown>> => {
	const persist = ctx.persist;
	const state = ctx.state;
	const updateWidget = ctx.updateWidget;
	const armGoalRound = ctx.armGoalRound;

	return {
		name: VERIFY_TOOL,
		label: "finisher · verify",
		description:
			"Verify a confirmed goal yourself — no sub-agent is spawned. Stage 1 runs the repo's own deterministic checks (typecheck, lint, test scripts from package.json) and a failing check fails every case immediately. Stage 2 judges each case from the commands the harness itself watched you run: name one command per case, and a case whose command was never recorded stays UNVERIFIED. Passing every case ends the goal; a failure hands the next loop back to you.",
		promptSnippet: "Verify the goal deterministically first, from commands the harness recorded",
		promptGuidelines: [
			`Call ${VERIFY_TOOL} once after every lap is closed with finisher_phase done — it is refused while a lap is still open.`,
			"Name one command per case (cases: [{ id, command }]) that actually exercises it. A case with no recorded command is UNVERIFIED — never claim PASS for it.",
			"A case only the human can check is separated, not failed: pass { id, human: true, note } and it is listed in the report for them at the end.",
			"If the deterministic stage fails, fix the cause and call it again: the failing check is quoted back to you.",
			"A not-passing verdict hands the next loop back to you: fix it, use finisher_swarm to get coders working in parallel, then verify again.",
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
			const checks = p.skipDeterministic ? [] : runChecks(detectChecks(readPackage(cwd)), cwd, timeoutMs);

			const openGoal = !!active && !goalDriverDone(active);
			const cases = openGoal ? (active.cases ?? []) : (p.goal ? [p.goal] : []);
			const named = bindClaims(cases, caseClaims(p.cases));
			const calls = (state.verifyCalls ?? []) as { command: string; ok: boolean }[];
			const evidence = judgeDeterministic(cases, named.commands, calls, checks, (command) => {
				const result = runCommand(command, cwd, timeoutMs);
				state.verifyCalls = appendCommand(state.verifyCalls ?? [], { toolName: "bash", input: { command }, isError: result.exitCode !== 0 });
				return result;
			}, named.human);
			const report = buildReport(evidence);
			const verified = `${NON_GOAL_PREFIX}${evidence.map((c) => c.caseId).join(", ") || "run"}`;
			const driver = openGoal ? active : { ...resumeOrStart(undefined, p.goal?.trim() || verified, Date.now(), cases), attempts: freshAttempts() };
			const step = nextGoalDriverStep(driver, report);
			const summary = [verifySummaryLines(checks, report).join("\n"), unboundNote(named.unbound)].filter(Boolean).join("\n\n");

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
							cases: report.cases.map((c) => ({ id: c.caseId, verdict: c.verdict, ...(c.reason ? { reason: c.reason } : {}) })),
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
