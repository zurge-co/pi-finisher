import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freshState, resetCycleState } from "./cycle.ts";
import { commitWorkingTree, composeCommitMessage, headOf } from "./pending-apply.ts";
import { buildAcceptBulletin } from "./cycle.ts";
import { type AcceptPending, type AskRejectReason, type Persist, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { lintSpecChecks } from "./evidence.ts";
import { gitOk } from "./worktree.ts";
import { buildSpecChanges, decideSpecApproval, renderSpecMd, sameGoalLines, syncApprovedSpecFiles } from "./spec-changes.ts";
import { goalCases } from "./goal-confirm.ts";
import { zenseDir, type Criterion, type Spec, type State } from "./types.ts";

export const createSpecFlow = (ctx: HarnessContext) => {
	const state = ctx.state;
	const persist = ctx.persist;
	const askRejectReason = ctx.askRejectReason;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;

	const approveCurrentSpec = (ctx: ExtensionContext) => {
		if (!state.spec) return false;
		const cases = goalCases(state.spec);
		state.spec.approved = true;
		state.spec.approvedAt = Date.now();
		state.phase = "implementation";
		state.baselineHead = headOf(ctx.cwd);
		syncApprovedSpecFiles(ctx.cwd, state.spec, { json: state.specJsonPath, md: state.specMdPath });
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
			if (changes.length === 1 && changes[0].startsWith("⚠️")) state.spec.changesFrom = changes;
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
			} else {
				state.spec.approvedBy = `goals-unchanged:v${prevSpec?.version ?? "?"}`;
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
		persist();
		updateWidget(ctx);
		return { version, signed, mdPath, ...(approvedHow ? { approvedHow } : {}), ...(rejection ? { rejection } : {}), ...(state.spec.changesFrom?.length ? { changes: state.spec.changesFrom } : {}), ...(lintNotes.length ? { lint: lintNotes } : {}) };
	};

	const changesText = (r: { version: number; changes?: string[] }): string =>
		r.changes?.length
			? `\n\nChanges in v${r.version} (vs v${r.version - 1}):\n${r.changes.map((x) => `- ${x}`).join("\n")}`
			: "";

	const acceptPending = (ctx: ExtensionContext, commitIfStaged: boolean, notifyViaBulletin = false): { ok: boolean; text: string; specVersion?: number } => {
		const v = state.spec?.version ?? 1;
		const specTitle = state.spec?.title ?? "";
		const commit = commitIfStaged && state.spec ? commitWorkingTree(ctx.cwd, composeCommitMessage(state.spec)) : undefined;
		if (commit && !commit.ok) return { ok: false, text: `⚠️ commit failed: ${commit.msg}` };
		const headNow = (commit?.sha ?? headOf(ctx.cwd) ?? "").slice(0, 12);
		state.escalations.push({ kind: "accepted", detail: `cycle v${v} accepted at ${headNow}`, at: Date.now() });
		if (notifyViaBulletin) state.contextBulletin = buildAcceptBulletin(v, specTitle, 0);
		resetCycleState(state);
		persist();
		updateWidget(ctx);
		const done = commit?.sha ? `committed ${commit.sha}` : commit?.msg === "nothing to commit" ? "nothing to commit" : "left uncommitted — commit when you are happy";
		return { ok: true, specVersion: v, text: `✅ cycle v${v} accepted — ${done}\ncycle closed: the next piece of work starts with a new zense_spec (v1)` };
	};

	return { approveCurrentSpec, commitSpec, changesText, acceptPending };
};
