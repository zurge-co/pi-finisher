
import { existsSync } from "node:fs";
import { type Criterion, type Spec } from "./types.ts";
import { type ProbeResult } from "./evidence.ts";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface GradeParse {
	perCriteria: Record<string, "PASS" | "FAIL">;
	evidence: Record<string, string>;
	failedIds: string[];
	missingIds: string[];      	passNoEvidence: string[];  	overall: "PASS" | "FAIL" | null;
}

export const parseGraderOutput = (output: string, criteria: Criterion[]): GradeParse => {
	const perCriteria: Record<string, "PASS" | "FAIL"> = {};
	const evidence: Record<string, string> = {};
	for (const c of criteria) {
				const m = output.match(new RegExp(`^\\s*${escapeRe(c.id)}[ \\t]*:[ \\t]*(PASS|FAIL)\\b[ \\t]*:?[ \\t]*([^\\r\\n]*)$`, "im"));
		if (m) {
			perCriteria[c.id] = m[1].toUpperCase() as "PASS" | "FAIL";
			evidence[c.id] = (m[2] ?? "").trim();
		}
	}
	const om = output.match(/^\s*OVERALL\s*:\s*(PASS|FAIL)\b/im);
	return {
		perCriteria,
		evidence,
		failedIds: criteria.filter((c) => perCriteria[c.id] === "FAIL").map((c) => c.id),
		missingIds: criteria.filter((c) => !(c.id in perCriteria)).map((c) => c.id),
		passNoEvidence: criteria.filter((c) => perCriteria[c.id] === "PASS" && !evidence[c.id]).map((c) => c.id),
		overall: om ? (om[1].toUpperCase() as "PASS" | "FAIL") : null,
	};
};

export const buildGraderPrompt = (spec: Spec, probes: ProbeResult[], diffSummary: string, feedback: string): string =>
	`You are the OUTPUT-EVAL grader. Judge each acceptance criterion from EVIDENCE ONLY — the probe results below were executed by the harness itself and are ground truth. You have NO write/edit tools; never modify the repo (if a check truly needs a fixture, create it in a tmp dir only).\n\n` +
	`Reward-hacking checklist (auto-FAIL the related criteria if found): tests weakened/deleted/skipped, assertions removed, writes outside spec scope, placeholder or stub code claimed as done. Compare the change summary below against the spec scope.\n\n` +
	`Probe status guide: FAIL = the harness ran the check and the artifact does NOT satisfy it (authoritative — do not PASS that criterion). SKIPPED = the harness could not judge (manual check, or the check command itself is malformed/errored) — SKIPPED is NOT evidence of artifact failure; verify that criterion yourself with read-only commands and judge on the evidence you gather.\n\n` +
	`Criteria & probe results (harness-executed, authoritative):\n${spec.criteria
		.map((c, i) => {
			const p = probes[i];
			const r = p ? `${p.status.toUpperCase()}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${p.detail}` : "n/a";
			return `- ${c.id}: ${c.text}\n  check: ${c.check}\n  probe: ${r}`;
		})
		.join("\n")}\n\n` +
	`Spec scope (writes must stay inside): ${spec.scope.join(", ") || "(none declared)"}\n\n` +
	(diffSummary ? `Change summary (git, at eval time):\n${diffSummary}\n\n` : "") +
	`Output STRICTLY (one line per criterion; evidence is MANDATORY — cite the probe result or a command you ran + its output. A PASS without evidence is rejected):\n` +
	`<id>: PASS: <evidence>\n<id>: FAIL: <evidence>\n…\nOVERALL: PASS|FAIL\n` +
	`No extra commentary. The last line must be exactly 'OVERALL: PASS' or 'OVERALL: FAIL'.` +
	(feedback ? `\n\nSYSTEM FEEDBACK: your previous response was rejected: ${feedback}. Return the corrected format only.` : "");

