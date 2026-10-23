import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freshState, resetCycleState } from "./cycle.ts";
import { acceptPendingApply, PENDING_MSG, PENDING_PATCH, composeCommitMessage, isGitRepo, uncommittedChanges } from "./pending-apply.ts";
import { buildAcceptBulletin } from "./cycle.ts";
import { type AcceptPending, type AskRejectReason, type Learn, type Persist, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { lintSpecChecks } from "./evidence.ts";
import { canReuseWorktree, createWorktree, gitOk } from "./worktree.ts";
import { buildSpecChanges, decideSpecApproval, renderSpecMd, sameGoalLines, syncApprovedSpecFiles } from "./spec-changes.ts";
import { goalCases } from "./goal-confirm.ts";
import { zenseDir, type Criterion, type Spec, type State } from "./types.ts";

export const createSpecFlow = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const persist = ctx.persist;
	const askRejectReason = ctx.askRejectReason;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;

	const approveCurrentSpec = (ctx: ExtensionContext) => {
		if (!state.spec) return false;
		const cases = goalCases(state.spec);
		learn(ctx, `goal confirmed once on spec v${state.spec.version} — ${cases.length} case(s), no further approval in this run: ${cases.slice(0, 3).join(" | ").slice(0, 240)}`);
		state.spec.approved = true;
		state.spec.approvedAt = Date.now();
		state.phase = "implementation";
		{
			const baseRef = gitOk(["rev-parse", "HEAD"], ctx.cwd);
			state.baselineHead = baseRef.ok ? baseRef.out.trim() : undefined;
		}
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
		syncApprovedSpecFiles(ctx.cwd, state.spec, { json: state.specJsonPath, md: state.specMdPath });
		if (state.pendingApply)
			ctx.ui.notify(`⚠ spec v${state.pendingApply.specVersion} still has staged changes awaiting a commit in main — commit or discard them before starting new work (otherwise spec v${state.spec.version}'s apply will be refused by the guard)`, "warning");
		learn(ctx, `signed spec v${state.spec.version}`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(`🔏 Spec v${state.spec.version} signed — implementation gate open.`, "info");
		return true;
	};

	const commitSpec = async (
		ctx: ExtensionContext,
		fields: { title?: string; intent?: string; crossCheck?: string[]; outcomes?: string; approach?: string[]; scope?: string[]; constraints?: string[]; criteria?: Criterion[]; specDebt?: string[] },
		source: "set" | "compile",
		opts?: { sign?: "ask" | "auto"; provenance?: string; baselineOverride?: string },
	): Promise<{ version: number; signed: boolean; mdPath: string; changes?: string[]; lint?: string[]; approvedHow?: string; rejection?: string }> => {
		const version = (state.spec?.version ?? 0) + 1;
		let lintNotes: string[] = [];
		if (fields.criteria?.length) {
			const lint = lintSpecChecks(ctx.cwd, fields.criteria);
			if (lint.broken.length) {
				const existing = fields.specDebt ?? [];
				const covered = (id: string): boolean => existing.some((d) => d.startsWith("quality-gate:") && d.includes(id));
				lintNotes = lint.notes.filter((_, i) => !covered(lint.broken[i]));
				fields = { ...fields, specDebt: [...existing, ...lintNotes] };
			}
		}
		let prevSpec: Spec | undefined = state.spec;
		if (!prevSpec) {
			try {
				const latestJson = join(zenseDir(ctx.cwd), "spec.json");
				if (existsSync(latestJson)) {
					const p = JSON.parse(readFileSync(latestJson, "utf8")) as Spec;
					if (p && typeof p.version === "number") prevSpec = p;
				}
			} catch {
			}
		}
		state.spec = {
			version,
			title: fields.title ?? "untitled",
			intent: fields.intent ?? "",
			...(fields.crossCheck?.length ? { crossCheck: fields.crossCheck } : {}),
			...(fields.outcomes ? { outcomes: fields.outcomes } : {}),
			approach: fields.approach ?? [],
			scope: fields.scope ?? [],
			constraints: fields.constraints ?? [],
			criteria: fields.criteria ?? [],
			specDebt: fields.specDebt ?? [],
			approved: false,
		};
		if (prevSpec && version >= 2) {
			const changes = buildSpecChanges(prevSpec, state.spec);
			state.spec.changesFrom = changes;
			if (changes.length === 1 && changes[0].startsWith("⚠️"))
				learn(ctx, `spec v${version} re-spec identical to v${version - 1} (no changes)`);
		}
		state.specSource = source;
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
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
		state.specMdPath = mdPath;
		state.specJsonPath = jsonPath;
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

	const changesText = (r: { version: number; changes?: string[] }): string =>
		r.changes?.length
			? `\n\nChanges in v${r.version} (vs v${r.version - 1}):\n${r.changes.map((x) => `- ${x}`).join("\n")}`
			: "";

	const acceptPending = (ctx: ExtensionContext, commitIfStaged: boolean, notifyViaBulletin = false): { ok: boolean; text: string; specVersion?: number } => {
		if (!state.pendingApply)
			return { ok: false, text: "no pending apply to accept (already accepted/committed, or never applied)" };
		const v = state.pendingApply.specVersion;
		const specTitle = state.spec?.title ?? "";
		const r = acceptPendingApply(ctx.cwd, { evalTree: state.lastEval?.head, preApplyHead: state.pendingApply.preApplyHead, commitIfStaged });
		if (!r.ok) return { ok: false, text: `⚠️ accept failed: ${r.msg}` };
		state.pendingApply = undefined;
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

	return { approveCurrentSpec, commitSpec, changesText, acceptPending };
};
