
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zenseDir, type Criterion, type Tracker, type TrackerPhase } from "./types.ts";
import { gitOk } from "./worktree.ts";
import { gitAddButZense, NOT_ZENSE } from "./pending-apply.ts";
import { scanClarifyQuestions, questionPolicyError, asCaseLines, type ClarifyQuestion } from "./spec-draft.ts";

export const longrunningRoot = (cwd: string): string => join(zenseDir(cwd), "long-running");
export const longrunDir = (cwd: string, slug: string): string => join(longrunningRoot(cwd), slug);
export const trackerPath = (cwd: string, slug: string): string => join(longrunDir(cwd, slug), "tracker.json");
export const longrunBranch = (slug: string): string => `zense/longrun/${slug}`;

export const slugifyTitle = (title: string): string =>
	title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "untitled";

export const saveTracker = (cwd: string, tracker: Tracker): void => {
	const dir = longrunDir(cwd, tracker.slug);
	mkdirSync(join(dir, "phases"), { recursive: true });
	tracker.updatedAt = Date.now();
	const tmp = join(dir, `tracker.json.tmp-${process.pid}`);
	writeFileSync(tmp, JSON.stringify(tracker, null, 2));
	renameSync(tmp, trackerPath(cwd, tracker.slug));
	writeFileSync(join(dir, "tracker.md"), renderTrackerMd(tracker)); };

export const loadTracker = (cwd: string, slug: string): Tracker | null => {
	try {
		const p = trackerPath(cwd, slug);
		if (!existsSync(p)) return null;
		const t = JSON.parse(readFileSync(p, "utf8")) as Tracker;
		if (!t || typeof t.slug !== "string" || !Array.isArray(t.phases)) return null;
		return t;
	} catch {
		return null;
	}
};

export const validateTracker = (tracker: Tracker): string[] => {
	const errors: string[] = [];
	if (!tracker.slug.trim()) errors.push("slug is empty");
	if (!tracker.phases.length) errors.push("tracker has no phases");
	const seen = new Set<string>();
	for (const p of tracker.phases) {
		if (!p.id.trim()) errors.push("a phase has an empty id");
		if (seen.has(p.id)) errors.push(`duplicate phase id: ${p.id}`);
		seen.add(p.id);
		if (!p.title.trim()) errors.push(`phase ${p.id}: empty title`);
		if (!p.scope.length) errors.push(`phase ${p.id}: empty scope`);
		for (const c of p.criteria)
			if (!c.id.trim() || !c.check.trim()) errors.push(`phase ${p.id}: criterion "${c.id || "?"}" has empty id/check`);
	}
	return errors;
};

export const renderTrackerMd = (t: Tracker): string => {
	const icon = (s: TrackerPhase["status"]) => (s === "done" ? "✅" : s === "active" ? "▶️" : s === "failed" ? "❌" : "⏳");
	const lines = [
		`# ${t.title} — long-running tracker v${t.version}`,
		"",
		`status: ${t.status}${t.approvedAt ? ` · signed ${new Date(t.approvedAt).toISOString()}` : " (unsigned)"}`,
		`branch: ${t.worktreeBranch} (one worktree for the whole set — merged into main only when every phase is done, ADR-004)`,
		"",
		"## Requirement",
		"",
		t.intent || "(see specs.md)",
		"",
						...(t.crossCheck?.length ? ["## Cross-check — what we understood you want", "", ...t.crossCheck.map((c) => `- ${c}`), ""] : []),
		...(t.outcomes ? ["## What you'll get", "", t.outcomes, ""] : []),
		"## Phases",
		"",
	];
	for (const p of t.phases) {
		lines.push(`### ${icon(p.status)} ${p.id} — ${p.title}`);
		if (p.intent) lines.push("", p.intent);
		if (p.outcomes) lines.push("", `**You'll get:** ${p.outcomes}`);
		if (p.crossCheck?.length) lines.push("", "**Cross-check:**", ...p.crossCheck.map((c) => `- ${c}`));
		lines.push("", `- scope: ${p.scope.join(", ")}`);
		if (p.constraints.length) lines.push(`- constraints: ${p.constraints.join("; ")}`);
		if (p.criteria.length) lines.push(`- criteria: ${p.criteria.map((c) => c.id).join(", ")}`);
		if (p.checkpoint) lines.push(`- checkpoint: ${p.checkpoint.slice(0, 12)}`);
		if (p.summaryPath) lines.push(`- summary: ${p.summaryPath}`);
		lines.push("");
	}
	return lines.join("\n");
};

export const findPhase = (t: Tracker, id: string): TrackerPhase | undefined => t.phases.find((p) => p.id === id);
export const nextPendingPhase = (t: Tracker): TrackerPhase | undefined => t.phases.find((p) => p.status === "pending");
export const allPhasesDone = (t: Tracker): boolean => t.phases.length > 0 && t.phases.every((p) => p.status === "done");

