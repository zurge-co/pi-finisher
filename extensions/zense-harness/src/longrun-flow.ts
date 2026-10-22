import { existsSync } from "node:fs";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildLongrunDigest, buildNextPhaseKickoff } from "./longrun-auto.ts";
import { checkpointCommit, findPhase, healToBranch, reconcileLongrunWorktree, saveTracker, writePhaseSummary } from "./longrun.ts";
import { NOT_ZENSE, applyWorktreeBack } from "./pending-apply.ts";
import { type Escalate, type Learn, type Persist, type HarnessContext } from "./kit.ts";
import { gitOk, ensureLongrunWorktree } from "./worktree.ts";
import { type LongRunRef, type State, type Tracker, type Worktree as WorktreeT } from "./types.ts";

export const createLongrunFlow = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const persist = ctx.persist;
	const escalate = ctx.escalate;
	const pi = ctx.pi;

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
				return { ok: false, text: "reconcile cancelled by the human — resolve the longrun worktree branch ctx.state, then retry" };
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

	const longrunApplyFinal = (ctx: ExtensionContext, tracker: Tracker): { ok: boolean; text: string } => {
		if (!state.spec || !state.worktree) return { ok: false, text: "internal: final apply needs the last phase's spec + worktree in ctx.state" };
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
		const idxTree = gitOk(["write-tree"], ctx.cwd);
		if (idxTree.ok && state.lastEval) state.lastEval.head = idxTree.out.trim();
		if (ar.paths.length) {
			state.pendingApply = { specVersion: state.spec.version, branch: wtBranch, paths: ar.paths, appliedAt: Date.now(), ...(preHead.ok ? { preApplyHead: preHead.out.trim() } : {}) };
			try { writeFileSync(join(zenseDir(ctx.cwd), PENDING_MSG), ar.commitMsg ?? composeCommitMessage(state.spec, [])); } catch {  }
		}
		persist();
		return {
			ok: true,
			text: `🌳 longrun "${tracker.slug}" COMPLETE — the whole phase set (${tracker.phases.length} phases) is staged in main (${ar.paths.length} file(s), not yet committed)\n` +
				`review: git status · git diff --cached — then commit: git commit -F .zense/pending-apply.msg → /zense accept (marks the tracker done)\n` +
				`↩️ unhappy with the whole set → zense_discard (reverse patch restores main; checkpoints stay on the deleted branch's reflog)`,
		};
	};

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

	const autoLoopAdvance = (ctx: ExtensionContext, t: Tracker): { ok: boolean; text: string; complete?: boolean } => {
		const phaseId = state.longRun?.activePhase;
		const phase = phaseId ? findPhase(t, phaseId) : undefined;
		if (!phase) return { ok: false, text: `auto-advance: no active phase in tracker "${t.slug}" (ctx.state/disk mismatch — human check tracker.json)` };
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
			state.pendingLongrunCompact = { slug: t.slug, summary: buildCompactionCapsule(t) };
			persist();
			return { ok: true, text: `✅ phase ${phase.id} auto-advanced — checkpoint ${ck.sha?.slice(0, 12)} (${filesChanged.length} file(s))\ncontext is being hard-reset (retain-none — a one-line directive to call zense_longrun next survives)\n\n${buildNextPhaseKickoff(ctx.cwd, t, nextP)}` ,complete: false};
		}
		const digest = buildLongrunDigest(ctx.cwd, t);
		const r = longrunApplyFinal(ctx, t);
		if (!r.ok) return { ok: false, text: `✅ final phase ${phase.id} auto-advanced (checkpoint ${ck.sha?.slice(0, 12)}) — but the final apply needs attention:\n${r.text}`, complete: true };
		const slugKeep = t.slug, ver = t.version;
		resetLongrunPhaseCycle(slugKeep, ver, { auto: true, autoFixRounds: 0 }, true);
		state.phase = "review";
		persist();
		return { ok: true, text: `✅ final phase ${phase.id} auto-advanced — the whole set is complete\n📋 YOUR SINGLE REVIEW: ${digest}\n${r.text}`, complete: true };
	};

	return { longrunReconcile, longrunApplyFinal, resetLongrunPhaseCycle, trackerSummaryLines, autoLoopAdvance };
};
