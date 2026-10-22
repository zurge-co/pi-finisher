
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Tracker, type TrackerPhase } from "./types.ts";
import { longrunDir, nextPendingPhase } from "./longrun.ts";

export const AUTO_FIX_MAX_ROUNDS = 2;

export const autoLoopEnabled = (t: Tracker): boolean => t.auto === true;

export type TrackerSignDecision =
	| { kind: "auto"; auto: boolean; reason: "gate-off" | "goals-unchanged" }
	| { kind: "ask"; mode: "tui" | "select" }
	| { kind: "unsigned"; reason: "no-ui" };

export const decideTrackerSign = (opts: {
	gateEnabled: boolean;
	goalsUnchanged: boolean;
	prevAuto?: boolean;
	hasUI: boolean;
	tui: boolean;
}): TrackerSignDecision => {
	if (!opts.gateEnabled) return { kind: "auto", auto: true, reason: "gate-off" };
	if (opts.goalsUnchanged) return { kind: "auto", auto: opts.prevAuto ?? true, reason: "goals-unchanged" };
	if (opts.hasUI && opts.tui) return { kind: "ask", mode: "tui" };
	if (opts.hasUI) return { kind: "ask", mode: "select" };
	return { kind: "unsigned", reason: "no-ui" };
};

export const digestPath = (cwd: string, slug: string): string => join(longrunDir(cwd, slug), "digest.md");

export const buildAutoFixPrompt = (phase: TrackerPhase, failed: { id: string; text: string }[], roundsLeft: number): string =>
	[
		`auto-fix (${roundsLeft} round(s) left before the human is called in) — phase ${phase.id} "${phase.title}" failed these signed criteria:`,
		...failed.map((f) => `  ${f.id}: ${f.text}`),
		`fix ONLY what those require — stay inside scope (${phase.scope.join(", ")}), don't restructure, don't add criteria — then call zense_eval again`,
	].join("\n");

export const buildNextPhaseKickoff = (_cwd: string, t: Tracker, nextPhase: TrackerPhase): string =>
	[
		`AUTO-CONTINUE longrun "${t.slug}": the previous phase was checkpointed and this context was hard-reset (retain-none — nothing of the prior phase remains).`,
		`call zense_longrun next now to activate phase ${nextPhase.id} "${nextPhase.title}" — it re-reads the tracker from disk and emits the signed phase spec; never reconstruct state from memory`,
	].join("\n");

export const buildCompactionCapsule = (t: Tracker): string => {
	if (!nextPendingPhase(t))
		return `[zense longrun] ${t.slug} — every phase is done; the whole set awaits the single final human review (staged in main) · see digest.md`;
	return `[zense longrun] ${t.slug} — a phase was checkpointed and this context was hard-reset (retain-none): call zense_longrun next now to activate the next phase — it re-reads the tracker from disk and emits the signed phase spec; never reconstruct state from memory`;
};

export const renderDigestMd = (t: Tracker, readPhaseSummary: (p: TrackerPhase) => string): string => {
	const lines = [
		`# ${t.title} — longrun digest (the single review)`,
		"",
		`tracker v${t.version} \`${t.slug}\` · ${t.phases.filter((p) => p.status === "done").length}/${t.phases.length} phases done · branch ${t.worktreeBranch}`,
		`generated ${new Date().toISOString()} — every phase ran under the ONE tracker signature; criteria verdicts come from the passing zense_eval of each phase`,
		"",
	];
	for (const p of t.phases) {
		const icon = p.status === "done" ? "✅" : p.status === "active" ? "▶️" : "⏳";
		lines.push(`## ${icon} ${p.id} — ${p.title}`, "", `**Intent/goal:** ${p.intent || "(none)"}`, "");
		if (p.criteria.length) {
			lines.push("**Signed criteria — verdict:**", "");
			for (const c of p.criteria) {
				const v = p.criteriaVerdicts?.[c.id] ?? (p.status === "done" ? "PASS" : "—");
				lines.push(`- ${v === "PASS" ? "✓" : v === "FAIL" ? "✗" : "·"} ${c.id} (${v}) — ${c.text}`);
			}
			lines.push("");
		}
		if (p.filesChanged?.length) {
			lines.push("**Files changed:**", "");
			for (const f of p.filesChanged) lines.push(`- ${f}`);
			lines.push("");
		}
		const summary = p.status === "done" ? readPhaseSummary(p) : "";
		if (summary) lines.push(`**Why / what was done:** ${summary}`, "");
		if (p.checkpoint) lines.push(`checkpoint: \`${p.checkpoint.slice(0, 12)}\``, "");
	}
	return lines.join("\n");
};

export const buildLongrunDigest = (cwd: string, t: Tracker): string => {
	const readSummary = (p: TrackerPhase): string => {
		if (!p.summaryPath) return "";
		try {
			const full = join(longrunDir(cwd, t.slug), p.summaryPath);
			if (!existsSync(full)) return "";
			return readFileSync(full, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("## Files")) ?? "";
		} catch {
			return "";
		}
	};
	const p = digestPath(cwd, t.slug);
	writeFileSync(p, renderDigestMd(t, readSummary));
	return p;
};