export const mergePhaseCriteria = (seed: Criterion[], extra: Criterion[] = []): Criterion[] => [
	...seed.map((c) => ({ ...c, origin: "tracker" as const })),
	...extra.filter((c) => !seed.some((s) => s.id === c.id)).map((c) => ({ ...c, origin: "compiled" as const })),
];
export const droppedSeedIds = (seed: Criterion[], compiled: Criterion[]): string[] =>
	seed.filter((s) => !compiled.some((c) => c.id === s.id)).map((s) => s.id);

export interface LongrunPlanPhase {
	id?: string;
	title: string;
	intent: string;
		crossCheck?: string[];
		outcomes?: string;
	scope: string[];
	constraints?: string[];
	criteria: Criterion[];
}

export const buildLongrunPlannerPrompt = (title: string, intent: string, specsMd: string): string =>
	[
		`You are planning the execution of ONE requirement as an ordered sequence of phases (a "longrun tracker").`,
		`Requirement: ${title}`,
		intent ? `Intent: ${intent}` : "",
		specsMd ? `Requirement doc:\n${specsMd}` : "",
		"",
		"Return ONLY a JSON object (no fences, no commentary):",
		`{"phases":[{"id":"p1","title":"...","intent":"...","crossCheck":["..."],"outcomes":"...","scope":["path/prefix",...],"constraints":["..."],"criteria":[{"id":"P1C1","text":"observable outcome","check":"a single shell command that exits 0 when done"}]}], "crossCheck":["..."], "outcomes":"..."}`,
		"",
		"Rules:",
		"- prefer the FEWEST phases — the default is ONE phase; split only across a genuine boundary: an architecture seam, an irreversible decision, or a settled baseline a later phase must build on (never split just to keep phases small)",
		"- the per-phase cost is real: every phase runs a full spec → implement → eval → checkpoint → context-reset cycle, so extra phases slow delivery; 6 phases is a hard upper bound, not a target",
		"- phases are ordered by dependency; each phase must be independently reviewable (a clean diff, a clear done-state)",
		"- pre-phase (id \"pre\") only when exploration/scaffolding genuinely precedes implementation",
		"- every criterion's check must be a REAL runnable command (verify it would execute; no placeholders like <path>)",
		"- criteria are the phase's signature — few but decisive (1–4 per phase)",
		"- crossCheck (top-level + per phase): REQUIRED. 2–6 SHORT lines, one goal CASE per line, same LANGUAGE as the requirement doc — the human reads this INSTEAD of the technical plan at signing and checks that you understood the request. Each line = one user-visible behavior (e.g. \"คุณต้องการให้ A มี B เมื่อ C\"). The top-level crossCheck summarizes the whole set; per-phase crossCheck lists that phase's cases. NEVER jargon, library names, file paths, shell commands or code.",
		"- outcomes (top-level + per phase): OPTIONAL legacy plain-language summary (1–3 short lines) — crossCheck is the sign surface.",
		"- scope entries are path prefixes the implementing agent may touch; keep them tight",
						"- if the requirement doc leaves the OUTCOME ambiguous (what the human wants the result to be or do, product/UI level), return ONLY {\"questions\":[{\"question\":\"…\",\"choices\":[\"a\",\"b\"]}]} instead of phases (max 5; omit choices only for a product/UI question with genuinely no guessable options, marking it \"freeText\": true) — the human answers and you are re-run",
		"- NEVER ask the human internal technical/detail questions (library, module split, naming, test approach, data shape, refactor structure): decide those from the requirement doc and repo, and proceed",
	].join("\n");

