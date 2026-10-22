/**
 * zense-harness — AI-driven SDLC harness for pi, per PLAN.md.
 *
 * The name "zense" puns on the Thai word for "sign" — every agent task
 * carries a human signature (spec approval = input-side signature,
 * review packet = output-side approval)
 *
 * Loop: spec → criteria → implementation → dual eval → exception review → learn.
 *
 * Architecture (see README):
 *   - The harness itself is ONE pi extension; "sub-agents" are isolated
 *     `pi -p` (print-mode) subprocesses spawned per phase task, so each phase
 *     gets a clean context window and a structured artifact back.
 *   - Gates are enforced with pi's tool_call interception + human confirms.
 *
 * Phases:
 *   P1 Requirements : zense_spec tool → append-only archive .zense/specs/
 *                     <timestamp>-v{n}-<slug>.{json,md} (never overwritten) +
 *                     .zense/spec.{json,md} as always-latest copies
 *   P2 Design       : zense_adr tool → .zense/adr/NNN-*.md (deny rules checked live)
 *   P3 Implementation: specification gate + escalation
 *   P4 Dual eval    : zense_eval (output eval vs criteria) + trajectory heuristics
 *   P5 Review/Deploy: zense_review builds a review-packet card (exception-based)
 *   P6 Maintenance  : memory.jsonl learning log; incidents feed new criteria
 */