const oneLineEvidence = (s: string, max = 120): string => {
	const line = (s ?? "").split("\n")[0].trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const buildCompactProbeSection = (probes: ProbeResult[]): string => {
	const passIds = probes.filter((p) => p.status === "pass").map((p) => p.id);
	const lines = probes
		.filter((p) => p.status !== "pass")
		.map((p) => `- ${p.id}: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${oneLineEvidence(p.detail, 200)}`);
	if (passIds.length) lines.push(`probes pass: ${passIds.join(",")}`);
	return `\n\n## Probes (harness-executed, authoritative)\n${lines.join("\n") || "(no probes)"}`;
};

export interface EvalResultView {
	verdict: string;
	criteria: Criterion[];
	perCriteria: Record<string, "PASS" | "FAIL">;
	evidence: Record<string, string>;
	failedIds: string[];
	probeOverrides: string[];
	probes: ProbeResult[];
	trajectory: string[];
	specDebt: string[];
	logPath: string; }

export const buildEvalResultText = (v: EvalResultView): string => {
	const out: string[] = [
		v.verdict === "PASS"
			? "✅ Eval PASS — next step (mandatory): call `zense_review` immediately so the reviewer sub-agent builds the review packet — do not summarize or close out with the user until zense_review has been called"
			: "❌ Eval FAIL — go fix it, then call zense_eval again (do not proceed to review until it passes)",
	];
	if (v.verdict === "FAIL") {
		out.push(`failing criteria: ${v.failedIds.length ? v.failedIds.join(", ") : "(overall FAIL — see the evidence below or the full log)"}`);
		if (v.probeOverrides.length)
			out.push(
				`⚠ probe override → FAIL [${v.probeOverrides.join(", ")}]: the harness ran the check itself and it failed despite the grader's PASS — two possible causes: (1) the artifact is genuinely wrong → read the probe detail below and fix it; (2) the spec's check command itself is broken (placeholder/wrong path — no artifact change will ever pass) → commit a new zense_spec version with a fixed check and re-sign`,
			);
	}
		const showIds = v.verdict === "FAIL" ? new Set(v.failedIds) : null;
	const critLines = v.criteria
		.filter((c) => !showIds || showIds.has(c.id))
		.map((c) => `- ${c.id}: ${v.perCriteria[c.id] ?? "?"} — ${oneLineEvidence(v.evidence[c.id] ?? "")}`);
	if (critLines.length) out.push("", "## Verdicts", ...critLines);
	out.push(buildCompactProbeSection(v.probes).slice(2)); 	out.push("", "## Trajectory flags", v.trajectory.join("\n") || "(none)");
	out.push("", "## Spec debt (needs human)", v.specDebt.join("\n") || "(none)");
	out.push("", `🧪 raw grader output (per-criterion detail) is in the log: ${v.logPath} — read it yourself if needed`);
	return out.join("\n");
};

export interface CrossCheckItem {
	goal: string;
	evidence: string;
}

export const buildReviewResultText = (opts: { ok: boolean; tlDr: string; trajectoryCount: number; escalationCount: number; logPath: string; errorOutput?: string; crossCheck?: CrossCheckItem[] }): string => {
	if (!opts.ok) return `reviewer failed: ${opts.errorOutput ?? "(no output)"}\n\n🧪 log: ${opts.logPath}`;
	const cross = opts.crossCheck?.length
		? `\n\n## Cross-check — your case → what was done\n${opts.crossCheck.map((c) => `- ${c.goal}\n  → ${c.evidence || "⚠ not mapped by the reviewer"}`).join("\n")}`
		: "";
	return `✅ Review packet ready — open the review card in the transcript\n\n${opts.tlDr}${cross}\n\ntrajectory flags: ${opts.trajectoryCount} · escalations: ${opts.escalationCount}\n\n🧪 the full packet (every section) is in the log: ${opts.logPath} — read it yourself if needed`;
};

export const buildReviewModalText = (opts: {
	tlDr: string;
	crossCheck?: CrossCheckItem[];
	trajectory: string[];
	specDebt: string[];
	escalations: { kind: string; detail: string }[];
	paths?: string[];
	logPath?: string;
	canAccept: boolean;
}): string =>
	[
		`## Review — TL;DR`,
		"",
		opts.tlDr || "(no summary)",
		"",
								opts.crossCheck?.length
			? `## Cross-check — your case → what was done\n${opts.crossCheck.map((c) => `- **${c.goal}**\n  → ${c.evidence || "⚠ not mapped by the reviewer"}`).join("\n")}`
			: "",
		opts.trajectory.length ? `⚠️ trajectory flags:\n${opts.trajectory.map((f) => `- ${f}`).join("\n")}` : "",
		opts.escalations.length ? `🚨 escalations:\n${opts.escalations.map((e) => `- ${e.kind}: ${e.detail}`).join("\n")}` : "",
		opts.specDebt.length ? `📋 spec debt (human-verified only):\n${opts.specDebt.map((d) => `- ${d}`).join("\n")}` : "",
		opts.paths?.length ? `staged change (${opts.paths.length} file(s)): ${opts.paths.join(", ")}` : "",
		opts.logPath ? `full packet + evidence: ${opts.logPath}` : "",
		"",
		opts.canAccept
			? "**[y] accept** — approve the work; the harness commits the staged change for you (nothing else happens until you press it)"
			: "(nothing is staged in main for this round — there is nothing to accept here)",
		"**[n] close** — decide later; nothing changes, the work stays exactly as it is",
	]
		.filter(Boolean)
		.join("\n");

export const COMMENT_DISCIPLINE_GUIDELINE = [
	"Code-comment discipline for this implementation phase (saves tokens; keep the code readable):",
	"- Comment only the non-obvious: WHY a decision was made, an invariant that must hold, or a trap/edge case.",
	"- Never narrate WHAT a line does (the code already says it). No banner/separator comments (// ---- style).",
	"- No JSDoc/docstring boilerplate on self-describing functions; document parameters only when non-obvious.",
	"- Leave TODO/FIXME only when real follow-up exists, with reason; do not scatter them as filler.",
	"- Applies to NEW code and lines you touch. Do not delete or rewrite existing decision-recording comments.",
].join("\n");

const REVIEW_SECTIONS = ["TL;DR", "Cross-check", "Intent vs Implementation", "Risks", "Rollback", "Human actions"] as const;

export interface PacketParse {
	ok: boolean;
	missing: string[];
	tldr: string;
	crossCheck: CrossCheckItem[];
}

export const parseCrossCheckItems = (text: string): CrossCheckItem[] => {
	const m = text.match(/^##\s*Cross-check\s*$/im);
	if (m?.index === undefined) return [];
	const rest = text.slice(m.index + m[0].length);
	const next = rest.search(/^##\s/m);
	const body = next === -1 ? rest : rest.slice(0, next);
	const out: CrossCheckItem[] = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		const bullet = line.match(/^[-*]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
		if (!bullet) continue;
		const item = bullet[1].replace(/\*\*/g, "").trim();
		if (!item) continue;
		const arrow = item.indexOf("→") >= 0 ? item.indexOf("→") : item.indexOf("->");
		const arrowLen = arrow >= 0 ? (item[arrow] === "→" ? 1 : 2) : 0;
		const goal = (arrow >= 0 ? item.slice(0, arrow) : item).trim();
		const evidence = (arrow >= 0 ? item.slice(arrow + arrowLen) : "").trim();
		if (goal) out.push({ goal, evidence });
	}
	return out;
};

export const mergeCrossCheck = (goals: string[], items: CrossCheckItem[]): CrossCheckItem[] => {
	const norm = (s: string): string => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
	const used = new Set<number>();
	const merged = goals.map((goal) => {
		let idx = items.findIndex((it, i) => !used.has(i) && norm(it.goal) === norm(goal));
		if (idx < 0)
			idx = items.findIndex((it, i) => !used.has(i) && (norm(it.goal).includes(norm(goal)) || norm(goal).includes(norm(it.goal))));
		if (idx < 0) return { goal, evidence: "" };
		used.add(idx);
		return { goal, evidence: items[idx].evidence };
	});
	items.forEach((it, i) => {
		if (!used.has(i)) merged.push(it);
	});
	return merged;
};

export const parseReviewerPacket = (text: string): PacketParse => {
	const missing = REVIEW_SECTIONS.filter((s) => !new RegExp(`^##\\s*${escapeRe(s)}\\s*$`, "im").test(text));
	let tldr = "";
	const m = text.match(/^##\s*TL;DR\s*$/im);
	if (m?.index !== undefined) {
		const rest = text.slice(m.index + m[0].length);
		const next = rest.search(/^##\s/m);
		tldr = (next === -1 ? rest : rest.slice(0, next)).trim().split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
	}
	return { ok: missing.length === 0, missing, tldr, crossCheck: parseCrossCheckItems(text) };
};

export const findUngroundedTokens = (packet: string, evidence: string, pathExists: (p: string) => boolean = existsSync): string[] => {
	const found = new Set<string>();
	const isPathy = (t: string) => t.includes("/") || /\.[a-z]{1,6}$/i.test(t);
	for (const m of packet.matchAll(/`([^`\n]+)`/g)) {
		const t = m[1].trim();
		if (!t || /\s/.test(t) || evidence.includes(t)) continue;
		const bare = t.replace(/:\d+$/, ""); 		if (isPathy(bare) && pathExists(bare)) continue;
		found.add(t);
	}
	for (const m of packet.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) if (!evidence.includes(m[0])) found.add(m[0]);
	for (const m of packet.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (!evidence.includes(m[0])) found.add(m[0]);
	return [...found];
};

export const isLastEvalStale = (
	lastEval: { specVersion?: number; head?: string } | undefined,
	current: { specVersion?: number; head?: string } | undefined,
): boolean => {
	if (!lastEval || !current) return false;
	if (current.specVersion !== undefined && lastEval.specVersion !== current.specVersion) return true;
	if (current.head !== undefined && lastEval.head !== current.head) return true;
	return false;
};

export const buildReviewerPrompt = (
	intent: string,
	lastEval: { verdict?: string; perCriteria?: Record<string, string>; failedIds?: string[]; probes?: ProbeResult[]; specVersion?: number; head?: string } | undefined,
	flags: string[],
	specDebt: string[],
	escalations: { kind: string; detail: string }[],
	gitSummary: string,
	feedback: string,
	freshness?: { specVersion?: number; head?: string },
	criteria?: { id?: string; text: string; check?: string }[],
	goals: string[] = [],
): string => {
	const stale = isLastEvalStale(lastEval, freshness);
	const ev = stale ? undefined : lastEval;
			const probeLines = (ev?.probes ?? [])
		.map((p) => `  - ${p.id}: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""} — ${p.detail.split("\n")[0].slice(0, 160)}`)
		.join("\n");
	const criteriaLines = (criteria ?? [])
		.map((c) => `  - ${c.id ?? "?"}: ${ev?.perCriteria?.[c.id ?? ""] ?? "?"} — ${c.text}${c.check ? ` [check: ${c.check}]` : ""}`)
		.join("\n");
	return `You are the REVIEWER sub-agent. The work is DONE and already machine-graded — ground every statement in the evidence below; never write \"to be implemented\".\n\n` +
	`Evidence:\n- Intent: ${intent}\n- Eval verdict: ${ev?.verdict ?? "(no eval record)"}` +
	(stale ? `\n- ⚠️ STALE eval evidence withheld: the stored zense_eval result belongs to an older spec version (v${lastEval?.specVersion ?? "?"}) or tree (${lastEval?.head?.slice(0, 8) ?? "?"}) — re-run zense_eval before trusting any eval verdict.` : "") +
	(criteriaLines ? `\n- Criteria verdicts (authoritative — id: verdict — text [check]):\n${criteriaLines}` : ev?.perCriteria && Object.keys(ev.perCriteria).length ? `\n- Per-criteria verdicts: ${Object.entries(ev.perCriteria).map(([id, v]) => `${id}=${v}`).join(", ")}` : "") +
	(probeLines ? `\n- Probe results (harness-executed, verbatim):\n${probeLines}` : "") +
	`\n- Trajectory flags: ${flags.length ? flags.join(" | ") : "(none)"}` +
	`\n- Spec debt (human-verified): ${specDebt.length ? specDebt.join(" | ") : "(none)"}` +
	`\n- Escalations: ${escalations.length ? escalations.map((e) => `${e.kind}: ${e.detail.slice(0, 80)}`).join(" | ") : "(none)"}` +
	(gitSummary ? `\n- Git evidence:\n${gitSummary}` : "") +
	(goals.length ? `\n- Cross-check cases (the human's signed request, verbatim — do NOT rewrite the goal text):\n${goals.map((g, i) => `  ${i + 1}. ${g}`).join("\n")}` : "") +
	`\n- Pipeline tools (for referencing only): zense_spec, zense_adr, zense_eval, zense_review\n\n` +
	`GROUNDING CONTRACT (hard rules):\n` +
	`- Every commit hash, file path, line number, identifier, env-var name and config key you mention MUST be copied VERBATIM from the Evidence block above — never invent or reconstruct one from memory.\n` +
	`- The Git evidence lists changed symbols with their files: cite those for the Cross-check section instead of guessing what the code does.\n` +
	`- Anything not present in the Evidence is NOT a fact: omit it, or move it to "Human actions" phrased as an open question.\n` +
	`- The TL;DR must state the eval verdict exactly as recorded and must not contradict per-criteria verdicts, trajectory flags or escalations.\n\n` +
	`Produce an incident-report-style review packet with EXACTLY these section headers (one per line):\n` +
	`## TL;DR\n(max 3 lines — the 90-second answer for a human deciding whether to deploy)\n` +
	`## Cross-check\n${goals.length ? `(EXACTLY one line per case above, in the same order: \`- <case text verbatim> → <what was actually DONE to achieve it: behavior + symbol/function name + file path copied from the Git evidence; if the case is not implemented write NOT FOUND — why>\`)` : "(no cross-check cases in the spec — write \"(none)\")"}\n` +
	`## Intent vs Implementation\n## Risks\n(name up to 3 spots the human MUST eyeball — file:line copied verbatim from the Evidence, or omit the line number)\n` +
	`## Rollback\n(concrete commands, e.g. git revert <hash> / files to restore — no vague advice)\n` +
	`## Human actions\n(follow-ups only a human can do: spec debt, unanswered questions)\n` +
	`Do NOT dump raw diffs; summarize. No commentary outside the sections.` +
	(feedback ? `\n\nSYSTEM FEEDBACK: your previous packet was rejected: ${feedback}. Output the full corrected packet with all headers.` : "");
};

export const buildPendingApplyEvidencePrefix = (pendingApply: boolean, humanEdited: boolean): string =>
	(pendingApply
		? 'NOTE: the git evidence below shows staged, uncommitted changes in the main working tree (by design — a human commits after this review; "no new commits since baseline" is expected).\n'
		: "") +
	(humanEdited
		? "NOTE: files were edited AFTER eval+apply (index tree differs from the pinned tree — a human is editing during review); review as normal but surface this in the packet.\n"
		: "");