export const parseLongrunPlan = (output: string): { ok: true; phases: LongrunPlanPhase[]; crossCheck?: string[]; outcomes?: string; questions?: ClarifyQuestion[] } | { ok: false; error: string } => {
	const stripped = output.replace(/```(?:json)?\s*\n?/g, "").replace(/```/g, "");
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start === -1 || end <= start) return { ok: false, error: "no JSON object found in planner output" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch (e) {
		return { ok: false, error: `JSON.parse failed: ${(e as Error).message.slice(0, 120)}` };
	}
					const questionField = (parsed as { questions?: unknown }).questions;
	if (questionField !== undefined && (parsed as { phases?: unknown }).phases === undefined) {
		const scan = scanClarifyQuestions(questionField);
		if (scan.violations.length) return { ok: false, error: questionPolicyError(scan.violations) };
		if (scan.questions.length) return { ok: true, phases: [], questions: scan.questions.slice(0, 5) };
	}
	const phases = (parsed as { phases?: unknown }).phases;
	if (!Array.isArray(phases) || !phases.length) return { ok: false, error: '"phases" must be a non-empty array' };
	const norm: LongrunPlanPhase[] = [];
	for (const [i, ph] of phases.entries()) {
		const p = ph as Partial<LongrunPlanPhase>;
		if (typeof p?.title !== "string" || !p.title.trim()) return { ok: false, error: `phase #${i + 1}: missing title` };
		if (typeof p?.intent !== "string" || !p.intent.trim()) return { ok: false, error: `phase #${i + 1}: missing intent` };
		if (!Array.isArray(p.scope) || !p.scope.length || !p.scope.every((s) => typeof s === "string"))
			return { ok: false, error: `phase "${p.title}": scope must be a non-empty string array` };
		if (!Array.isArray(p.criteria)) return { ok: false, error: `phase "${p.title}": criteria must be an array` };
		for (const c of p.criteria as Partial<Criterion>[])
			if (typeof c?.id !== "string" || typeof c?.text !== "string" || typeof c?.check !== "string" || !c.check.trim())
				return { ok: false, error: `phase "${p.title}": every criterion needs id/text/check` };
								const clean: LongrunPlanPhase = { ...p } as LongrunPlanPhase;
		if (typeof p.outcomes === "string" && p.outcomes.trim()) clean.outcomes = p.outcomes.trim();
		else delete clean.outcomes;
				const cases = asCaseLines(p.crossCheck);
		if (cases) clean.crossCheck = cases;
		else delete clean.crossCheck;
		norm.push(clean);
	}
			const topOut = (parsed as { outcomes?: unknown }).outcomes;
	const topCases = asCaseLines((parsed as { crossCheck?: unknown }).crossCheck);
	return { ok: true, phases: norm, ...(topCases ? { crossCheck: topCases } : {}), ...(typeof topOut === "string" && topOut.trim() ? { outcomes: topOut.trim() } : {}) };
};

export const compilePhaseSpec = (
	t: Tracker,
	phase: TrackerPhase,
	extraCriteria: Criterion[] = [],
): { title: string; intent: string; crossCheck?: string[]; outcomes?: string; scope: string[]; constraints: string[]; criteria: Criterion[]; specDebt: string[]; provenance: string } => ({
	title: `longrun(${t.slug}) ${phase.id} – ${phase.title}`,
	intent: `${phase.intent}\n\n[longrun "${t.slug}" tracker v${t.version} — approved by the tracker's signature; review gate at phase end; worktree ${t.worktreeBranch}]`,
			crossCheck: phase.crossCheck,
	outcomes: phase.outcomes,
	scope: phase.scope,
	constraints: phase.constraints,
	criteria: mergePhaseCriteria(phase.criteria, extraCriteria),
	specDebt: [],
	provenance: `tracker:${t.slug}@v${t.version}`,
});

export const buildContextCapsule = (cwd: string, t: Tracker, active: TrackerPhase, opts?: { label?: string }): string => {
	const label = opts?.label ?? "Active phase";
	const summaryOf = (p: TrackerPhase): string => {
		if (!p.summaryPath) return p.checkpoint ? `checkpoint ${p.checkpoint.slice(0, 12)}` : "(no summary)";
		try {
			const first = readFileSync(join(longrunDir(cwd, t.slug), p.summaryPath), "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
			return first ?? "(no summary)";
		} catch {
			return "(summary unreadable)";
		}
	};
	const lines = [
		`[zense longrun] ${t.slug} — "${t.title}" (tracker v${t.version}, signed)`,
		`Requirement: ${(t.intent || "").split("\n")[0].slice(0, 300)}`,
		`Progress: ${t.phases.map((p) => `${p.id}${p.status === "done" ? "✓" : p.status === "active" ? "▶" : "·"}`).join(" ")}`,
	];
	const done = t.phases.filter((p) => p.status === "done");
	if (done.length) {
		lines.push("Done phases:");
		for (const p of done) lines.push(`  ${p.id} "${p.title}" — ${summaryOf(p)}`);
	}
	const adrs = t.phases.flatMap((p) => p.adrs ?? []);
	lines.push(
		`${label} ${active.id} "${active.title}": ${active.intent}`,
		`  scope: ${active.scope.join(", ")}${active.constraints.length ? ` · constraints: ${active.constraints.join("; ")}` : ""}`,
		`  seed criteria (signed — carry ALL into the phase spec): ${active.criteria.map((c) => c.id).join(", ") || "(none)"}`,
		...(adrs.length ? [`  ADRs so far: ${adrs.join(", ")} (re-read .zense/adr/ before irreversible choices)`] : []),
		`Worktree: .zense/worktree/longrun-${t.slug} (branch ${t.worktreeBranch}) — every write lands there; main stays untouched until the whole set passes review.`,
	);
	return lines.join("\n");
}

export const checkpointCommit = (wtRoot: string, message: string): { ok: boolean; sha?: string; msg: string } => {
	const add = gitAddButZense(wtRoot);
	if (!add.ok) return { ok: false, msg: `git add failed: ${add.err}` };
	if (gitOk(["diff", "--cached", "--quiet"], wtRoot).ok) {
		const h = gitOk(["rev-parse", "HEAD"], wtRoot);
		return { ok: true, ...(h.ok ? { sha: h.out.trim() } : {}), msg: "nothing to commit (checkpoint = phase baseline)" };
	}
	const cm = gitOk(["commit", "-m", message, "--no-verify"], wtRoot);
	if (!cm.ok) return { ok: false, msg: cm.err };
	const h = gitOk(["rev-parse", "HEAD"], wtRoot);
	return h.ok ? { ok: true, sha: h.out.trim(), msg: h.out.trim() } : { ok: false, msg: "committed but rev-parse failed" };
};

export const resetToCheckpoint = (wtRoot: string, sha: string): { ok: boolean; msg: string } => {
	const r = gitOk(["reset", "--hard", sha], wtRoot);
	if (!r.ok) return { ok: false, msg: r.err };
	gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], wtRoot); 	return { ok: true, msg: `reset --hard ${sha.slice(0, 12)}` };
};