import { execFileSync, execSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Box, Container, Key, Markdown, matchesKey, SelectList, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { DefaultPackageManager, SettingsManager, getAgentDir, DynamicBorder, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";

// ----------------------------------------------------------------------------- module map
// This file is ONLY the extension entry point. The ~130 module-scope helpers it once held
// now live thematically under ./src/ (one read call ≈ one concern — see AGENTS.md map).
// The export * lines preserve the exact public surface tests import from this entry point.

export * from "./src/types.ts";
export * from "./src/spec-changes.ts";
export * from "./src/worktree.ts";
export * from "./src/resume.ts";
export * from "./src/pending-apply.ts";
export * from "./src/cycle.ts";
export * from "./src/spec-draft.ts";
export * from "./src/subagent-config.ts";
export * from "./src/decompose.ts";
export * from "./src/esc-guard.ts";
export * from "./src/evidence.ts";
export * from "./src/eval-review.ts";
export * from "./src/adr-deny.ts";
export * from "./src/subagent-runner.ts";
export * from "./src/memory.ts";
export * from "./src/models.ts";
export * from "./src/swarm.ts";
export * from "./src/code-hygiene.ts";
export * from "./src/goal-confirm.ts";
export * from "./src/agent-panel.ts";
export * from "./src/swarm-code.ts";
export * from "./src/verify-loop.ts";
export * from "./src/goal-driver.ts";
export * from "./src/goal-run.ts";
export * from "./src/ask.ts";
export * from "./src/longrun.ts";
export * from "./src/longrun-auto.ts";
export * from "./src/longrun-status.ts";

// The original package import block (top of file) already covers every external the factory
// body needs — the lines below are only the local src/ bindings the factory uses by name.
import { zenseDir, type Criterion, type LongRunRef, type Spec, type State, type SubagentRun, type Tracker, type TrackerPhase, type Worktree as WorktreeT } from "./src/types.ts";
import { buildSpecChanges, renderSignOutcome, renderSpecMd, renderTrackerOutcomes, syncApprovedSpecFiles, applyFullscreenDefault, goalLines, sameGoalLines, decideSpecApproval, rejectionDirective } from "./src/spec-changes.ts";
import { rewritePathForWorktree, buildWorktreeCommand, gitOk, canReuseWorktree, createWorktree, ensureLongrunWorktree, excludeFromGitStatus } from "./src/worktree.ts";
import { loadSpecFromDisk, discoverResumeState, findSpecArchivePaths, discoverLongrunTrackers } from "./src/resume.ts";
import {
	allPhasesDone, appendSpecsLog, buildContextCapsule, checkpointCommit, droppedSeedIds, findPhase, healToBranch,
	abandonLongrunWorktree, buildLongrunPlannerPrompt, compilePhaseSpec, loadTracker, longrunBranch, longrunDir,
	nextPendingPhase, parseLongrunPlan, reconcileLongrunWorktree,
	renderTrackerMd, resetToCheckpoint, saveTracker, slugifyTitle, validateTracker, writePhaseSummary,
} from "./src/longrun.ts";
import { longrunStatusText } from "./src/longrun-status.ts";
import {
	AUTO_FIX_MAX_ROUNDS, autoLoopEnabled, buildAutoFixPrompt, buildCompactionCapsule, buildLongrunDigest,
	buildNextPhaseKickoff, decideTrackerSign,
} from "./src/longrun-auto.ts";
import { composeCommitMessage, PENDING_PATCH, PENDING_MSG, NOT_ZENSE, isGitRepo, uncommittedChanges, composeSnapshotMessage, snapshotUncommitted, applyWorktreeBack, discardPendingApply, acceptPendingApply } from "./src/pending-apply.ts";
import { resetCycleState, takeContextBulletin, buildAcceptBulletin, buildReconcileBulletin, buildDiscardBulletin, freshState } from "./src/cycle.ts";
import { parseSpecDraft, applyQualityGate, type ClarifyQuestion } from "./src/spec-draft.ts";
import { SUBAGENT_EXCLUDE_TOOLS, subagentTimeout, zenseGlobalConfigDir, extDisplayLabel, listInstalledExtensions, subagentExtIncludes, writeSubagentExtIncludes, subagentStripFlagsAsync, modelMatchesPattern, PROVIDER_MISSING_RX, findProviderExtension, mergeExtInclude, diagnoseProviderMissing, buildProviderMissingGuidance, buildRequirementsPrompt } from "./src/subagent-config.ts";
import { createEscGuard } from "./src/esc-guard.ts";
import { gatherRepoFacts, loadSpecExemplar, gitChangeSummary, gitChangedSymbols, gitDiffExcerpt, CHECK_FORMAT_CONTRACT, runCheckProbes, lintSpecChecks } from "./src/evidence.ts";
import { parseGraderOutput, buildGraderPrompt, buildCompactProbeSection, buildEvalResultText, buildReviewResultText, buildReviewModalText, mergeCrossCheck, COMMENT_DISCIPLINE_GUIDELINE, parseReviewerPacket, findUngroundedTokens, isLastEvalStale, buildReviewerPrompt, buildPendingApplyEvidencePrefix, type GradeParse, type EvalResultView } from "./src/eval-review.ts";
import { firstAdrDenyViolation } from "./src/adr-deny.ts";
import { fmtTok, subagentLogPath, runSubagent } from "./src/subagent-runner.ts";
import { aggregateMemory, memorySummaryLines, distillImpact, fmtBytes, parseDistilledLessons, buildDistilledMemory, clearDirFiles, MAX_DISTILL_MEMORY_BYTES, replaceFileAtomic, distillTaskPrompt } from "./src/memory.ts";
import { readModelsConfig, resolveModelPattern, writeModelsConfig, availableModelChoices, panelize } from "./src/models.ts";
import { readModelLadder, readSwarmConcurrency, runSwarm, effectiveLadder, swarmSlots, swarmSummaryLine, buildFanOutPrompt, SWARM_ROUTING_GUIDELINE, type FanOutArgs, type SwarmSlot, type SwarmTask } from "./src/swarm.ts";
import { CODE_HYGIENE_GUIDELINE, buildCodeRulesPrompt, formatHygieneViolations, isHygieneChecked, scanSource, type HygieneViolation } from "./src/code-hygiene.ts";
import { panelLines, panelTickMs, streamTail, type PanelRun } from "./src/agent-panel.ts";
import { buildCodeWorkerPrompt, mergeReport, parseWorkerFiles, planMerge, planSlices, sliceViolations, type SliceOutcome, type SlicePlan } from "./src/swarm-code.ts";
import { MAX_VERIFY_ROUNDS, advanceLoop, buildFixPrompt, buildReport, freshVerifyLoop, judgeCase, nextVerifyRound, renderVerifyReport } from "./src/verify-loop.ts";
import { buildGoalToolText, nextGoalDriverStep, resumeOrStart, type GoalRunState } from "./src/goal-driver.ts";
import { costCeilingKeysPresent, surfaceLine } from "./src/goal-run.ts";
import { buildGoalConfirmPrompt, goalCases, goalGate } from "./src/goal-confirm.ts";
import { askQuestionScan, askPolicyError, formatAskAnswers, ASK_NO_UI_TEXT, type AskAnswer } from "./src/ask.ts";

// ----------------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	// Sub-agent invocations must not re-enter the harness.
	if (process.env.PI_ZENSE_SUBAGENT === "1") return;

	let state = freshState();

	// ----- persistence (appendEntry restores across reloads/resumes)
	const persist = () => pi.appendEntry("zense-state", state);
	const readdirAdrs = (cwd: string): string[] => {
		const dir = join(zenseDir(cwd), "adr");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".md"));
	};
	const adrText = (cwd: string) =>
		readdirAdrs(cwd)
			.map((f) => readFileSync(join(zenseDir(cwd), "adr", f), "utf8"))
			.join("\n---\n")
			.slice(0, 12_000);

	// ----- git worktree isolation (per-session: every main-agent tool call is redirected into
	//       the worktree until eval PASS applies it back — two sessions can't stomp each other)
	// (git helpers gitOk/createWorktree/applyWorktreeBack/discardPendingApply live at module scope for tests)

	/** Fullscreen default so pi-zense installs require no manual setup: set once, only when the
	 *  key is absent, interactive TUI only (sub-agents bail at factory start via
	 *  PI_ZENSE_SUBAGENT) — best-effort; a settings-write failure must never break startup. */
	const ensureFullscreenDefault = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
			const merged = applyFullscreenDefault(raw);
			if (!merged || !merged.changed) return; // null = corrupt existing file (skip); !changed = user already chose (respect)
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, merged.text);
			learn(ctx, "fullscreen default: tuiMode=fullscreen (install default — takes effect on the next pi launch)");
			ctx.ui.notify(
				"🖥 zense: fullscreen TUI mode is now the default in ~/.pi/agent/settings.json — takes effect on the next pi launch (this session: /settings → TUI mode; to opt out: change tuiMode in that file)",
				"info",
			);
		} catch {
			/* best-effort */
		}
	};

	pi.on("session_start", async (_ev, ctx) => {
		ensureFullscreenDefault(ctx);
		// ESC guard: (re-)register on every session_start — pi clears extension input listeners
		// on session invalidation/reload (resetExtensionUI), dropping the old listener; calling
		// the old unsubscribe first is a safe no-op (pi-tui keeps a Set keyed by function → no
		// duplicates, no crashes)
		escGuard.reset(); // the previous session's overlays were popped by pi — don't let stale entries eat the new session's ESC
		if (ctx.mode === "tui") {
			escGuardUnsubscribe?.();
			escGuardUnsubscribe = ctx.ui.onTerminalInput(escGuard.handleInput);
		}
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "zense-state")
				state = { ...freshState(), ...(e.data as State) };
		lastWidget = undefined; // pi clears widgets on session switch/reload → resend even identical text
		lastLongrunStatus = undefined; // same reset for the footer status entry (resetExtensionUI drops it too)
		// discovery only — NEVER auto-adopt: a fresh session that finds an on-disk spec gets a
		// hint to /zense resume; ignoring it = the old cycle is abandoned (left untouched on disk)
		if (!state.spec && ctx.hasUI) {
			const disk = loadSpecFromDisk(ctx.cwd);
			if (disk)
				ctx.ui.notify(
					`📄 found spec v${disk.version}${disk.approved ? " (signed)" : ""} on disk: ${disk.title} — run /zense resume to continue it, or ignore to abandon`,
					"info",
				);
		}
		// reconcile pendingApply across sessions/restarts: is the applied change still staged in main?
		if (state.pendingApply) {
			const pa = state.pendingApply;
			if (gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
				// index is empty → the human committed or dropped it outside the flow → clear the
				// pointer quietly + sweep the helper files
				learn(ctx, `pendingApply reconcile: spec v${pa.specVersion} — index is empty (committed/discarded outside the flow)`);
				state.pendingApply = undefined;
				rmSync(join(zenseDir(ctx.cwd), PENDING_PATCH), { force: true });
				rmSync(join(zenseDir(ctx.cwd), PENDING_MSG), { force: true });
				// a silent clear used to leave the agent believing work was still pending (and the
				// version counter running on) — now announced via bulletin + cycle reset
				state.contextBulletin = buildReconcileBulletin(pa.specVersion);
				resetCycleState(state);
				persist();
			} else {
				ctx.ui.notify(
					`⏳ zense: changes from spec v${pa.specVersion} (${pa.paths.length} file(s)) are staged in main awaiting a commit — review, then git commit -F .zense/pending-apply.msg · after committing → /zense accept · unhappy → /zense discard (reverse patch)`,
					"warning",
				);
			}
		}
		updateWidget(ctx); // also refreshes the longrun status bar (restored state)
	});

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	/** Cache of the widget text last actually sent — setWidget builds fresh Text/Container
	 *  components even for identical content, making the dock below the transcript relayout
	 *  during sub-agent runs (2s tick + hooks call updateWidget often) → the view jitters.
	 *  Dedupe at string level: setWidget only when the text really changed. */
	let lastWidget: string | undefined;
	/** Dedupe sibling of lastWidget for the "zense-longrun" footer status entry (2026-09-24). */
	let lastLongrunStatus: string | undefined;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const s = state.spec;
		const live = panelLines(state.subagentRuns as PanelRun[], { width: Math.max(60, (ctx.ui as any).terminalWidth ?? 110) });
		const line =
			`ZENSE ▸ ${state.phase.toUpperCase()} · spec: ${s ? (s.approved ? "✅v" + s.version : "⏳unapproved") : "—"}` +
			` · turns ${state.turnsUsed} · tok ${fmtTok(state.tokensUsed)}` +
			(live.length > 1 ? ` · 🧪 ${live.length - 1} agents live` : "") +
			(state.worktree ? ` · 🌳 ${basename(state.worktree.root)}` : "") +
			(state.pendingApply ? ` · ⏳staged v${state.pendingApply.specVersion}` : "") +
			(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
			(state.hygieneViolations?.length ? ` · 🧹 ${state.hygieneViolations.length} code-rule` : "") +
			(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : "");
		const status = longrunStatusText(ctx.cwd, state.longRun, state.phase);
		if (status !== lastLongrunStatus) {
			lastLongrunStatus = status;
			ctx.ui.setStatus("zense-longrun", status);
		}
		const text = [line, ...live].join("\n");
		if (text === lastWidget) return;
		lastWidget = text;
		ctx.ui.setWidget("zense", text.split("\n"));
	};

	const ticker: { timer?: ReturnType<typeof setInterval>; ctx?: ExtensionContext; period?: number } = {};

	const rescheduleTicker = (ctx: ExtensionContext) => {
		ticker.ctx = ctx;
		const liveCount = state.subagentRuns.filter((r) => r.status === "running").length;
		const want = liveCount ? panelTickMs(liveCount) : undefined;
		if (ticker.timer && want === ticker.period) return;
		if (ticker.timer) clearInterval(ticker.timer);
		ticker.timer = undefined;
		ticker.period = want;
		if (!want) return;
		ticker.timer = setInterval(() => {
			if (ticker.ctx) updateWidget(ticker.ctx);
			rescheduleTicker(ticker.ctx as ExtensionContext);
		}, want);
	};

	/** Redirect main-agent tool calls into the worktree (mutates event.input) — the agent
	 *  works inside the worktree without knowing. Sub-agents are separate processes and
	 *  unaffected (they carry their own cwd). */
	const applyRedirect = (ev: any, ctx: ExtensionContext) => {
		let wt = state.worktree;
		// self-heal: the worktree got applied/deleted outside the flow (e.g. applyWorktreeBack
		// called manually after an auto-apply miss) → a stale pointer would prefix every bash
		// with a "cd <wtRoot>" that no longer exists — clear silently when the dir is gone
		if (wt && !existsSync(wt.root)) {
			learn(ctx, "worktree self-heal: " + wt.root + " is gone (applied out-of-band?) — clearing the stale pointer");
			state.worktree = null;
			persist(); updateWidget(ctx);
			wt = null;
		}
		if (!wt) return;
		if (ev.toolName === "write" || ev.toolName === "edit" || ev.toolName === "read") {
			const p = (ev.input as { path?: string })?.path;
			if (typeof p === "string") ev.input.path = rewritePathForWorktree(ctx.cwd, wt.root, p);
		} else if (ev.toolName === "bash") {
			const c = (ev.input as { command?: string })?.command;
			if (typeof c === "string") ev.input.command = buildWorktreeCommand(c, wt.root);
		}
	};

	/** provider-missing auto-heal (2026-09-17): called when diagnosis finds the pattern's
	 *  provider missing from bare boot. Find the providing extension (findProviderExtension) →
	 *  retry once with '-e <path>'; on success (ok + the model genuinely matches the pattern —
	 *  guards against including the wrong extension and still silently falling back) → merge +
	 *  persist into the role's include list via writeSubagentExtIncludes (main repo only — the
	 *  worktree fallback reads it already) + announce the opt-out path; failed retry / no ext
	 *  found / ambiguous / already included (suspect auth) → mark failed with per-role guidance,
	 *  persist nothing. */
	const healProviderMismatch = async (
		ctx: ExtensionContext,
		role: string,
		modelPattern: string,
		r0: { ok: boolean; output: string; logPath: string; usedModel?: string },
		subCwd: string,
		stripFlags: string[],
		task: string,
		onChunk: ((chunk: string) => void) | undefined,
		run: SubagentRun,
		patternProvider: string,
	): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> => {
		const include = subagentExtIncludes(role, subCwd, ctx.cwd);
		const hit = findProviderExtension(patternProvider, await listInstalledExtensions(subCwd));
		const alreadyIncluded = hit ? include.includes(hit.path) : false;
		if (hit && !alreadyIncluded) {
			ctx.ui.notify(`🔁 zense: provider "${patternProvider}" is unavailable in the sub-agent (${role}) — retrying with extension '${hit.label}' loaded`, "info");
			run.retried = true;
			const r2 = await runSubagent(role, task, subCwd, subagentTimeout(role, subCwd, ctx.cwd), onChunk, r0.logPath, modelPattern, SUBAGENT_EXCLUDE_TOOLS[role], [...stripFlags, "-e", hit.path]);
			if (r2.ok && r2.usedModel && modelMatchesPattern(r2.usedModel, modelPattern)) {
				const merged = mergeExtInclude(include, hit.path);
				if (merged !== include) writeSubagentExtIncludes(ctx.cwd, role, merged);
				run.autoIncluded = true;
				learn(ctx, `provider auto-heal: ${role} — auto-included '${hit.label}' for provider "${patternProvider}" (merged + persisted into .zense/config.json)`);
				ctx.ui.notify(`✅ zense: auto-included '${hit.label}' for role ${role} (provider "${patternProvider}") — undo with /zense ext-config-show ${role} off ${hit.path}`, "info");
				return r2;
			}
			learn(ctx, `provider auto-heal failed: ${role} — still broken with '${hit.label}' included (ok=${r2.ok} used=${r2.usedModel ?? "?"} wanted ${modelPattern})`);
			return { ...r2, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, autoRetried: true })}\n---\n${r2.output}` };
		}
		learn(ctx, `provider missing: ${role} needs "${patternProvider}" but can't heal — ${hit ? (alreadyIncluded ? "extension already included, still falling back (suspect auth)" : "extension ambiguous/unusable") : "no provider extension found"}`);
		return { ...r0, ok: false, output: `${buildProviderMissingGuidance(role, patternProvider, { hit, alreadyIncluded })}\n---\n${r0.output}` };
	};

	const gitIn = (repo: string, args: string[]): { ok: boolean; out: string } => {
		const r = gitOk(args, repo);
		return { ok: r.ok, out: r.out.trim() };
	};

	const workerWorktree = (repo: string, dir: string, branch: string): boolean => {
		mkdirSync(dirname(dir), { recursive: true });
		const have = gitIn(repo, ["rev-parse", "--verify", "-q", branch]).ok;
		const add = have ? gitIn(repo, ["worktree", "add", dir, branch]) : gitIn(repo, ["worktree", "add", dir, "-b", branch]);
		if (add.ok) excludeFromGitStatus(repo, join(zenseDir(repo), "worktree"));
		return add.ok;
	};

	const dropWorkerWorktree = (repo: string, dir: string, branch: string): void => {
		gitIn(repo, ["worktree", "remove", "--force", dir]);
		gitIn(repo, ["branch", "-D", branch]);
	};

	const sliceDiff = (repo: string, dir: string, paths: string[]): string => {
		const files = paths.length ? paths : ["."];
		const tracked = gitIn(dir, ["diff", "HEAD", "--", ...files]);
		return tracked.ok ? tracked.out : "";
	};

	const applySlice = (repo: string, diff: string): { ok: boolean; msg: string } => {
		if (!diff.trim()) return { ok: true, msg: "no changes" };
		try {
			execFileSync("git", ["apply", "--3way", "-"], { cwd: repo, input: diff, stdio: ["pipe", "pipe", "pipe"] });
			return { ok: true, msg: "applied" };
		} catch (e: any) {
			return { ok: false, msg: (e?.stderr?.toString() ?? e?.message ?? String(e)).split("\n")[0] };
		}
	};

	const armGoalRound = (text: string): void => {
		const kick = `GOAL-STILL-OPEN — the driver handed this round back to you (no human will approve anything):\n${text}`;
		try {
			pi.sendUserMessage(kick, { deliverAs: "followUp" });
		} catch {
			/* the returned text still carries the same instruction if the agent is mid-stream */
		}
	};

	const runCodeSwarm = async (
		ctx: ExtensionContext,
		slices: { id: string; instruction: string; scope?: string[] }[],
		opts: { slots: SwarmSlot[]; concurrency: number; maxAttempts: number; goal?: string; sig?: AbortSignal; ladder: string[]; source: string; notes: string },
	): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> => {
		let plans: SlicePlan[];
		try {
			plans = planSlices(slices, join(zenseDir(ctx.cwd), "worktree", "swarm"), new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
		} catch (e) {
			return { content: [{ type: "text", text: `zense_swarm code refused: ${(e as Error).message}` }], details: { refused: true }, isError: true };
		}
		const outcomes: SliceOutcome[] = [];
		const byPlan = new Map(plans.map((pl) => [pl.id, pl]));
		const tasks = slices.map((sl) => ({ id: sl.id, payload: sl }));
		const results = await runSwarm(tasks, {
			slots: opts.slots,
			concurrency: opts.concurrency,
			maxAttempts: opts.maxAttempts,
			run: async (task, slot, attempt) => {
				const plan = byPlan.get(task.id)!;
				if (opts.sig?.aborted) return { ok: false, output: "cancelled by user (Esc)" };
				if (!workerWorktree(ctx.cwd, plan.worktreeDir, plan.branch)) return { ok: false, output: `could not create the worker worktree ${plan.worktreeDir} (branch ${plan.branch})` };
				const prompt = buildCodeWorkerPrompt(task.payload!, { worktreeDir: plan.worktreeDir, scopes: plan.scopes, ...(opts.goal ? { goal: opts.goal } : {}) });
				const before = state.subagentRuns.length;
				const pending = launchSubagent(ctx, "swarm", prompt, undefined, opts.sig, slot.model);
				const started = state.subagentRuns[before];
				if (started) started.slotId = `${slot.id}·${plan.id}`;
				const r = await pending;
				try {
					if (!r.ok) return { ok: false, output: `${r.output}\n(log: ${r.logPath})` };
					const reported = parseWorkerFiles(r.output);
					const changed = reported.length ? reported : gitIn(plan.worktreeDir, ["diff", "--name-only", "HEAD"]).out.split("\n").filter(Boolean);
					const violations = sliceViolations(changed, (rel) => {
						const abs = join(plan.worktreeDir, rel);
						try {
							return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
						} catch {
							return undefined;
						}
					});
					if (violations.length) {
						learn(ctx, `swarm code: slice ${plan.id} broke the code rules — handed back to a coder (${violations.length} violation(s))`);
						return { ok: false, output: `your slice broke the code rules — fix these in your checkout, then report FILES: again\n${formatHygieneViolations(violations)}` };
					}
					const diff = sliceDiff(ctx.cwd, plan.worktreeDir, changed);
					outcomes.push({ id: plan.id, ok: true, paths: changed, diff, output: r.output });
					return { ok: true, output: r.output };
				} finally {
					dropWorkerWorktree(ctx.cwd, plan.worktreeDir, plan.branch);
				}
			},
		});
		const mergePlan = planMerge(outcomes);
		const applied: string[] = [];
		const failedApplies: string[] = [];
		for (const step of mergePlan.steps) {
			if (!step.apply) continue;
			const o = outcomes.find((x) => x.id === step.id)!;
			const res = applySlice(ctx.cwd, o.diff ?? "");
			if (res.ok) applied.push(o.id);
			else failedApplies.push(`${o.id}: ${res.msg}`);
		}
		const failed = results.filter((r) => !r.ok);
		learn(ctx, `swarm code: ${outcomes.length}/${results.length} coder(s) produced work — merge ${applied.length} applied, ${mergePlan.blocked.length} blocked, ${failedApplies.length} apply-failed — ladder ${opts.ladder.join(" > ")} (${opts.source})${opts.notes}`);
		const lines = [
			`${failed.length || mergePlan.blocked.length || failedApplies.length ? "⚠ code swarm finished with issues" : "✅ code swarm merged"}: ${applied.length}/${results.length} slice(s) applied`,
			mergeReport(mergePlan, outcomes),
		];
		if (failed.length) lines.push(`failed coder(s): ${failed.map((f) => f.id).join(", ")}`);
		if (failedApplies.length) lines.push(`apply failed (resolve by hand): ${failedApplies.join(" · ")}`);
		if (mergePlan.overlaps.length) lines.push("overlapping slices were NOT merged — split the work so each file has one owner, or merge those by hand");
		lines.push("leftovers: worker worktrees were removed; any worktree a coder created and changed the path of lives under .zense/worktree/swarm/");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode: "code", applied, blocked: mergePlan.blocked, overlaps: mergePlan.overlaps, failedApplies, results },
			...(failed.length || mergePlan.blocked.length || failedApplies.length ? { isError: true } : {}),
		};
	};

	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
		signal?: AbortSignal, // pi agent-turn signal (Esc) — threaded into runSubagent so the user can cancel mid-run
		modelOverride?: string, // swarm slot model — wins over .zense/models.json role mapping (parallel models in one fan-out)
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const modelPattern = modelOverride ?? resolveModelPattern(ctx.cwd, role, mainModel);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		rescheduleTicker(ctx);
		updateWidget(ctx);
		// live tail per run (2026-10-22): the fan-out panel shows every agent side by side, so each
		// run keeps its own last streamed line instead of only the caller's onChunk copy
		const runChunk = (chunk: string) => {
			run.streamTail = streamTail(chunk);
			onChunk?.(chunk);
		};
		try {
			// use the worktree root as cwd when one is active → grader/reviewer run/test what was actually changed
			const subCwd = state.worktree?.root ?? ctx.cwd;
			// C: read-only roles (SUBAGENT_EXCLUDE_TOOLS) can draft specs/read the repo but not edit code
			// B: per-role timeout — built-in map + agent-visible knob .zense/config.json (subagentTimeoutMs);
			// subCwd first, then ctx.cwd (a worktree has no .zense of its own → config lives in the main repo)
			const stripFlags = await subagentStripFlagsAsync(role, subCwd, ctx.cwd);
			const r0 = await runSubagent(role, task, subCwd, subagentTimeout(role, subCwd, ctx.cwd), runChunk, logPath, modelPattern, SUBAGENT_EXCLUDE_TOOLS[role], stripFlags, signal);
			// provider-missing diagnosis (2026-09-17, pure fn diagnoseProviderMissing): silent
			// fallback (usedModel has a different provider than the pattern) / hard error (stderr
			// matches PROVIDER_MISSING_RX) → heal
			const diagnosis = diagnoseProviderMissing(modelPattern, r0);
			let r = r0;
			let healHandled = false;
			// a user cancel (Esc) is not a provider problem — never auto-heal/relaunch after it
			if (diagnosis && !signal?.aborted) {
				healHandled = true;
				r = await healProviderMismatch(ctx, role, modelPattern!, r0, subCwd, stripFlags, task, onChunk, run, diagnosis.patternProvider);
			}
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			run.streamTail = undefined;
			if (r.usedModel) run.model = r.usedModel;
			// verify the actually-run model matches the config — pi can fall back to its default
			// silently when a pattern won't resolve (unknown provider/id → no error, lands on the
			// saved default = usually the main agent's model)
			if (!healHandled && modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				learn(ctx, `sub-agent model mismatch: ${role} requested ${modelPattern} but ran ${r.usedModel}`);
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config asked for "${modelPattern}" but actually ran "${r.usedModel}" (pi fallback? check .zense/models.json / /zense models)`, "warning");
			}
			if (!r.ok) learn(ctx, `sub-agent failed: ${role} — ${r.output.split("\n")[0].slice(0, 160)}`);
			return r;
		} finally {
			rescheduleTicker(ctx);
			persist();
			updateWidget(ctx);
		}
	};


	// ----- the only write policy left: ADR-free, gate-free — writes go where the agent aims,
	//       redirected into the session worktree when one is active. Code rules are enforced on
	//       the result (tool_result below), never by asking a human first.

	pi.on("tool_call", async (ev, ctx) => {
		const target = (ev.input as { path?: string })?.path;
		if (target && state.spec?.scope?.length && !state.goalDriver) {
			const rel = relative(ctx.cwd, resolve(ctx.cwd, target));
			const inScope = state.spec.scope.some((g) => rel.startsWith(g.replace(/\*\*?$/, "")));
			if (!inScope) {
				state.trajectoryFlags.push(`out-of-scope write: ${rel}`);
				ctx.ui.notify(`⚠ trajectory: ${rel} outside spec.scope`, "warning");
			}
		}
		applyRedirect(ev, ctx);
	});

	// ----- code hygiene (goal-confirm rewrite, 2026-10-22): the code rules the human asked for
	//       are enforced HERE, not merely asked for in the prompt — every write/edit of a code
	//       file is re-scanned and the violation text is appended to the tool result, so the
	//       same turn sees what is wrong and rewrites it (no human gate in between).

	const applyHygieneCheck = (ev: any, ctx: ExtensionContext): { content?: any[]; isError?: boolean } | undefined => {
		const name = ev.toolName;
		if (name !== "write" && name !== "edit") return undefined;
		const path = (ev.input as { path?: string })?.path;
		if (typeof path !== "string" || !path) return undefined;
		const abs = resolve(ctx.cwd, path);
		if (state.worktree && abs.startsWith(resolve(state.worktree.root))) return undefined;
		if (!isHygieneChecked(abs)) return undefined;
		let text: string;
		try {
			text = readFileSync(abs, "utf8");
		} catch {
			return undefined;
		}
		const scan = scanSource(text, relative(ctx.cwd, abs) || abs);
		if (!scan.violations.length) {
			if (state.hygieneViolations) {
				state.hygieneViolations = undefined;
				persist();
				updateWidget(ctx);
			}
			return undefined;
		}
		state.hygieneViolations = scan.violations;
		const report = formatHygieneViolations(scan.violations);
		learn(ctx, `code-hygiene: ${scan.violations.length} violation(s) in ${relative(ctx.cwd, abs)}`);
		persist();
		updateWidget(ctx);
		const content = Array.isArray(ev.content) ? [...ev.content] : [];
		content.push({ type: "text", text: `\n⚠ code-hygiene: ${report}\nfix the file you just wrote (the harness re-checks every write/edit — no human will ok it for you)` });
		return { content, isError: true };
	};

	pi.on("tool_result", async (ev, ctx) => applyHygieneCheck(ev, ctx));

	// ----- M (comment discipline): guideline appended to the system prompt only during
	// implementation (the system prompt ships every turn — pay for it only while code is
	// actually being written; leaving implementation removes it again)
	pi.on("before_agent_start", async (event, ctx) => {
		let sp = event.systemPrompt;
		if (state.phase === "implementation") sp += "\n\n" + COMMENT_DISCIPLINE_GUIDELINE;
		sp += "\n\n" + CODE_HYGIENE_GUIDELINE + "\n\n" + SWARM_ROUTING_GUIDELINE;
		// cycle-closure bulletin (2026-09-17): one-shot — consumed and persisted at once so it
		// never rides every turn; sendUserMessage is avoided on purpose (it always triggers a new
		// turn = a wasted LLM call + a surprise at session open)
		const bulletin = takeContextBulletin(state);
		if (bulletin) {
			sp += "\n\n" + bulletin;
			persist();
		}
		// old fast path: nothing changed → undefined, no new systemPrompt copy
		if (sp === event.systemPrompt) return;
		return { systemPrompt: sp };
	});

	// ----- Phase 3: turn/token usage meter

	pi.on("turn_end", async (ev, ctx) => {
		state.turnsUsed++;
		// count AssistantMessages only (human-approved 2026-09-09): widget "tok" = LLM tokens —
		// ToolResultMessage usage is tool-execution usage, explicitly "not part of main LLM
		// context accounting" per pi-ai
		const m = ev.message as { role?: string; usage?: { totalTokens?: number } } | undefined;
		state.tokensUsed += m?.role === "assistant" ? (m.usage?.totalTokens ?? 0) : 0;
		updateWidget(ctx);
		persist();
		// longrun v2 context reset (2026-09-26): the AUTO loop's retain-none reset rides THIS
		// boundary as a compaction entry draft — never pi's manual compact() API: it aborts
		// the current agent operation mid-run and never retries the interrupted turn (that
		// stalled the loop after every phase transition — the human had to resume).
		// firstKeptEntryId pointing at nothing (null) = pi's self-retaining reset: the next
		// turn's rebuilt context is [system prompt, one-line capsule directive] and the loop
		// keeps driving. No continuation flag either — this turn ends with tool results, so
		// pi schedules the next request itself (an unconditional continuation can loop)
		const marker = state.pendingLongrunCompact;
		if (!marker) return;
		state.pendingLongrunCompact = undefined; // one-shot: consume ALWAYS (any outcome) — never leak into a later unrelated turn
		persist();
		learn(ctx, `longrun ${marker.slug}: hard context reset (turn_end compaction draft, retain-none)`);
		return { entries: [{ type: "compaction", summary: marker.summary, firstKeptEntryId: null }] };
	});

	// ----- Phase 4: trajectory eval heuristics at run end

	pi.on("agent_end", async (ev, ctx) => {
		const calls = ev.messages.flatMap((m: any) => m.toolCalls ?? []);
		const failed = ev.messages.flatMap((m: any) =>
			m.role === "toolResult" && m.details?.isError ? [m] : [],
		).length;

		for (const c of calls) {
			const p = c.arguments?.path ?? c.arguments?.command ?? "";
			if (/\.(test|spec)\.(ts|js|py)/.test(p) && (c.name === "edit" || c.name === "write"))
				flag("modified/deleted test file: " + p, ctx);
			if (c.name === "bash" && /rm\s+.*test|--delete|-u jest/.test(p))
				flag("suspicious test mutation: " + p, ctx);
		}
		if (calls.length >= 5 && failed / calls.length > 0.5)
			flag(`retry storm: ${failed}/${calls.length} tool calls failed`, ctx);

		// worktree still active when the agent run ends (eval hasn't PASSed) → notify once per
		// creation (dedupe) so the human knows one is lying around
		if (state.worktree && !state.worktreeLeaveNotified) {
			state.worktreeLeaveNotified = true;
			ctx.ui.notify(`🌳 worktree left unmerged (not yet applied to main): ${state.worktree.dir}\nbranch ${state.worktree.branch} — will be applied as staged changes (no commit) automatically when eval passes`, "info");
			persist();
		}
		persist();
	});

	const flag = (msg: string, ctx: ExtensionContext) => {
		if (!state.trajectoryFlags.includes(msg)) {
			state.trajectoryFlags.push(msg);
			learn(ctx, `flag: ${msg}`);
			ctx.ui.notify(`⚠ trajectory-eval: ${msg}`, "warning");
		}
	};

	const escalate = (kind: string, detail: string, ctx: ExtensionContext) => {
		state.escalations.push({ kind, detail, at: Date.now() });
		learn(ctx, `escalation: ${kind}: ${detail}`);
		persist();
		updateWidget(ctx);
	};

	// ----- ESC guard: one instance per extension — every zense dialog opens/closes through
	// zenseCustom below

	const escGuard = createEscGuard();
	let escGuardUnsubscribe: (() => void) | undefined;

	/** Wraps ctx.ui.custom for every harness dialog — registers open/close with escGuard so ESC
	 *  while a dialog is open gets consumed by the guard (closing the topmost dialog = this
	 *  one) instead of leaking into pi's defaultEditor.onEscape (streaming abort) when focus
	 *  slips off the overlay. Dialogs need no changes to their own handleInput: when focus is
	 *  genuinely on the dialog, ESC hits the guard first anyway (input listeners run before
	 *  component routing). */
	const zenseCustom = <T>(
		ctx: ExtensionContext,
		options: unknown, // pi keeps options in 2 shapes (overlay/non-overlay) — passed through via cast
		factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any,
		// peek (2026-10-14): canPeek mirrors the "space is still free" contract of the dialog's own
		// handleInput — the guard only peeks when the dialog says yes (a picker mid-filter keeps
		// space for typing, a checkbox dialog toggles with it)
		canPeek?: () => boolean,
	): Promise<T> => {
		// setHidden mirror lives in this scope: escGuard.open's setHidden callback and pi's onHandle
		// both close over it (declared before either runs — no TDZ)
		let overlayHidden: ((hidden: boolean) => void) | undefined;
		return ctx.ui.custom<T>((tui, theme, kb, done) => {
			let closed = false;
			// closing with null semantics = cancel, matching every dialog's original ESC (every
			// callsite already accepts a T that includes null)
			const trackedDone = (v: T) => {
				if (closed) return; // guards against double done (e.g. factory throws after resolve)
				closed = true;
				handle.close();
				done(v);
			};
			// until pi's onHandle fires, the guard entry exists without a setHidden — toggle is a
			// no-op, never a crash
			const handle = escGuard.open(
				() => trackedDone(null as T),
				(hidden) => overlayHidden?.(hidden),
				canPeek,
			);
			try {
				return factory(tui, theme, kb, trackedDone);
			} catch (e) {
				trackedDone(null as T); // factory died before returning a component — drop the guard entry, don't leak it
				throw e;
			}
		}, {
			...((options as Record<string, unknown>) ?? {}),
			onHandle: (h: any) => {
				overlayHidden = (hidden: boolean) => h.setHidden(hidden);
			},
		} as never);
	};

	// ----- spec presentation: the dialog must show the full spec before a signing decision
	// (pi-tui's ScrollView needs layout integration, so we scroll manually via offset + slice)

	// zense dialogs render as overlays floating above the transcript instead of inline walls
	// of text — closing returns to the previous context instantly
	// (pi mechanism: ctx.ui.custom({ overlay: true, overlayOptions }))

	const OVERLAY_LG = { overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "85%" } } as const; // spec sign dialog (long spec to read)
	const OVERLAY_MD = { overlay: true, overlayOptions: { width: "80%", minWidth: 56, maxHeight: "80%" } } as const; // mid-size pickers
	const OVERLAY_XL = { overlay: true, overlayOptions: { width: "95%", minWidth: 60, maxHeight: "90%" } } as const; // live tail

	/** One scroll keymap shared by all dialogs (spec sign / live tail) — never fork it, it
	 *  would drift: ↑/↓ one line, ←/→ one page, g top, G bottom (plain printable keys, work in
	 *  every terminal, no clash with Mac fn-keys). No Ctrl chords — the shortest set that works
	 *  identically across both dialogs. */
	type ScrollAction = { dir: 1 | -1; page: boolean } | "top" | "bottom" | null;
	const scrollKeyAction = (data: string): ScrollAction => {
		if (matchesKey(data, Key.up)) return { dir: -1, page: false };
		if (matchesKey(data, Key.down)) return { dir: 1, page: false };
		if (matchesKey(data, Key.left)) return { dir: -1, page: true };
		if (matchesKey(data, Key.right)) return { dir: 1, page: true };
		if (data === "g") return "top";
		if (data === "G") return "bottom";
		return null;
	};

	/** n opens an optional reason box after the overlay closes (2026-10-18) — closing silently
	 *  forced the human to abort the run and retype the correction in chat. Esc on this input
	 *  keeps the quick no-reason close. */
	const REJECT_WITH_REASON = "__zense_reject_reason__";
	const askRejectReason = async (ctx: ExtensionContext, what: string): Promise<string | undefined> => {
		try {
			const reason = await ctx.ui.input(`✏️ ${what} — why not? (optional: type the correction so the agent fixes the right thing)`, "(Esc / empty = close without a reason)");
			return reason?.trim() || undefined;
		} catch {
			return undefined;
		}
	};
	type SpecSignResult = { picked: string | null; reason?: string };



	/** ext-config: checkbox dialog picking the extensions a sub-agent will load — default
	 *  all-unticked (the user opts in). Returns the array of ticked paths = to be loaded
	 *  (includes), or null on cancel; not a SelectList (that's single-select). */
	const extConfigDialog = (ctx: ExtensionContext, role: string, items: { path: string; label: string; checked: boolean }[]): Promise<string[] | null> =>
		zenseCustom<string[] | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			let cursor = 0;
			const checked = items.map((i) => i.checked);
			const visRows = () => Math.max(6, Math.floor(tui.terminal.rows * 0.6));
			return {
				render: (w: number) => {
					const h = visRows();
					const start = Math.max(0, Math.min(cursor - 2, Math.max(0, items.length - h)));
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧩 sub-agent extensions — role "${role}" (default: bare boot · space = opt into loading)`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "↑↓ move • space toggle • a = load all • n = load none • enter save • esc cancel"), 1, 0).render(w));
					for (let i = start; i < Math.min(items.length, start + h); i++) {
						const box = checked[i] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
						const mark = i === cursor ? theme.fg("accent", "▸") : " ";
						const line = ` ${mark} ${box} ${items[i].label}`;
						out.push(i === cursor ? theme.bold(line) : line);
					}
					if (items.length > h) out.push(...new Text(theme.fg("dim", `— ${start + 1}-${Math.min(start + h, items.length)}/${items.length} —`), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", `${checked.filter(Boolean).length}/${items.length} extensions will load`), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
					else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
					else if (data === " ") checked[cursor] = !checked[cursor];
					else if (data === "a") checked.fill(true);
					else if (data === "n") checked.fill(false);
					else if (matchesKey(data, Key.enter)) {
						// includes = the ticked ones — this used to return exclusions (!checked),
						// flipping the effect (unticked ones got loaded)
						done(items.filter((_, i) => checked[i]).map((it) => it.path));
						return;
					} else if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
					tui.requestRender();
				},
			};
		},
		// space is this dialog's checkbox toggle — never peek here (Esc still cancels)
		() => false);

	// ----- zense's shared picker: title + search filter + SelectList (reused for role/model picking)

	const zensePick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint = ""): Promise<string | null> => {
		// filter lives outside the factory so canPeek can see it: space peeks only while the
		// filter is empty — once the human types, space must keep feeding SelectList's filter
		let filter = "";
		return zenseCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			return {
				render: (w: number) =>
					panelize(theme, [
						...border.render(w),
						...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(w),
						...new Text(theme.fg("dim", `filter: ${filter || "(type to filter)"}${hint ? ` • ${hint}` : ""}`), 1, 0).render(w),
						...selectList.render(w),
						...new Text(theme.fg("dim", `↑↓ select • Enter confirm • Esc cancel • type = filter${filter ? "" : " • space = read chat"}`), 1, 0).render(w),
						...border.render(w),
					], w),
				invalidate: () => {
					selectList.invalidate();
				},
				handleInput: (data: string) => {
					// navigation/confirm/cancel keys go to SelectList — printable chars feed the filter
					if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						selectList.setFilter(filter);
					} else if (data.length === 1 && data >= " " && !matchesKey(data, Key.enter)) {
						filter += data;
						selectList.setFilter(filter);
					} else {
						selectList.handleInput(data);
					}
					tui.requestRender();
				},
			};
		}, () => filter === "");
	};

	// ----- requirements' clarify questions: with choices → picker (pick an option, or "Other
	// (type your own)"); without → direct input

	/** Ask one clarify question: empty choices → the old free-text input; with choices →
	 *  zensePick ending in "Other (type your own)", which opens a free-text input. Esc
	 *  (picker/input) → undefined = skip (matches input's original Esc semantics). */
	const askClarifyQuestion = async (ctx: ExtensionContext, q: ClarifyQuestion): Promise<string | undefined> => {
		if (!q.choices.length) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(a short answer is fine — Esc/empty = skip)");
		const FREE_TEXT = "__clarify_free_text__";
		const picked = await zensePick(ctx, `❓ requirements asks: ${q.question}`, [
			...q.choices.map((c) => ({ value: c, label: c })),
			{ value: FREE_TEXT, label: "Other (type your own)", description: "pick this, then type your answer" },
		]);
		if (picked === null) return undefined;
		if (picked === FREE_TEXT) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(type your answer — Esc/empty = skip)");
		return picked;
	};

	// ----- live sub-agent observability: watch output as it runs (is it stuck or not?)

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> =>
		zenseCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000); // auto-refresh every 1s
			// whole log wrapped with wrapTextWithAnsi (ANSI preserved) instead of truncate — long
			// lines read fully, not chopped to "…"; cached on (width,size,mtime) so a big log
			// isn't re-wrapped every frame (1s refresh)
			let cacheKey = "";
			let wrapped: string[] = [];
			let offset = 0;
			let follow = true; // default: stick to the tail like before — scrolling up pauses, hitting bottom resumes
			const rows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.9) - 6);
			const maxOffset = () => Math.max(0, wrapped.length - rows());
			const readWrapped = (wWrap: number): string[] => {
				const st = run.logPath && existsSync(run.logPath) ? statSync(run.logPath) : null;
				const key = `${wWrap}:${st ? `${st.size}:${Math.round(st.mtimeMs)}` : "none"}`;
				if (key !== cacheKey) {
					cacheKey = key;
					const raw = st ? readFileSync(run.logPath!, "utf8").split("\n") : ["(waiting for output…)"];
					wrapped = raw.flatMap((ln) => wrapTextWithAnsi(ln, wWrap));
				}
				return wrapped;
			};
			return {
				render: (w: number) => {
					const lines = readWrapped(Math.max(20, w - 4));
					// 90% of rows per OVERLAY_XL − 6 lines of header/tail/border — prevents clipping when rendered as an overlay
					const h = rows();
					if (follow) offset = maxOffset(); // stick to the tail until the user scrolls up
					offset = Math.max(0, Math.min(offset, maxOffset()));
					const status =
						run.status === "running"
							? `▶ running ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s`
							: run.ok
								? "✅ done"
								: "❌ failed";
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧪 sub-agent: ${run.role} — ${status}`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", run.logPath ? relative(ctx.cwd, run.logPath) : "(no log)"), 1, 0).render(w));
					const slice = lines.slice(offset, offset + h);
					for (const ln of slice) out.push("  " + ln);
					for (let i = slice.length; i < h; i++) out.push(""); // steady height, like the spec sign dialog
					const range = follow
						? "▶ tail (following end of log)"
						: `⏸ lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — press G to resume following`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "auto refresh 1s • ↑↓ scroll • ←→ page • g/G top/bottom • space = read chat • Esc close (sub-agent keeps running)"), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(null); return; }
					const act = scrollKeyAction(data);
					if (act === "top") { offset = 0; follow = false; }
					else if (act === "bottom") { follow = true; offset = maxOffset(); }
					else if (act) {
						if (act.dir < 0) follow = false; // scrolling up = stop following
						offset = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? rows() : 1)));
						if (offset >= maxOffset()) follow = true; // scrolling back to the bottom = resume following
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		});

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${r.role} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const openAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		const runs = state.subagentRuns;
		if (!runs.length) {
			ctx.ui.notify("no sub-agent runs in this session yet", "info");
			return;
		}
		const recent = runs.slice(-15).map((r, i) => ({ run: r, idx: runs.length - Math.min(runs.length, 15) + i })).reverse(); // newest first
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				recent.map(({ run: r }) => `${runLabel(r)}  log: ${r.logPath ? relative(ctx.cwd, r.logPath) : "—"}`).join("\n"),
				"info",
			);
			return;
		}
		const picked = await zenseCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("🧪 Zense sub-agent runs (pick one for a live tail)")), 1, 0));
			const list = new SelectList(
				recent.map(({ run: r, idx }) => ({
					value: String(idx),
					label: runLabel(r),
					description: `${r.summary ? r.summary.slice(0, 80) : ""} ${r.logPath ? "| " + relative(ctx.cwd, r.logPath) : ""}`.trim(),
				})),
				Math.min(recent.length, 10),
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter watch • Esc cancel • space = read chat (list hidden, comes back)"), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => panelize(theme, container.render(w), w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, () => true); // space is unbound in the agents viewer — peek freely
		const runIdx = picked == null ? -1 : Number(picked);
		if (runIdx < 0 || !state.subagentRuns[runIdx]) return;
		await tailViewer(ctx, state.subagentRuns[runIdx]);
	};

	/** 🔏 The spec signature — one helper shared by the zense_spec dialog, the gate dialog and
	 *  /zense approve */
	const approveCurrentSpec = (ctx: ExtensionContext) => {
		if (!state.spec) return false;
		const cases = goalCases(state.spec);
		learn(ctx, `goal confirmed once on spec v${state.spec.version} — ${cases.length} case(s), no further approval in this run: ${cases.slice(0, 3).join(" | ").slice(0, 240)}`);
		state.spec.approved = true;
		state.spec.approvedAt = Date.now();
		state.phase = "implementation";
		// this round's git-evidence baseline: main repo HEAD before worktree creation
		// (best-effort — not a repo → undefined)
		{
			const baseRef = gitOk(["rev-parse", "HEAD"], ctx.cwd);
			state.baselineHead = baseRef.ok ? baseRef.out.trim() : undefined;
		}
		// auto worktree-per-session: create this session's worktree at implementation start
		// (no source writes could exist before — the gate blocks them) → every tool call is
		// redirected into it until eval PASS. Reuse the existing one when still on disk:
		// signing a new spec version mid-implementation must not orphan pending work in the old
		// worktree (the branch name keeps the old version number — cosmetic only; the merge
		// message already uses the current spec.version)
		if (canReuseWorktree(state.worktree)) {
			learn(ctx, `worktree reused: ${state.worktree!.branch} for spec v${state.spec.version}`);
		} else {
			const wt = createWorktree(ctx.cwd, state.spec);
			if (wt) {
				state.worktree = wt;
				state.worktreeLeaveNotified = false;
				learn(ctx, `worktree created: ${wt.branch} @ ${wt.root}`);
			} else {
				ctx.ui.notify(`🌳 couldn't create a worktree — working in main as normal (no per-session isolation)`, "warning");
			}
		}
		// spec.json/spec.md + the archive are still written approved:false (at commit time) —
		// sync the signature into the files before finishing
		syncApprovedSpecFiles(ctx.cwd, state.spec, { json: state.specJsonPath, md: state.specMdPath });
		// guard: an earlier spec's change is still staged awaiting a commit → warn early (the
		// next apply hits the dirty-main guard anyway)
		if (state.pendingApply)
			ctx.ui.notify(`⚠ spec v${state.pendingApply.specVersion} still has staged changes awaiting a commit in main — commit or discard them before starting new work (otherwise spec v${state.spec.version}'s apply will be refused by the guard)`, "warning");
		learn(ctx, `signed spec v${state.spec.version}`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`🔏 Spec v${state.spec.version} signed — implementation gate open.`, "info");
		return true;
	};

	/** B: commit a spec in one step — new version + append-only archive into specs/ + latest
	 *  copies + immediate sign dialog. One helper shared by action=set (agent-authored) and
	 *  compile_spec (sub-agent-drafted) — identical behavior on both paths, no drift. */
	const commitSpec = async (
		ctx: ExtensionContext,
		fields: { title?: string; intent?: string; crossCheck?: string[]; outcomes?: string; approach?: string[]; scope?: string[]; constraints?: string[]; criteria?: Criterion[]; specDebt?: string[] },
		source: "set" | "compile",
		// longrun: the signed tracker IS the signature — no dialog; provenance recorded on the
		// spec; baselineOverride pins git evidence to the phase start (longrun branch HEAD),
		// not to main's HEAD (which never moves during a longrun — ADR-004)
		opts?: { sign?: "ask" | "auto"; provenance?: string; baselineOverride?: string },
	): Promise<{ version: number; signed: boolean; mdPath: string; changes?: string[]; lint?: string[]; approvedHow?: string; rejection?: string }> => {
		const version = (state.spec?.version ?? 0) + 1;
		// deterministic commit-time check lint (one choke point for both action=set and
		// compile_spec): spec-side broken checks (dead command/placeholder/unrunnable) must
		// never reach eval (probe-primacy loops) → forced into specDebt so the human sees them
		// at signing; artifact-fail (good command, work not yet implemented) = normal → quiet
		let lintNotes: string[] = [];
		if (fields.criteria?.length) {
			const lint = lintSpecChecks(ctx.cwd, fields.criteria);
			if (lint.broken.length) {
				const existing = fields.specDebt ?? [];
				// dedupe against applyQualityGate entries already added for the same id
				// (placeholder/manual-check)
				const covered = (id: string): boolean => existing.some((d) => d.startsWith("quality-gate:") && d.includes(id));
				lintNotes = lint.notes.filter((_, i) => !covered(lint.broken[i]));
				fields = { ...fields, specDebt: [...existing, ...lintNotes] };
			}
		}
		// resolve the previous spec before overwriting — session state if present; after a
		// reload/resume the state is gone → best-effort fallback to .zense/spec.json (the latest
		// copy is still the old version at this point)
		let prevSpec: Spec | undefined = state.spec;
		if (!prevSpec) {
			try {
				const latestJson = join(zenseDir(ctx.cwd), "spec.json");
				if (existsSync(latestJson)) {
					const p = JSON.parse(readFileSync(latestJson, "utf8")) as Spec;
					if (p && typeof p.version === "number") prevSpec = p;
				}
			} catch {
				/* best-effort: unreadable → simply no Changes section; never break the commit */
			}
		}
		state.spec = {
			version,
			title: fields.title ?? "untitled",
			intent: fields.intent ?? "",
			// crossCheck is the sign surface (2026-10-18): short goal cases in the request's language;
			// outcomes stays as the legacy fallback for older flows/specs
			...(fields.crossCheck?.length ? { crossCheck: fields.crossCheck } : {}),
			...(fields.outcomes ? { outcomes: fields.outcomes } : {}),
			approach: fields.approach ?? [],
			scope: fields.scope ?? [],
			constraints: fields.constraints ?? [],
			criteria: fields.criteria ?? [],
			specDebt: fields.specDebt ?? [],
			approved: false,
		};
		// re-spec (v>=2): always compute the change summary vs the previous version — the signer
		// must see what this version changes; never re-present an identical spec silently.
		// identical → buildSpecChanges returns a warning line + a lesson is logged (no block:
		// some flows re-version on purpose) | v1 has no prev → no changesFrom, unchanged behavior
		if (prevSpec && version >= 2) {
			const changes = buildSpecChanges(prevSpec, state.spec);
			state.spec.changesFrom = changes;
			if (changes.length === 1 && changes[0].startsWith("⚠️"))
				learn(ctx, `spec v${version} re-spec identical to v${version - 1} (no changes)`);
		}
		state.specSource = source; // H: remember the spec's origin — telemetry at gate overrides
		// Specs are append-only: every version gets a unique timestamped file in
		// .zense/specs/ so any past spec can be re-read. spec.{json,md} stay as
		// always-latest convenience copies.
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); // YYYY-MM-DD-HH-mm-ss
		const slug =
			(state.spec.title ?? "untitled").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
			"untitled";
		const specDir = join(zenseDir(ctx.cwd), "specs");
		mkdirSync(specDir, { recursive: true });
		const jsonPath = join(specDir, `${stamp}-v${version}-${slug}.json`);
		const mdPath = join(specDir, `${stamp}-v${version}-${slug}.md`);
		writeFileSync(jsonPath, JSON.stringify(state.spec, null, 2));
		writeFileSync(mdPath, renderSpecMd(state.spec));
		copyFileSync(jsonPath, join(zenseDir(ctx.cwd), "spec.json"));
		copyFileSync(mdPath, join(zenseDir(ctx.cwd), "spec.md"));
		state.specMdPath = mdPath;     // zense_eval appends its outcome to this file
		state.specJsonPath = jsonPath;
		// signing moment (zense/sign): the ONE decision point (2026-10-18) — tracker signature,
		// gate OFF and a goal-stable re-spec skip the dialog; only a changed goal asks a human.
		// The spec was archived to disk first, so a rejection/sign always has a file to point at.
		const goalsUnchanged = !!prevSpec?.approved && sameGoalLines(prevSpec, state.spec);
		const decision = decideSpecApproval({
			signMode: opts?.sign,
			gateEnabled: state.gateEnabled,
			goalsUnchanged,
			hasUI: ctx.hasUI,
			tui: ctx.mode === "tui",
		});
		let signed = false;
		let approvedHow: string | undefined;
		let rejection: string | undefined;
		if (decision.kind === "auto") {
			approvedHow = decision.reason;
			if (decision.reason === "tracker") {
				state.spec.approvedBy = opts?.provenance;
				if (opts?.baselineOverride) state.baselineHead = opts.baselineOverride;
				if (opts?.provenance) learn(ctx, `spec v${version} auto-approved by ${opts.provenance} (tracker signature)`);
			} else if (decision.reason === "gate-off") {
				state.spec.approvedBy = "gate-off";
				learn(ctx, `spec v${version} auto-approved: gate OFF (no sign prompt)`);
			} else {
				state.spec.approvedBy = `goals-unchanged:v${prevSpec?.version ?? "?"}`;
				learn(ctx, `spec v${version} auto-approved: goal cases unchanged from v${prevSpec?.version ?? "?"} (no re-sign)`);
			}
			signed = true;
			approveCurrentSpec(ctx);
		} else if (decision.kind === "ask") {
			const choice = await ctx.ui.select(
				`🔏 Sign spec v${version}: ${state.spec.title}? (full text at .zense/spec.md)`,
				[
					"🔏 Sign & approve — open the implementation gate",
					"✏️ Not yet (amend the spec first / sign later with /zense approve)",
				],
			);
			signed = !!choice && choice.startsWith("🔏");
			if (signed) approveCurrentSpec(ctx);
			else rejection = await askRejectReason(ctx, `Not signing spec v${version}`);
		}
		if (rejection) learn(ctx, `spec v${version} rejected at signing: ${rejection.slice(0, 300)}`);
		persist();
		updateWidget(ctx);
		return { version, signed, mdPath, ...(approvedHow ? { approvedHow } : {}), ...(rejection ? { rejection } : {}), ...(state.spec.changesFrom?.length ? { changes: state.spec.changesFrom } : {}), ...(lintNotes.length ? { lint: lintNotes } : {}) };
	};

	/** Suffix appended to zense_spec's tool result: a re-spec (v>=2) must also surface the
	 *  change summary to the agent/human in the transcript — not just in the dialog/archive
	 *  (an identical spec carries a ⚠️ warning line from buildSpecChanges). */
	const changesText = (r: { version: number; changes?: string[] }): string =>
		r.changes?.length
			? `\n\nChanges in v${r.version} (vs v${r.version - 1}):\n${r.changes.map((x) => `- ${x}`).join("\n")}`
			: "";

	// ----- tools exposed to the agent ("phase sub-agents" via pi.registerTool)






	/** Accept side of pendingApply (shared by /zense accept and the zense_accept tool):
	 *  closes the account → learns the outcome into memory (accepted cleanly / with
	 *  amendments / warnings) → maintenance.
	 *  commitIfStaged=true means "the human asked for a commit on their behalf" — the helper
	 *  commits with the prepared message (hooks run normally). */
	const acceptPending = (ctx: ExtensionContext, commitIfStaged: boolean, notifyViaBulletin = false): { ok: boolean; text: string; specVersion?: number } => {
		if (!state.pendingApply)
			return { ok: false, text: "no pending apply to accept (already accepted/committed, or never applied)" };
		// longrun: this pendingApply is the WHOLE tracker's final apply — accepting it closes
		// the tracker (a mid-phase longrun has no pendingApply by construction, so hitting this
		// branch with state.longRun set can only mean the final apply)
		if (state.longRun) {
			const t = loadTracker(ctx.cwd, state.longRun.slug);
			if (t && t.status === "active") {
				t.status = "done";
				saveTracker(ctx.cwd, t);
				appendSpecsLog(ctx.cwd, t.slug, `tracker COMPLETE — final apply accepted on main`);
				learn(ctx, `longrun ${t.slug}: tracker v${t.version} done (${t.phases.length} phases) — merged into main`);
			}
		}
		const v = state.pendingApply.specVersion;
		const specTitle = state.spec?.title ?? ""; // captured before the reset — the bulletin needs it
		const r = acceptPendingApply(ctx.cwd, { evalTree: state.lastEval?.head, preApplyHead: state.pendingApply.preApplyHead, commitIfStaged });
		if (!r.ok) return { ok: false, text: `⚠️ accept failed: ${r.msg}` };
		state.pendingApply = undefined;
		// a positive outcome is a cycle signal too — push an "accepted" escalation (same
		// pattern as "discarded") so the next reviewer packet/telemetry sees both sides, not
		// just failures
		state.escalations.push({ kind: "accepted", detail: `spec v${v} accepted by human${r.amendedFiles.length ? ` — amended: ${r.amendedFiles.join(", ")}` : ""}`, at: Date.now() });
		const headNow = gitOk(["rev-parse", "HEAD"], ctx.cwd).out.trim().slice(0, 12);
		const amendLine = r.amendedFiles.length
			? `\n✏️ the human amended ${r.amendedFiles.length} file(s) after the grader passed: ${r.amendedFiles.join(", ")} — if unintended, inspect with git show HEAD`
			: "";
		learn(
			ctx,
			r.amendedFiles.length
				? `spec v${v} accepted @${headNow} with human amendments: ${r.amendedFiles.join(", ")}`
				: `spec v${v} accepted @${headNow} cleanly (no human amendments)`,
		);
		if (r.committedOnBehalf) learn(ctx, `spec v${v} accepted: harness committed staged change on human request`);
		for (const w of r.warnings) learn(ctx, `accept warning spec v${v}: ${w}`);
		// cycle closure (2026-09-17): a successful accept ends the round — reset cycle state so
		// the next job starts at spec v1; the bulletin only on the command path (/zense
		// accept): the tool path already hands the agent a tool result
		if (notifyViaBulletin) state.contextBulletin = buildAcceptBulletin(v, specTitle, r.amendedFiles.length);
		resetCycleState(state);
		persist();
		updateWidget(ctx);
		const warnText = r.warnings.length ? `\n⚠️ ${r.warnings.join("\n⚠️ ")}` : "";
		return {
			ok: true,
			specVersion: v,
			text: `✅ spec v${v} accepted — ${r.msg}${r.committedOnBehalf ? " (harness committed with the prepared message)" : ""}${amendLine}${warnText}\ncycle closed: the next piece of work starts with a new zense_spec (v1)`,
		};
	};


	// ----- long-running mode (ADR-004): tracker-signed multi-phase requirements · one worktree
	//       for the whole set · per-phase human review gate · merge into main only at the end

	/** Reconcile precondition shared by next/close/resume (ambient-state distrust): assert the
	 *  worktree is on the tracker branch. Clean mismatches auto-heal; dirty/diverged states are
	 *  the human's call (picker) — never auto. lastCheckpoint = newest done phase's checkpoint. */
	const longrunReconcile = async (
		ctx: ExtensionContext,
		tracker: Tracker,
		lastCheckpoint?: string,
	): Promise<{ ok: boolean; text?: string; wt?: WorktreeT }> => {
		const wt = state.worktree && state.worktree.branch === tracker.worktreeBranch ? state.worktree : undefined;
		const rec = reconcileLongrunWorktree(wt?.root, tracker.worktreeBranch, lastCheckpoint);
		if (rec.status === "missing-worktree") {
			const ens = ensureLongrunWorktree(ctx.cwd, tracker.slug, tracker.worktreeBranch);
			if (!ens)
				return { ok: false, text: `❌ .zense/worktree/longrun-${tracker.slug} is occupied by a non-worktree directory — refusing to touch it (may hold human work); inspect/remove it manually` };
			state.worktree = ens.wt;
			state.worktreeLeaveNotified = false;
			learn(ctx, `longrun ${tracker.slug}: worktree ${ens.created ? "(re)created" : "reattached"}: ${tracker.worktreeBranch}`);
			persist();
			return { ok: true, wt: ens.wt };
		}
		if (rec.status === "checkpoint-diverged") {
			escalate("need-decision", `longrun ${tracker.slug}: checkpoint ${lastCheckpoint?.slice(0, 12)} is not an ancestor of ${tracker.worktreeBranch} HEAD (branch rewound outside the flow?)`, ctx);
			return { ok: false, text: `⛔ checkpoint-diverged: the recorded checkpoint ${lastCheckpoint?.slice(0, 12)} is not an ancestor of HEAD on ${tracker.worktreeBranch} — the branch moved outside the flow. Human resolution required (escalation recorded) — never auto-healed\ncheck: git -C ${state.worktree?.root ?? `.zense/worktree/longrun-${tracker.slug}`} log --oneline -10` };
		}
		if (rec.status === "wrong-branch" || rec.status === "detached") {
			if (rec.healable) {
				const h = healToBranch(wt!.root, tracker.worktreeBranch);
				if (!h.ok) return { ok: false, text: `❌ auto-heal failed switching back to ${tracker.worktreeBranch}: ${h.msg}` };
				learn(ctx, `longrun ${tracker.slug}: healed HEAD (${rec.status}${rec.actualBranch ? `: ${rec.actualBranch}` : ""}) → ${tracker.worktreeBranch}`);
				return { ok: true, wt: wt! };
			}
			// dirty tree on the wrong branch/detached = possibly the human's uncommitted review edits — only they may decide
			if (!ctx.hasUI)
				return { ok: false, text: `⛔ longrun worktree is on "${rec.actualBranch ?? "DETACHED"}" with ${rec.dirty.length} uncommitted change(s) (expected ${tracker.worktreeBranch}, no UI to ask) — human: cd ${wt!.root} && git status, then retry` };
			const preview = rec.dirty.slice(0, 10).join("\n") + (rec.dirty.length > 10 ? `\n… (+${rec.dirty.length - 10} more)` : "");
			const choice = await ctx.ui.select(
				`longrun worktree is on branch "${rec.actualBranch ?? "DETACHED"}" with ${rec.dirty.length} uncommitted change(s):\n${preview}\n\nexpected branch: ${tracker.worktreeBranch}`,
				[
					"📦 stash → switch back → pop onto the longrun branch (the changes belong to the phase work)",
					"🗑 discard the uncommitted changes, then switch back (destroys them)",
					"✋ cancel — I'll fix the worktree myself",
				],
			);
			if (!choice || choice.startsWith("✋"))
				return { ok: false, text: "reconcile cancelled by the human — resolve the longrun worktree branch state, then retry" };
			if (choice.startsWith("📦")) {
				gitOk(["stash", "push", "-u", "-m", "longrun-reconcile"], wt!.root);
				const h = healToBranch(wt!.root, tracker.worktreeBranch);
				if (!h.ok) return { ok: false, text: `❌ switch-back failed after stashing (changes are safe in git stash): ${h.msg}` };
				const pop = gitOk(["stash", "pop"], wt!.root);
				learn(ctx, `longrun ${tracker.slug}: stash-healed onto ${tracker.worktreeBranch}${pop.ok ? "" : " (pop reported conflicts)"}`);
				if (!pop.ok) return { ok: false, text: `⚠ switched back to ${tracker.worktreeBranch} but git stash pop reported conflicts — resolve them in ${wt!.root} first` };
			} else {
				gitOk(["reset", "-q", "--hard", "HEAD"], wt!.root);
				gitOk(["clean", "-fd", "--", ".", NOT_ZENSE], wt!.root);
				healToBranch(wt!.root, tracker.worktreeBranch);
				learn(ctx, `longrun ${tracker.slug}: discarded ${rec.dirty.length} uncommitted change(s) on human order, back on ${tracker.worktreeBranch}`);
			}
		}
		return { ok: true, wt: wt ?? undefined };
	};

	/** The final merge (tracker complete → ADR-003 staged apply-back, exactly once). Shared by
	 *  close's last-phase path and its dirty-main retry (awaitingFinalApply). */
	const longrunApplyFinal = (ctx: ExtensionContext, tracker: Tracker): { ok: boolean; text: string } => {
		if (!state.spec || !state.worktree) return { ok: false, text: "internal: final apply needs the last phase's spec + worktree in state" };
		const wtBranch = state.worktree.branch;
		const preHead = gitOk(["rev-parse", "HEAD"], ctx.cwd);
		const ar = applyWorktreeBack(ctx.cwd, state.spec, state.worktree);
		if (!ar.ok) {
			state.longRun = { ...state.longRun!, awaitingFinalApply: true } satisfies LongRunRef;
			persist();
			escalate("need-decision", `longrun ${tracker.slug} final apply: ${ar.msg}`, ctx);
			return { ok: false, text: `⚠ final apply refused: ${ar.msg}\nfix main, then call zense_longrun close again — the retry skips checkpointing and only retries the apply` };
		}
		learn(ctx, `longrun ${tracker.slug}: worktree applied: ${ar.msg}`);
		state.worktree = null;
		const idxTree = gitOk(["write-tree"], ctx.cwd); // same repin as eval-PASS: reviewer evidence must read the index tree
		if (idxTree.ok && state.lastEval) state.lastEval.head = idxTree.out.trim();
		if (ar.paths.length) {
			state.pendingApply = { specVersion: state.spec.version, branch: wtBranch, paths: ar.paths, appliedAt: Date.now(), ...(preHead.ok ? { preApplyHead: preHead.out.trim() } : {}) };
			try { writeFileSync(join(zenseDir(ctx.cwd), PENDING_MSG), ar.commitMsg ?? composeCommitMessage(state.spec, [])); } catch { /* best-effort */ }
		}
		persist();
		return {
			ok: true,
			text: `🌳 longrun "${tracker.slug}" COMPLETE — the whole phase set (${tracker.phases.length} phases) is staged in main (${ar.paths.length} file(s), not yet committed)\n` +
				`review: git status · git diff --cached — then commit: git commit -F .zense/pending-apply.msg → /zense accept (marks the tracker done)\n` +
				`↩️ unhappy with the whole set → zense_discard (reverse patch restores main; checkpoints stay on the deleted branch's reflog)`,
		};
	};

	/** Close out a phase's cycle scope but KEEP the longrun ref + worktree (unlike
	 *  resetCycleState, which runs only at whole-tracker closure).
	 *  preserveFinalApply (regression fix 2026-09-28): the completion paths call this right
	 *  AFTER longrunApplyFinal — which just created state.pendingApply and repinned
	 *  state.lastEval.head to the index tree. Wiping either here made /zense accept blind
	 *  in the same turn ("no pending apply to accept") and the tracker could never reach
	 *  "done". Mid-phase closure keeps the clears (its pendingApply is undefined by
	 *  construction; its lastEval belongs to the phase being closed). */
	const resetLongrunPhaseCycle = (slug: string, trackerVersion: number, extra?: Partial<LongRunRef>, preserveFinalApply = false): void => {
		state.spec = undefined;
		state.phase = "requirements";
		if (!preserveFinalApply) state.lastEval = undefined;
		state.baselineHead = undefined;
		state.evalOverrideFails = undefined;
		state.specSource = undefined;
		state.specMdPath = undefined;
		state.specJsonPath = undefined;
		state.lastCompileLessons = undefined;
		state.worktreeLeaveNotified = undefined;
		if (!preserveFinalApply) state.pendingApply = undefined;
		state.longRun = { slug, trackerVersion, ...extra };
	};

	const trackerSummaryLines = (t: Tracker): string => {
		const done = t.phases.filter((p) => p.status === "done").length;
		return `${t.slug} — "${t.title}" [v${t.version} ${t.status}] ${done}/${t.phases.length} phases done · branch ${t.worktreeBranch}`;
	};

	/** The auto loop's phase advance (v2 — replaces the human close gate for auto trackers):
	 *  called on eval PASS (and from the `auto` action). Checkpoints deterministically,
	 *  snapshots the eval verdict into the tracker (digest source), then — more phases → arm
	 *  the one-line reset directive into pendingLongrunCompact; the hard context reset happens
	 *  at the turn_end boundary as a self-retaining compaction draft (retain-none) — WITHOUT
	 *  pausing the run; last phase → the ONE
	 *  final staged apply + digest.md. Never asks the human anything (ADR-004 gates remain:
	 *  tracker signature + final review + ADR approvals). */
	const autoLoopAdvance = (ctx: ExtensionContext, t: Tracker): { ok: boolean; text: string; complete?: boolean } => {
		const phaseId = state.longRun?.activePhase;
		const phase = phaseId ? findPhase(t, phaseId) : undefined;
		if (!phase) return { ok: false, text: `auto-advance: no active phase in tracker "${t.slug}" (state/disk mismatch — human check tracker.json)` };
		if (!state.worktree || !state.spec) return { ok: false, text: "auto-advance: missing worktree/spec (session restarted?) — run zense_longrun resume first" };
		const ck = checkpointCommit(state.worktree.root, `longrun(${t.slug}): ${phase.id} ${phase.title}`);
		if (!ck.ok) return { ok: false, text: `auto-advance: checkpoint commit failed: ${ck.msg}` };
		const filesChanged = gitOk(["diff", "--name-only", `${phase.baseline ?? "HEAD"}..HEAD`, "--", ".", NOT_ZENSE], state.worktree.root).out.split("\n").map((s) => s.trim()).filter(Boolean);
		phase.status = "done";
		phase.checkpoint = ck.sha;
		phase.specVersion = state.spec.version;
		phase.verdict = state.lastEval?.verdict ?? "PASS";
		phase.criteriaVerdicts = state.lastEval ? { ...state.lastEval.perCriteria } : undefined;
		phase.filesChanged = filesChanged;
		phase.summaryPath = writePhaseSummary(
			ctx.cwd,
			t,
			phase,
			`eval PASS — verdicts: ${Object.entries(phase.criteriaVerdicts ?? {}).map(([id, v]) => `${id}:${v}`).join(", ") || phase.verdict}`,
			filesChanged,
		);
		saveTracker(ctx.cwd, t);
		appendSpecsLog(ctx.cwd, t.slug, `phase ${phase.id} auto-advanced → checkpoint ${ck.sha?.slice(0, 12)} (${filesChanged.length} files)`);
		state.escalations.push({ kind: "accepted", detail: `longrun ${t.slug} phase ${phase.id} auto-advanced (checkpoint ${ck.sha?.slice(0, 12)})`, at: Date.now() });
		learn(ctx, `longrun ${t.slug}: auto-advance phase ${phase.id} → checkpoint ${ck.sha?.slice(0, 12)}`);
		if (!allPhasesDone(t)) {
			const nextP = nextPendingPhase(t)!;
			resetLongrunPhaseCycle(t.slug, t.version, { auto: true, autoFixRounds: 0 });
			// hard context reset (v2): arm the one-shot marker — the turn_end boundary handler
			// consumes it when THIS turn finishes and appends a self-retaining compaction draft
			// (firstKeptEntryId: null → retain-none; no LLM summary — v1's growing-context bug;
			// no prior-phase capsule — the fresh context re-reads the tracker from disk via
			// zense_longrun next). NEVER pi's manual compact() API here: it aborts the
			// current agent operation mid-run and never retries the interrupted turn — the loop
			// stalled after every phase transition until a human resumed it (2026-09-26)
			state.pendingLongrunCompact = { slug: t.slug, summary: buildCompactionCapsule(t) };
			persist();
			return { ok: true, text: `✅ phase ${phase.id} auto-advanced — checkpoint ${ck.sha?.slice(0, 12)} (${filesChanged.length} file(s))\ncontext is being hard-reset (retain-none — a one-line directive to call zense_longrun next survives)\n\n${buildNextPhaseKickoff(ctx.cwd, t, nextP)}` ,complete: false};
		}
		// last phase → the single human review gate: staged final apply + digest.md
		const digest = buildLongrunDigest(ctx.cwd, t);
		const r = longrunApplyFinal(ctx, t);
		if (!r.ok) return { ok: false, text: `✅ final phase ${phase.id} auto-advanced (checkpoint ${ck.sha?.slice(0, 12)}) — but the final apply needs attention:\n${r.text}`, complete: true };
		const slugKeep = t.slug, ver = t.version;
		resetLongrunPhaseCycle(slugKeep, ver, { auto: true, autoFixRounds: 0 }, true); // final apply: keep pendingApply+lastEval for /zense accept (2026-09-28)
		state.phase = "review";
		persist();
		return { ok: true, text: `✅ final phase ${phase.id} auto-advanced — the whole set is complete\n📋 YOUR SINGLE REVIEW: ${digest}\n${r.text}`, complete: true };
	};


	// ----- zense_ask: the harness picker as a general agent tool — any phase, not just the
	// requirements clarify loop (a design decision the human should pick gets a real picker
	// instead of a "1. a 2. b 3. c" plain-text list)

	pi.registerTool({
		name: "zense_ask",
		label: "Zense Ask Human",
		description:
			"Ask the human GOAL-ONLY questions through the harness multiple-choice picker (search-filtered TUI with an 'Other (type your own)' free-text option). Callable in ANY phase — prefer this over dumping a '1. a 2. b 3. c' numbered list as chat text. Ask ONLY about the product/UI outcome the human wants (what the result should be or do), each question carrying 2–6 pickable choices. NEVER ask internal technical/detail questions — library choice, module split, file layout, naming, test approach, data shape, refactor structure, error-handling style — or ask the human to pick an implementation strategy: decide those yourself from the repo/context, proceed, and record the decision as an explicit assumption plus a specDebt entry the human reviews at signing. Choices may be omitted only for a genuine product/UI question with no guessable options, and then the question MUST set freeText:true. In non-UI (RPC/print) sessions it returns guidance to ask in plain text instead — it never hangs.",
		promptSnippet: "Ask the human a product/UI-goal question with a multiple-choice picker (choices required; never ask what you should decide yourself)",
		promptGuidelines: [
			"Ask ONLY product/UI-outcome questions — what the human wants the result to be or do. If a wrong guess would be cheap, do not ask at all: decide, proceed, and note the assumption.",
			"Never ask the human an internal technical/detail decision: library, module split, file layout, naming, test approach, data shape, refactor structure, error handling, or any implementation strategy — decide those from the repo/context yourself and record an explicit assumption plus a specDebt entry instead.",
			"Attach 2–6 plausible choices to EVERY question; the human can also pick 'Other (type your own)' to answer freely. Esc = that question is skipped (reported as such — never infer an answer from a skip).",
			"Choices may be omitted only for a genuine product/UI-outcome question that has no guessable options, and that question must set freeText:true (the harness rejects a choice-less question otherwise).",
			"Keep it to the few decision-critical questions (max 5 per call); this is an interactive check-in, not batch form-filling.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String(),
					choices: Type.Optional(Type.Array(Type.String(), { description: "pickable options (2–6). Required for every question except a product/UI-outcome question that genuinely has no guessable options — that one sets freeText:true instead" })),
					freeText: Type.Optional(Type.Boolean({ description: "true ONLY for a product/UI-outcome question with no guessable options (the picker then renders a plain input). A question with neither choices nor freeText is rejected" })),
				}),
				{ description: "questions asked in order, each with its own picker (max 5)" },
			),
		}),
		async execute(_id, p, _s, _o, ctx) {
			// gate OFF (2026-10-18): ALL human questions are disabled — no picker, no waiting. The
			// agent must decide from the repo/context and record the assumption + specDebt instead.
			if (!state.gateEnabled)
				return {
					content: [{ type: "text", text: "gate is OFF — human questions are disabled. Decide from the repo/context yourself, record the decision as an explicit assumption + specDebt entry, and proceed (no picker was opened)." }],
					details: { gateOff: true, asked: 0 },
				};
			const { questions: qsAll, violations } = askQuestionScan(p.questions);
			// policy rejection (2026-10-16): a choice-less / bare-string question never reaches the
			// human — the model gets the policy back immediately and fixes it in the same turn
			if (violations.length) return { content: [{ type: "text", text: askPolicyError(violations) }], details: { violations }, isError: true };
			if (!qsAll.length) return { content: [{ type: "text", text: "zense_ask: no usable question — pass at least one non-empty question text" }], details: {}, isError: true };
			const qs = qsAll;
			// no UI → never await a picker: graceful non-error guidance (RPC/print must not hang)
			if (!ctx.hasUI) return { content: [{ type: "text", text: ASK_NO_UI_TEXT }], details: { noUi: true } };
			const answers: AskAnswer[] = [];
			for (const q of qs)
				answers.push({ question: q.question, answer: await askClarifyQuestion(ctx as ExtensionContext, q) }); // Esc/skip resolves undefined per question — never aborts the rest
			learn(ctx as ExtensionContext, `zense_ask: ${qs.length} question(s), ${answers.filter((a) => a.answer === undefined).length} skipped`);
			return { content: [{ type: "text", text: formatAskAnswers(answers) }], details: { answers } };
		},
	});

	// ----- zense_swarm: parallel fan-out. explore = read-only research/verify slices running at
	//       the same time on the configured priority ladder (one model per slot, capped by
	//       swarmConcurrency); coding / goal-driving / per-worktree isolation arrive in later
	//       phases, so `mode: "code"` is refused here rather than half-done.

	pi.registerTool({
		name: "zense_swarm",
		label: "Zense Swarm",
		description:
			"Run several sub-agents AT THE SAME TIME on your configured model ladder (priority1..priority5 in .zense/models.json, capped by swarmConcurrency). mode=explore fans a goal out into read-only research slices; mode=verify sends independent verifiers that must prove the goal with real commands; mode=code gives every slice its OWN git worktree + branch so coders write in parallel without touching each other, then merges back in deterministic slice-id order and refuses to merge silently when two slices touched the same path. No token/cost ceiling.",
		promptSnippet: "Fan out parallel sub-agents across the model priority ladder (explore / verify / code in isolated worktrees)",
		promptGuidelines: [
			"Use zense_swarm explore when a goal needs many independent reads (survey, locate, compare) — gives back one merged report instead of serial sub-agent turns.",
			"Use zense_swarm verify to prove the result against reality: each verifier must RUN commands and end with VERDICT: PASS/FAIL. A claim with no executed command is UNVERIFIED, never PASS. The loop is bounded — fix the real cause and call verify again; identical evidence stops it.",
			"Use zense_swarm code when the change splits into independent slices: each coder gets its own worktree, so give every slice its scope and let them all run at once. Slices that need the same file must be one slice — overlapping paths are blocked and reported, never merged silently.",
			"Decide library/layout/approach yourself — do not ask the human.",
		],
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("explore"), Type.Literal("verify"), Type.Literal("code")] as const),
			goal: Type.Optional(Type.String({ description: "the outcome the whole fan-out serves (verifiers judge against exactly this)" })),
			subtasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "short stable id, unique within the call (e.g. s1) — used verbatim in the worker's worktree and branch, so lowercase letters/digits/-/_ only" }),
					instruction: Type.String({ description: "self-contained slice: that worker sees only this text" }),
					scope: Type.Optional(Type.Array(Type.String(), { description: "repo-relative paths this slice may touch — two slices sharing a path are a conflict, so split differently" })),
				}),
				{ description: "1–8 independent slices — they run concurrently, so none may depend on another" },
			),
			maxAttempts: Type.Optional(Type.Integer({ description: "attempts per slice before it counts as failed (default 2)" })),
		}),
		async execute(_id, p, sig, _on, ctx) {
			if (!p.subtasks.length) return { content: [{ type: "text", text: "zense_swarm: subtasks must contain at least one slice" }], details: {}, isError: true };
			if (p.subtasks.length > 8) return { content: [{ type: "text", text: `zense_swarm: at most 8 slices per call (got ${p.subtasks.length}) — split into several calls` }], details: {}, isError: true };
			const ids = new Set<string>();
			for (const s of p.subtasks) {
				if (!s.id.trim() || ids.has(s.id)) return { content: [{ type: "text", text: `zense_swarm: subtask id "${s.id}" is empty or duplicated` }], details: {}, isError: true };
				ids.add(s.id);
			}
			const mainPattern = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const { ladder, source } = effectiveLadder(ctx.cwd, mainPattern);
			const slots = swarmSlots(ladder);
			if (!slots.length)
				return {
					content: [{ type: "text", text: "zense_swarm: no model to run — set priority1..priority5 in .zense/models.json (each a pi model pattern like \"provider/model\"), or run the swarm from a session whose model resolves; it uses as many slots as are set" }],
					details: { missingLadder: true },
					isError: true,
				};
			const concurrency = readSwarmConcurrency(ctx.cwd, slots.length);
			const notes = costCeilingKeysPresent(ctx.cwd).length ? ` ⚠ ignored ceiling key(s): ${costCeilingKeysPresent(ctx.cwd).join(", ")}` : "";
			const runOne = <T,>(promptFor: (task: SwarmTask<T>, attempt: number) => string) => async (task: SwarmTask<T>, slot: SwarmSlot, attempt: number) => {
				if (sig?.aborted) return { ok: false, output: "cancelled by user (Esc)" };
				const before = state.subagentRuns.length;
				const pending = launchSubagent(ctx, "swarm", promptFor(task, attempt), undefined, sig, slot.model);
				const started = state.subagentRuns[before];
				if (started) started.slotId = slot.id;
				const r = await pending;
				return { ok: r.ok, output: r.ok ? r.output : `${r.output}\n(log: ${r.logPath})` };
			};
			if (p.mode === "code") return await runCodeSwarm(ctx, p.subtasks, { slots, concurrency, maxAttempts: p.maxAttempts ?? 2, goal: p.goal, sig, ladder, source, notes });
			const fan: FanOutArgs = { mode: p.mode, subtasks: p.subtasks.map((s) => ({ id: s.id.trim(), instruction: s.instruction })), ...(p.goal?.trim() ? { goal: p.goal.trim() } : {}) };
			const tasks = fan.subtasks.map((s) => ({ id: s.id, payload: s }));
			const results = await runSwarm(tasks, { slots, concurrency, maxAttempts: p.maxAttempts ?? 2, run: runOne((task, attempt) => buildFanOutPrompt(fan, task.payload!, attempt)) });
			const failed = results.filter((r) => !r.ok);
			const body = results
				.map((r) => `## ${r.id} ${r.ok ? "✓" : "✗"}${r.model ? ` [${r.model}]` : ""}${r.attempts > 1 ? ` (${r.attempts} attempts)` : ""}\n${r.output.trim() || "(no output)"}`)
				.join("\n\n");
			learn(ctx, `swarm ${p.mode}: ${swarmSummaryLine(results)} — ladder ${ladder.join(" > ")} (${source})${notes}`);
			if (p.mode === "verify") {
				const report = buildReport(results.map((r) => judgeCase(r.id, r.output, r.ok ? {} : { exitCode: 1 })));
				const active = state.goalDriver as GoalRunState | undefined;
				const driver = active && !active.doneAt ? active : undefined;
				const loop = driver ? driver.loop : state.verifyLoop ?? freshVerifyLoop();
				const decision = nextVerifyRound(loop, report);
				if (driver) {
					const step = nextGoalDriverStep({ ...driver, loop }, report);
					state.goalDriver = step.state;
					state.verifyLoop = step.state.loop;
					persist();
					updateWidget(ctx);
					learn(ctx, `goal driver: ${step.action} round ${step.round}/${MAX_VERIFY_ROUNDS} — ${step.state.outcome ?? "running"}`);
					if (step.action === "fix") armGoalRound(step.text);
					return {
						content: [{ type: "text", text: [buildGoalToolText({ ...driver, loop }, step), "", body].join("\n") }],
						details: { mode: p.mode, report, decision, step: step.action, outcome: step.state.outcome, results },
						...(report.allPass ? {} : { isError: true }),
					};
				}
				state.verifyLoop = advanceLoop(loop, report);
				persist();
				learn(ctx, `verify: ${report.allPass ? "PASS" : "not verified"} round ${state.verifyLoop.round}/${MAX_VERIFY_ROUNDS} — ${report.cases.map((c) => `${c.caseId}:${c.verdict}`).join(", ")}`);
				const fix = decision.kind === "retry" ? buildFixPrompt(report, decision.round, MAX_VERIFY_ROUNDS) : decision.kind === "stop" ? `⛔ verify stopped (${decision.halt ? "bound" : "no new evidence"}): ${decision.reason}` : "";
				return {
					content: [{ type: "text", text: [renderVerifyReport(report, state.verifyLoop), fix, "", body].filter(Boolean).join("\n") }],
					details: { mode: p.mode, report, decision, results },
					...(report.allPass ? {} : { isError: true }),
				};
			}
			return {
				content: [{ type: "text", text: `${swarmSummaryLine(results)} (concurrency ${concurrency})\n\n${body}${failed.length ? `\n\n⚠ ${failed.length} slice(s) failed — re-run just those slices or do them yourself` : ""}` }],
				details: { mode: p.mode, concurrency, results },
				...(failed.length ? { isError: true } : {}),
			};
		},
	});

	// ----- zense_goal: one confirmation, then the harness itself drives the loop — verify,
	//       hand the failures back, verify again — until every case is proven or the bounded
	//       driver stops. No approval step between rounds; the human reads one report at the end.

	pi.registerTool({
		name: "zense_goal",
		label: "Zense Goal",
		description:
			"Confirm a goal ONCE and let the harness drive it: it runs the verify fan-out on your model ladder, judges each case from executed evidence, hands the failures back for another round, and stops with one report when every case is proven or the bound is reached. No per-round approval, no token/cost ceiling. Use it instead of asking the human anything mid-run.",
		promptSnippet: "Confirm the goal once, then let the driver loop verify→fix until proven (bounded, evidence-gated)",
		promptGuidelines: [
			"Call zense_goal first with the goal and its cases: that single confirmation is the only human input this run needs.",
			"After a 'fix' step, fix the real cause and call zense_goal again with the same goal — the driver keeps the round count and detects unchanged evidence.",
			"Any case left UNVERIFIED (no executed command) is not progress: run a command that proves it, or report honestly that it cannot be proven here.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "the outcome, in the human's words — one goal per run" }),
			cases: Type.Optional(Type.Array(Type.String(), { description: "the cases that make the goal true (defaults to the spec's own goal cases)" })),
		}),
		async execute(_id, p, _s, _o, ctx) {
			const goal = p.goal.trim();
			if (!goal) return { content: [{ type: "text", text: "zense_goal: goal is empty — state the outcome the human wants" }], details: {}, isError: true };
			const cases = (p.cases ?? []).map((c) => c.trim()).filter(Boolean);
			const started = resumeOrStart(state.goalDriver as GoalRunState | undefined, goal);
			state.goalDriver = started;
			if (cases.length && !state.spec) {
				state.spec = { version: 1, title: goal.slice(0, 80), intent: goal, crossCheck: cases, approach: [], scope: [], constraints: [], criteria: [], specDebt: [], approved: true, approvedAt: Date.now(), approvedBy: "goal", createdAt: Date.now() } as any;
				state.phase = "implementation";
			}
			if (cases.length && state.spec) state.spec.crossCheck = cases;
			persist();
			updateWidget(ctx);
			learn(ctx, `goal confirmed once: ${goal.slice(0, 160)}${cases.length ? ` (${cases.length} case(s))` : ""} — round ${started.loop.round}`);
			const next = goalCases({ crossCheck: cases, outcomes: undefined, intent: goal });
			return {
				content: [{ type: "text", text: buildGoalToolText(started, { action: "fix", round: started.loop.round, report: { cases: [], allPass: false, unverified: [], failed: [] }, state: started, text: `the goal is confirmed — work until every case holds, then prove it:
${next.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}

prove it with real commands (zense_swarm mode=verify or your own runs); no further approval will be asked.` }) }],
				details: { goal, cases: next, round: started.loop.round },
			};
		},
	});

	// Review-packet card in the transcript.

	// ----- Phase 6: memory/learning log

	const learn = (ctx: ExtensionContext, note: string) => {
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		appendFileSync(join(zenseDir(ctx.cwd), "memory.jsonl"), JSON.stringify({ at: Date.now(), phase: state.phase, note }) + "\n");
	};


	// ----- human gates: commands

	// Shortcut options considered: ctrl+letter is all reserved by pi (docs/keybindings.md —
	// undo occupies ctrl+-); alt+letter is broken on macOS where Option sends a literal char
	// instead of an Escape prefix (unpressable) → ctrl+_ (payload 0x1F): clearly supported by
	// pi-tui keys.js and clashes with no pi default binding (fallback: /zense agents)
	pi.registerShortcut(Key.ctrl("_"), {
		description: "Zense: watch sub-agent runs live (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	// runExtConfig: shared ext-config logic per role — used by both /zense ext-config <role>
// (legacy arg, backward compat) and the per-role commands /zense:ext-config:<role>
// (autocompletes straight from the command name — pi's API supplies only the current
// word's prefix, making positional completion impossible)
	const runExtConfig = async (ctx: ExtensionContext, role: string, action?: string, vals: string[] = []): Promise<void> => {
		const exts = (await listInstalledExtensions(ctx.cwd)).filter((e) => e.enabled);
		const cur = new Set(subagentExtIncludes(role, ctx.cwd));
		const apply = (includes: string[]) => {
			const { globalSeeded } = writeSubagentExtIncludes(ctx.cwd, role, includes);
			ctx.ui.notify(
				`✅ ${role}: will load ${includes.length}/${exts.length} extensions${includes.length ? "" : " (bare boot)"} — saved to local .zense/config.json${globalSeeded ? " (+ first-time global seed ~/.pi/agent/zense/config.json)" : ""} · takes effect on the next sub-agent run`,
				"info",
			);
		};
		if (ctx.mode === "tui" && !action) {
			const includes = await extConfigDialog(
				ctx,
				role,
				exts.map((e) => ({ path: e.path, label: `${extDisplayLabel(e)} · ${e.source}`, checked: cur.has(e.path) })),
			);
			if (includes === null) return ctx.ui.notify("cancelled — config unchanged", "info");
			apply(includes);
			return;
		}
		// text actions (non-TUI or an explicit action) — on/off takes a 1-based index (from the
		// list below) or a path substring
		if (action === "all") apply(exts.map((e) => e.path));
		else if (action === "none" || action === "default") apply([]);
		else if (action === "on" || action === "off") {
			const target = vals.join(" ").trim();
			if (!target) return ctx.ui.notify(`missing target — /zense ext-config-show ${role} ${action} <index|path>`, "warning");
			const asNum = Number(target);
			const hit =
				Number.isInteger(asNum) && asNum >= 1 && asNum <= exts.length ? exts[asNum - 1].path : exts.find((e) => e.path.includes(target))?.path;
			if (!hit) return ctx.ui.notify(`extension "${target}" not found — see the list with /zense ext-config-show ${role} (no action)`, "warning");
			const next = new Set(cur);
			if (action === "on") next.add(hit);
			else next.delete(hit);
			apply([...next]);
		} else if (!action) {
			ctx.ui.notify(
				[
					`installed (enabled) extensions — ${role} loads ${cur.size}/${exts.length}:`,
					...exts.map((e, i) => `  ${i + 1}. ${cur.has(e.path) ? "[x]" : "[ ]"} ${e.path}`),
					`toggle: /zense ext-config ${role} on|off <index|path> · all = load everything · none = load nothing (default)`,
				].join("\n"),
				"info",
			);
		} else {
			return ctx.ui.notify(`unknown action: "${action}" — no action (TUI=checkbox / non-TUI=list) | all | none | on|off <index|path>`, "warning");
		}
	};

	/** /zense distill — condense memory.jsonl into one lesson set + clear specs/ and
	 *  subagents/ logs. Safety order (never reshuffle): count the impact → confirm y/n →
	 *  distiller sub-agent (read-only) → strict output validation → only then overwrite
	 *  memory + delete history. Any failure aborts without deleting anything. */
	const runDistill = async (ctx: ExtensionContext): Promise<void> => {
		const zd = zenseDir(ctx.cwd);
		const memPath = join(zd, "memory.jsonl");
		const impact = distillImpact(ctx.cwd);
		if (!impact.memoryLines)
			return ctx.ui.notify("📚 memory is empty — nothing to distill (per the rule no lessons = no deletion, specs/subagents stay untouched)", "info");
		// hard guard: the content is embedded whole into the prompt — over the ceiling, an
		// explicit abort beats silently distilling from partial history
		if (impact.memoryBytes > MAX_DISTILL_MEMORY_BYTES)
			return ctx.ui.notify(`⚠ memory.jsonl is ${fmtBytes(impact.memoryBytes)} — over the ${fmtBytes(MAX_DISTILL_MEMORY_BYTES)} ceiling for embedding whole into a prompt; trim/filter it yourself first, then distill (nothing has been touched)`, "warning");
		let memoryContent: string;
		try {
			memoryContent = readFileSync(memPath, "utf8");
		} catch (e) {
			return ctx.ui.notify(`⚠ can't read memory.jsonl: ${String(e).slice(0, 120)} — aborted, nothing touched`, "warning");
		}
		const running = state.subagentRuns.filter((r) => r.status === "running").map((r) => r.role);
		const detail = [
			`memory.jsonl lessons : ${impact.memoryLines} lines (${fmtBytes(impact.memoryBytes)}) → distilled into one set and rewritten (same format)`,
			`specs archive        : ${impact.specFiles} file(s) (${fmtBytes(impact.specBytes)}) → deleted entirely`,
			`subagent logs        : ${impact.logFiles} file(s) (${fmtBytes(impact.logBytes)}) → deleted entirely`,
			"untouched            : adr/ · config.json · models.json · spec.json · spec.md",
			"",
			"⚠ deletion is unrecoverable (no archive) — if the sub-agent fails to distill, it aborts and deletes nothing",
			...(running.length ? [`⚠ sub-agent(s) still running: ${running.join(", ")} — their logs will be deleted mid-run; better to wait for them`] : []),
		].join("\n");
		const ok = await ctx.ui.confirm("🧹 /zense distill — confirm distilling memory + deleting history?", detail);
		if (!ok) return ctx.ui.notify("distill cancelled — no files changed", "info");
		ctx.ui.notify(`🧪 distilling ${impact.memoryLines} lessons… (distiller sub-agent, read-only)`, "info");
		const logPath = subagentLogPath(ctx.cwd, "distiller");
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		// always runs in the main cwd (not the worktree — its memory is a checkout-time copy),
		// hence a direct runSubagent call, not launchSubagent
		const r = await runSubagent("distiller", distillTaskPrompt(memoryContent, impact.memoryLines), ctx.cwd, subagentTimeout("distiller", ctx.cwd), undefined, logPath, resolveModelPattern(ctx.cwd, "distiller", mainModel), SUBAGENT_EXCLUDE_TOOLS.distiller, await subagentStripFlagsAsync("distiller", ctx.cwd));
		if (!r.ok) {
			learn(ctx, `distill aborted: distiller sub-agent failed — ${r.output.split("\n")[0].slice(0, 160)}`);
			ctx.ui.notify(`⚠ distiller failed — aborted; nothing deleted/overwritten (log: ${relative(ctx.cwd, logPath)})`, "warning");
			return;
		}
		const parsed = parseDistilledLessons(r.output);
		if (!parsed.ok) {
			learn(ctx, `distill aborted: distiller output invalid (${parsed.error})`);
			ctx.ui.notify(`⚠ distiller output is invalid: ${parsed.error} — aborted; nothing deleted/overwritten (log: ${relative(ctx.cwd, logPath)})`, "warning");
			return;
		}
		// atomic: tmp+rename — a mid-write crash can't corrupt the original; a failed write
		// aborts before the deletion phase (the "any failure deletes nothing" promise)
		try {
			replaceFileAtomic(memPath, buildDistilledMemory(parsed.lessons));
		} catch (e) {
			learn(ctx, `distill aborted: overwriting memory.jsonl failed (${String(e).slice(0, 120)})`);
			ctx.ui.notify(`⚠ overwriting memory.jsonl failed (${String(e).slice(0, 120)}) — aborted; specs/logs not deleted, the original file is intact`, "warning");
			return;
		}
		const specsN = clearDirFiles(join(zd, "specs"));
		const logsN = clearDirFiles(join(zd, "subagents"), new Set([basename(logPath)])); // keep the latest distiller log for audit
		learn(ctx, `distilled memory: ${impact.memoryLines} → ${parsed.lessons.length} lessons; cleared specs ×${specsN}, logs ×${logsN}`);
		ctx.ui.notify(`✅ distill done — memory ${impact.memoryLines} lines → ${parsed.lessons.length} lessons · deleted ${specsN} spec file(s) · ${logsN} log file(s) (distiller log kept)`, "info");
	};

	/** 🔁 /zense resume — explicit adoption of an on-disk cycle into a FRESH session
	 *  (appendEntry restore covers same-session resumes; a genuinely new session starts empty
	 *  and spec/worktree/pendingApply pointers would otherwise be lost). Human decision
	 *  (2026-09-20): no auto-adopt — a session that doesn't resume abandons the old cycle
	 *  (files stay untouched on disk; clean up an abandoned worktree with git worktree remove). */
	const resumeZense = (ctx: ExtensionContext): void => {
		if (state.spec)
			return ctx.ui.notify(
				`nothing to resume — this session already owns spec v${state.spec.version} (${state.spec.approved ? "signed" : "unsigned"})`,
				"warning",
			);
		const disc = discoverResumeState(ctx.cwd);
		if (!disc)
			return ctx.ui.notify(
				"nothing to resume — no valid .zense/spec.json on disk (no spec was ever committed here, or the file is corrupt)",
				"info",
			);
		const disk = disc.spec;
		state.spec = disk;
		state.phase = disk.approved ? "implementation" : "requirements"; // unsigned spec resumes with the gate closed — sign via /zense approve
		state.specJsonPath = disc.specJsonPath;
		state.specMdPath = disc.specMdPath;
		// worktree rewire — found → redirect resumes; gone → work continues in main (never a failure)
		let wtLine: string;
		if (disc.worktree) {
			state.worktree = disc.worktree;
			state.worktreeLeaveNotified = true; // this notify already carries the "applied on eval PASS" info
			wtLine =
				`🌳 worktree rewired: ${disc.worktree.root}\n  branch ${disc.worktree.branch} — tool calls are redirected here; applied as staged changes on eval PASS` +
				(disc.worktreeExactVersion === false ? `\n  ⚠ branch predates spec v${disk.version} (reused worktree across a version bump) — verify it holds the right in-progress work` : "");
			learn(ctx, `resume: worktree rewired ${disc.worktree.branch} @ ${disc.worktree.root}`);
		} else {
			wtLine = "no matching worktree found — working directly in main";
		}
		// pendingApply restore — eval PASS staged the change in main, then the human reopened a
		// session to review/commit: without the pointer /zense accept|discard would be blind
		let paLine = "";
		if (disc.pendingApply) {
			state.pendingApply = disc.pendingApply;
			learn(ctx, `resume: pendingApply restored (${disc.pendingApply.paths.length} staged path(s))`);
			paLine = `\n⏳ pending apply restored: ${disc.pendingApply.paths.length} file(s) staged awaiting a commit — git commit -F .zense/pending-apply.msg · /zense accept · or /zense discard`;
		}
		learn(ctx, `resumed spec v${disk.version} from disk (approved=${disk.approved})`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(
			`🔁 resumed spec v${disk.version}${disk.approved ? " (signed — implementation gate open)" : " (unsigned — gate closed; sign via /zense approve)"}: ${disk.title}\n${wtLine}${paLine}`,
			"info",
		);
	};

	pi.registerCommand("zense", {
		description: "Zense harness (zense = human signature/sign): status | resume | approve | accept | discard | agents | gate on|off | memory | distill | models | ext-config-show",
		getArgumentCompletions: (prefix) =>
			// offer only real /zense subcommands — roles (requirements/grader/reviewer) stay out
			// (they have dedicated /zense:ext-config:<role> commands), and actions (all/none/
			// on/off) are second-level args of ext-config-show which pi can't positionally
			// separate → including them would conjure phantom subcommands at position 1
			["status", "resume", "accept", "discard", "agents", "distill", "memory", "models", "ext-config-show", "surface"]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			if (sub === "surface") {
				ctx.ui.notify(surfaceLine(ctx.cwd), "info");
				return;
			} else if (sub === "status") {
				const disk = state.spec ? null : loadSpecFromDisk(ctx.cwd);
				ctx.ui.notify(
					`phase=${state.phase} spec=${state.spec ? `v${state.spec.version} approved=${state.spec.approved}` : "—"}\n` +
						(disk ? `📄 on-disk spec found: v${disk.version} ${disk.approved ? "(signed)" : "(unsigned)"} — /zense resume to continue it, or ignore to abandon\n` : "") +
						(state.worktree ? `worktree: ${state.worktree.dir}\n  branch ${state.worktree.branch} (active — applied as staged changes on eval PASS, never auto-committed)\n` : `worktree: (none — working in main)\n`) +
						`turns=${state.turnsUsed} tokens=${state.tokensUsed}\n` +
						(state.pendingApply
							? `⏳ pending apply: spec v${state.pendingApply.specVersion} — ${state.pendingApply.paths.length} file(s) staged awaiting a commit (from ${state.pendingApply.branch})\n  commit: git commit -F .zense/pending-apply.msg · accept after committing: /zense accept · roll back: /zense discard (reverse patch)\n`
							: "") +
						`trajectory flags:\n${state.trajectoryFlags.join("\n") || "(none)"}\nescalations:\n${state.escalations.map((e) => `${e.kind}: ${e.detail}`).join("\n") || "(none)"}`,
					"info",
				);
			} else if (sub === "resume") {
				resumeZense(ctx);
			} else if (sub === "discard") {
				// roll back the pending applied change (reverse patch) — the official undo path for
				// an unhappy human review
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to discard (the change was already committed, or never applied)", "info");
				const dr = discardPendingApply(ctx.cwd);
				if (!dr.ok) {
					escalate("need-decision", `discard: ${dr.msg}`, ctx);
					return ctx.ui.notify(`⚠ discard failed: ${dr.msg}`, "warning");
				}
				const v = state.pendingApply.specVersion;
				state.pendingApply = undefined;
				learn(ctx, `spec v${v} discarded after review (reverse-applied)`);
				state.contextBulletin = buildDiscardBulletin(v); // command path (human-typed) — the agent learns via the next turn's system prompt
				resetCycleState(state);
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`✅ ${dr.msg} — spec v${v} has been rolled back out of main`, "info");
			} else if (sub === "accept") {
				// pendingApply's accept side (discard's counterpart): "/zense accept commit" =
				// human wants the harness to commit for them
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to accept (already committed/accepted, or never applied)", "info");
				let commitIfStaged = rest[0] === "commit";
				if (!commitIfStaged && !gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
					// staged leftovers = the human hasn't committed — offer to commit on their behalf
					// (soft, never auto-commits)
					const ok =
						ctx.mode === "tui" &&
						(await ctx.ui.confirm(
							`✅ accepting spec v${state.pendingApply.specVersion} — but staged changes are still pending (not yet committed)`,
							"have the harness commit them with .zense/pending-apply.msg, then accept? (hooks run normally)\nchoosing No cancels: commit yourself, then /zense accept again",
						));
					if (!ok)
						return ctx.ui.notify(
							"not committed yet — commit yourself with `git commit -F .zense/pending-apply.msg`, then /zense accept; or let the harness do it: /zense accept commit",
							"info",
						);
					commitIfStaged = true;
				}
				const r = acceptPending(ctx, commitIfStaged, true);
				ctx.ui.notify(r.text, r.ok ? "info" : "warning");
			} else if (sub === "longrun") {
			// long-running mode (ADR-004) from the keyboard — mirrors zense_longrun's actions for
			// the human: status=list, resume=pick by name, sign=a saved-but-unsigned tracker,
			// abandon=destroy the set's worktree. Agent-side lives in the zense_longrun tool.
			const [action, target] = rest;
			if (action === "status" || action === "list" || !action) {
				const trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status !== "done");
				ctx.ui.notify(
					trackers.length
						? `🏗 long-running requirements:\n${trackers
								.map(
									(t) =>
										`  ${t.status === "active" ? "▶" : "○"} ${t.slug} — "${t.title}" [v${t.version} ${t.status}] ${t.phases.filter((ph) => ph.status === "done").length}/${t.phases.length} phases done` +
										(state.longRun?.slug === t.slug ? "  ← session-active" : ""),
								)
								.join("\n")}\n\nresume: /zense longrun resume — agent: zense_longrun status`
						: "no long-running requirements (.zense/long-running/) — start one: /zense longrun start <requirement prompt> (or the agent's zense_longrun init)",
					"info",
				);
			} else if (action === "resume") {
				const trackers = discoverLongrunTrackers(ctx.cwd).filter((t) => t.status === "active");
				let t = target ? trackers.find((x) => x.slug === target) : trackers.length === 1 ? trackers[0] : undefined;
				if (!t && trackers.length && ctx.mode === "tui") {
					const pick = await ctx.ui.select("resume which long-running requirement?", trackers.map((x) => `${x.slug} — "${x.title}" (${x.phases.filter((ph) => ph.status === "done").length}/${x.phases.length} done)`));
					if (pick) t = trackers.find((x) => pick.startsWith(x.slug));
				}
				if (!t)
					return ctx.ui.notify(trackers.length ? `pick one: /zense longrun resume <slug>\n${trackers.map((x) => `  ${x.slug}`).join("\n")}` : "no active longrun to resume", "warning");
				state.longRun = { slug: t.slug, trackerVersion: t.version, ...(t.phases.find((x) => x.status === "active") ? { activePhase: t.phases.find((x) => x.status === "active")!.id } : {}) };
				persist();
				updateWidget(ctx);
				// same idle-agent nudge as /zense approve: a slash command starts no turn
				const kick = `Zense: the human resumed longrun "${t.slug}" — continue it now: reconcile + activate the next/current phase with the zense_longrun tool (action=resume slug=${t.slug}, which verifies the worktree), then proceed`;
				try { pi.sendUserMessage(kick); } catch { try { pi.sendUserMessage(kick, { deliverAs: "followUp" }); } catch { /* non-fatal */ } }
				ctx.ui.notify(`🔁 resuming longrun "${t.slug}"…`, "info");
			} else if (action === "sign") {
				const t = target ? loadTracker(ctx.cwd, target) : undefined;
				if (!t) return ctx.ui.notify("usage: /zense longrun sign <slug>", "warning");
				if (t.status !== "planning") return ctx.ui.notify(`tracker "${t.slug}" is ${t.status} — sign applies only to a saved-but-unsigned plan`, "warning");
				const ok = await ctx.ui.confirm(`🔏 Sign longrun tracker "${t.slug}" v${t.version}?`, `${t.phases.length} phase(s): ${t.phases.map((x) => x.id).join(", ")} — one signature covers all phases\n(full plan: .zense/long-running/${t.slug}/tracker.md)`);
				if (!ok) return ctx.ui.notify("not signed", "info");
				t.approvedAt = Date.now();
				t.status = "active";
				saveTracker(ctx.cwd, t);
				state.longRun = { slug: t.slug, trackerVersion: t.version };
				const ens = ensureLongrunWorktree(ctx.cwd, t.slug, t.worktreeBranch);
				if (ens) {
					state.worktree = ens.wt;
					state.worktreeLeaveNotified = false;
				}
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`🔏 tracker "${t.slug}" v${t.version} signed — tell the agent to continue (zense_longrun next)`, "info");
			} else if (action === "start") {
				// start a NEW longrun from the keyboard: the command can't call the tool itself, so
				// it nudges the idle agent (same sendUserMessage pattern as /zense approve) to run
				// zense_longrun init with the prompt as the requirement text
				const prompt = rest.slice(1).join(" ").trim();
				if (!prompt) return ctx.ui.notify("usage: /zense longrun start <requirement prompt>", "warning");
				if (state.longRun) return ctx.ui.notify(`a longrun is already active in this session: "${state.longRun.slug}" — finish/abandon it first`, "warning");
				const kick = `Zense: the human started a long-running requirement from the keyboard:\n"""\n${prompt}\n"""\nstart it now with zense_longrun: action=init, title=a concise name for it, intent=what it wants and why, specsMd=the prompt above verbatim (expanded only if the human asked for more), then continue the normal flow (plan → the human signs the tracker once → next)`;
				try { pi.sendUserMessage(kick); } catch { try { pi.sendUserMessage(kick, { deliverAs: "followUp" }); } catch { /* non-fatal */ } }
				ctx.ui.notify("🏗 longrun start requested — the agent will init + plan it (you sign the tracker once)", "info");
			} else if (action === "abandon") {
				ctx.ui.notify(`use the agent: ask it to run zense_longrun abandon slug=${target ?? "<slug>"} — it enforces the pendingApply guard and confirm flow`, "info");
			} else {
				ctx.ui.notify("usage: /zense longrun status|start <prompt>|resume [slug]|sign <slug>|abandon <slug>", "info");
			}
		} else if (sub === "agents") {
				await openAgentsViewer(ctx);
			} else if (sub === "memory") {
				if (rest[0] === "json") {
					// raw JSONL tail
					const f = join(zenseDir(ctx.cwd), "memory.jsonl");
					ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
				} else {
					const lines = memorySummaryLines(ctx.cwd);
					ctx.ui.notify(
						lines.length ? [...lines, "(raw: /zense memory json)"].join("\n") : "📚 memory is empty — lessons accumulate on every escalation/flag/eval/sub-agent failure",
						"info",
					);
				}
			} else if (sub === "distill") {
				await runDistill(ctx);
			} else if (sub === "models") {
				// view/set sub-agent models per role (.zense/models.json)
				const cfgPath = join(zenseDir(ctx.cwd), "models.json");
				const cfg = readModelsConfig(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const roles = ["requirements", "planner", "grader", "reviewer", "distiller"];
				if (ctx.mode !== "tui") {
					// non-TUI (rpc/print): show a summary for manual editing, as before
					const lines = [
						`🧪 sub-agent models — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .zense/models.json — every role uses the main model)"}`,
						`main agent: ${mainModel}`,
						...roles.map((r) => `  ${r}: ${cfg[r] ? cfg[r] + " (from config)" : mainModel + " (fallback)"}`),
						"edit by creating .zense/models.json, e.g. { \"grader\": \"openai/gpt-4o-mini\" } — or open the TUI and use /zense models for an interactive picker",
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				// TUI: interactive picker — pick a role → pick a model from the catalogue →
				// models.json gets written
				const role = await zensePick(
					ctx,
					"🧪 pick the sub-agent role to set a model for",
					roles.map((r) => ({
						value: r,
						label: r,
						description: cfg[r] ? `${cfg[r]} (from config)` : `${mainModel} (fallback)`,
					})),
					`main agent: ${mainModel}`,
				);
				if (!role) return;
				const choices = availableModelChoices(ctx);
				const sel = await zensePick(
					ctx,
					`🧪 pick a model for role "${role}"`,
					[
						{ value: "__default__", label: "↩️ use the main model (remove override)", description: `falls back to ${mainModel}` },
						{ value: "__custom__", label: "✏️ type a pattern yourself", description: "e.g. openai/gpt-4o-mini or sonnet:high" },
						...choices.map((c) => ({ value: c.pattern, label: c.label, description: c.description })),
					],
					choices.length ? `${choices.length} models from the catalogue` : "catalogue empty — pick 'type a pattern yourself'",
				);
				if (!sel) return;
				if (sel === "__default__") {
					writeModelsConfig(ctx.cwd, role, null);
					ctx.ui.notify(`✅ ${role}: override removed — the next sub-agent run falls back to the main model (${mainModel})`, "info");
					return;
				}
				let pattern = sel;
				if (sel === "__custom__") {
					const typed = (await ctx.ui.input(`model pattern for "${role}":`, "provider/model-id"))?.trim();
					if (!typed) return ctx.ui.notify("cancelled — model unchanged", "info");
					pattern = typed;
				}
				writeModelsConfig(ctx.cwd, role, pattern);
				ctx.ui.notify(`✅ ${role}: ${pattern} — wrote ${relative(ctx.cwd, cfgPath)} (takes effect on the next sub-agent run)`, "info");
			} else if (sub === "ext-config-show" || sub === "ext-config") {
				// ext-config-show (new name; ext-config kept as alias): no role → combined view of
				// all roles; with a role → delegate to runExtConfig (the main path is the per-role
				// commands /zense:ext-config:<role>)
				const roles = ["requirements", "planner", "grader", "reviewer", "distiller"];
				const [role, action, ...vals] = rest;
				if (!role || !roles.includes(role)) {
					ctx.ui.notify(
						[
							"🧩 sub-agent extension loading (per role) — default: bare boot, no extensions · tick to opt specific ones back in",
							...roles.map((r) => {
								const inc = subagentExtIncludes(r, ctx.cwd);
								return `  ${r}: ${inc.length ? `loads ${inc.length}` : "bare boot (no extensions)"}`;
							}),
							`persist: local ${join(zenseDir(ctx.cwd), "config.json")} · global ${join(zenseGlobalConfigDir(), "config.json")} (first-time seed + fallback)`,
							"configure: /zense:ext-config:grader | :requirements | :reviewer (TUI = instant checkboxes) or /zense ext-config-show <role> all|none|on|off <index|path>",
						].join("\n"),
						"info",
					);
					return;
				}
				await runExtConfig(ctx, role, action, vals);
			} else {
				ctx.ui.notify("usage: /zense status|resume|approve|accept [commit]|discard|agents|gate on|off|memory|distill|models|ext-config-show|longrun status|longrun resume|longrun sign", "info");
			}
		},
	});

	// per-role ext-config commands (v8): autocomplete straight from the command name, no role
	// arg to type (pi's getArgumentCompletions supplies only the current word's prefix — same
	// pattern as skill commands)
	for (const role of ["requirements", "planner", "grader", "reviewer", "distiller"] as const)
		pi.registerCommand(`zense:ext-config:${role}`, {
			description: `which extensions sub-agent "${role}" loads (default: bare boot — opt in by ticking; saved to local .zense + first-time global seed)`,
			handler: async (_args, ctx) => runExtConfig(ctx as ExtensionContext, role),
		});
}