export interface ReconcileResult {
		status: "ok" | "missing-worktree" | "wrong-branch" | "detached" | "checkpoint-diverged";
	actualBranch?: string;
	dirty: string[];          	commitsSinceCheckpoint: number;
	healable: boolean;        }

export const reconcileLongrunWorktree = (wtRoot: string | undefined, expectedBranch: string, lastCheckpoint?: string): ReconcileResult => {
	if (!wtRoot || !existsSync(wtRoot))
		return { status: "missing-worktree", dirty: [], commitsSinceCheckpoint: 0, healable: true };
	const br = gitOk(["rev-parse", "--abbrev-ref", "HEAD"], wtRoot);
	const actual = br.ok ? br.out.trim() : "";
	const dirty = gitOk(["status", "--porcelain", "--", ".", NOT_ZENSE], wtRoot);
	const dirtyLines = dirty.ok ? dirty.out.split("\n").map((s) => s.trimEnd()).filter(Boolean) : [];
	const healable = dirtyLines.length === 0;
	let commits = 0;
	if (lastCheckpoint) {
						const anc = gitOk(["merge-base", "--is-ancestor", lastCheckpoint, "HEAD"], wtRoot);
		if (!anc.ok)
			return { status: "checkpoint-diverged", ...(actual ? { actualBranch: actual } : {}), dirty: dirtyLines, commitsSinceCheckpoint: 0, healable: false };
		commits = Number(gitOk(["rev-list", "--count", `${lastCheckpoint}..HEAD`], wtRoot).out.trim() || "0");
	}
	if (actual === "HEAD") return { status: "detached", dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
	if (actual !== expectedBranch)
		return { status: "wrong-branch", ...(actual ? { actualBranch: actual } : {}), dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
	return { status: "ok", actualBranch: actual, dirty: dirtyLines, commitsSinceCheckpoint: commits, healable };
};

export const healToBranch = (wtRoot: string, expectedBranch: string): { ok: boolean; msg: string } => {
	const sw = gitOk(["switch", expectedBranch], wtRoot);
	return sw.ok ? { ok: true, msg: `switched to ${expectedBranch}` } : { ok: false, msg: sw.err };
};

export const abandonLongrunWorktree = (cwd: string, t: Tracker): { ok: boolean; msg: string } => {
	const wtRoot = join(zenseDir(cwd), "worktree", `longrun-${t.slug}`);
	if (existsSync(wtRoot) && !gitOk(["worktree", "remove", wtRoot, "--force"], cwd).ok)
		return { ok: false, msg: `git worktree remove failed for ${wtRoot} — remove manually` };
	gitOk(["branch", "-D", t.worktreeBranch], cwd); 	return { ok: true, msg: `worktree + branch ${t.worktreeBranch} removed` };
};

export const writePhaseSummary = (cwd: string, t: Tracker, phase: TrackerPhase, summary: string, filesChanged: string[]): string => {
	const rel = `phases/${phase.id}.md`;
	const body = [
		`# ${phase.id} — ${phase.title} (closed ${new Date().toISOString()})`,
		"",
		summary.trim() || "(no summary provided)",
		"",
		...(filesChanged.length ? ["## Files changed", "", ...filesChanged.map((f) => `- ${f}`)] : []),
		"",
	].join("\n");
	writeFileSync(join(longrunDir(cwd, t.slug), rel), body);
	return rel;
};

export const appendSpecsLog = (cwd: string, slug: string, line: string): void => {
	try {
		appendFileSync(join(longrunDir(cwd, slug), "specs.md"), `\n- ${new Date().toISOString()} ${line}\n`);
	} catch {
	}
};
