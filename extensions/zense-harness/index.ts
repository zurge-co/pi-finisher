import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMENT_DISCIPLINE_GUIDELINE } from "./src/eval-review.ts";
import { CODE_HYGIENE_GUIDELINE } from "./src/code-hygiene.ts";
import { SWARM_ROUTING_GUIDELINE } from "./src/swarm.ts";
import { PENDING_MSG, PENDING_PATCH } from "./src/pending-apply.ts";
import { buildReconcileBulletin, freshState, resetCycleState, takeContextBulletin } from "./src/cycle.ts";
import { applyFullscreenDefault } from "./src/spec-changes.ts";
import { gitOk } from "./src/worktree.ts";
import { loadSpecFromDisk } from "./src/resume.ts";
import { createEscGuard } from "./src/esc-guard.ts";
import { createStateBox } from "./src/state-box.ts";
import { zenseDir, type State } from "./src/types.ts";
import { type HarnessContext } from "./src/kit.ts";
import { createGui } from "./src/gui.ts";
import { createPanelWidget } from "./src/panel-widget.ts";
import { createViewers } from "./src/viewers.ts";
import { createSubagentLaunch } from "./src/subagent-launch.ts";
import { createCodeSwarm } from "./src/code-swarm.ts";
import { createHygieneHook } from "./src/hygiene-hook.ts";
import { createSpecFlow } from "./src/spec-flow.ts";
import { buildFreshSummary, readFreshContextConfig, shouldReset, freshCompactionEntry } from "./src/fresh-context.ts";
import { readHandoff } from "./src/handoff-stack.ts";
import { ladderFromConfig, registerLadderModel } from "./src/ladder-model.ts";
import { registerTools } from "./src/tools.ts";
import { registerCommands } from "./src/commands.ts";

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
export * from "./src/subagent-log.ts";
export * from "./src/memory.ts";
export * from "./src/models.ts";
export * from "./src/swarm.ts";
export * from "./src/code-hygiene.ts";
export * from "./src/test-quality.ts";
export * from "./src/review-file.ts";
export * from "./src/goal-confirm.ts";
export * from "./src/agent-panel.ts";
export * from "./src/swarm-code.ts";
export * from "./src/verify-loop.ts";
export * from "./src/goal-driver.ts";
export * from "./src/goal-run.ts";
export * from "./src/ask.ts";
export * from "./src/handoff-stack.ts";
export * from "./src/handoff-classify.ts";
export * from "./src/fresh-context.ts";
export * from "./src/subagent-rpc.ts";
export * from "./src/ladder-model.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_ZENSE_SUBAGENT === "1") return;

	const box = createStateBox(freshState());

	const persist = () => pi.appendEntry("zense-state", box.get());

	const learn = (ctx: ExtensionContext, note: string): void => {
		mkdirSync(zenseDir(ctx.cwd), { recursive: true });
		appendFileSync(join(zenseDir(ctx.cwd), "memory.jsonl"), JSON.stringify({ at: Date.now(), phase: box.get().phase, note }) + "\n");
	};

	const flag = (msg: string, ctx: ExtensionContext): void => {
		box.get().trajectoryFlags.push(msg);
		learn(ctx, `flag: ${msg}`);
	};

	const escalate = (kind: string, detail: string, ctx: ExtensionContext): void => {
		box.get().escalations.push({ kind, detail, at: Date.now() });
		learn(ctx, `escalation[${kind}]: ${detail}`);
		if (ctx.hasUI) ctx.ui.notify(`🚨 zense escalation (${kind}): ${detail}`, "warning");
	};

	const kit = {
		pi,
		get state() {
			return box.get();
		},
		persist,
		learn,
		flag,
		escalate,
	} as unknown as HarnessContext;

	kit.escGuard = createEscGuard();
	kit.OVERLAY_LG = { width: "92%", minWidth: 60, maxHeight: "85%" };
	kit.OVERLAY_MD = { width: "80%", minWidth: 56, maxHeight: "80%" };
	kit.OVERLAY_XL = { width: "95%", minWidth: 60, maxHeight: "90%" };
	kit.REJECT_WITH_REASON = "__zense_reject_reason__";

	const gui = createGui(kit);
	Object.assign(kit, gui);
	const viewers = createViewers(kit);
	Object.assign(kit, viewers);
	const widget = createPanelWidget(kit);
	Object.assign(kit, widget);
	const subagents = createSubagentLaunch(kit);
	Object.assign(kit, subagents);
	const swarm = createCodeSwarm(kit);
	Object.assign(kit, swarm);
	const specFlow = createSpecFlow(kit);
	Object.assign(kit, specFlow);

	createHygieneHook(kit);
	registerTools(kit);
	registerCommands(kit);

	const readdirAdrs = (cwd: string): string[] => {
		const dir = join(zenseDir(cwd), "adr");
		if (!existsSync(dir)) return [];
		return readdirSync(dir).filter((f) => f.endsWith(".md"));
	};

	const ensureFullscreenDefault = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
			const merged = applyFullscreenDefault(raw);
			if (!merged || !merged.changed) return;
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, merged.text);
			learn(ctx, "fullscreen default: tuiMode=fullscreen (install default — takes effect on the next pi launch)");
			ctx.ui.notify(
				"🖥 zense: fullscreen TUI mode is now the default in ~/.pi/agent/settings.json — takes effect on the next pi launch (this session: /settings → TUI mode; to opt out: change tuiMode in that file)",
				"info",
			);
		} catch {
		}
	};

	pi.on("session_start", async (_ev, ctx) => {
		ensureFullscreenDefault(ctx);
		try {
			const registered = registerLadderModel({ register: (m) => pi.registerVirtualModel(m as never), readLadder: () => ladderFromConfig(ctx.cwd) });
			if (registered) learn(ctx, `virtual model registered: zense/auto → ${ladderFromConfig(ctx.cwd).join(" > ")}`);
		} catch (err) {
			learn(ctx, `virtual model registration skipped: ${err instanceof Error ? err.message : String(err)}`);
		}
		kit.escGuard.reset();
		if (ctx.mode === "tui") {
			kit.escGuardUnsubscribe?.();
			kit.escGuardUnsubscribe = ctx.ui.onTerminalInput(kit.escGuard.handleInput);
		}
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "zense-state")
				box.set({ ...freshState(), ...(e.data as State) });
		if (!box.get().spec && ctx.hasUI) {
			const disk = loadSpecFromDisk(ctx.cwd);
			if (disk)
				ctx.ui.notify(
					`📄 found spec v${disk.version}${disk.approved ? " (signed)" : ""} on disk: ${disk.title} — run /zense resume to continue it, or ignore to abandon`,
					"info",
				);
		}
		const pa0 = box.get().pendingApply;
		if (pa0) {
			const pa = pa0;
			if (gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
				learn(ctx, `pendingApply reconcile: spec v${pa.specVersion} — index is empty (committed/discarded outside the flow)`);
				box.get().pendingApply = undefined;
				rmSync(join(zenseDir(ctx.cwd), PENDING_PATCH), { force: true });
				rmSync(join(zenseDir(ctx.cwd), PENDING_MSG), { force: true });
				box.get().contextBulletin = buildReconcileBulletin(pa.specVersion);
				resetCycleState(box.get());
				persist();
			} else {
				ctx.ui.notify(
					`⏳ zense: changes from spec v${pa.specVersion} (${pa.paths.length} file(s)) are staged in main awaiting a commit — review, then git commit -F .zense/pending-apply.msg · after committing → /zense accept · unhappy → /zense discard (reverse patch)`,
					"warning",
				);
			}
		}
		kit.updateWidget(ctx);
	});

	pi.on("tool_call", async (ev, ctx) => {
		const target = (ev.input as { path?: string })?.path;
		if (target && box.get().spec?.scope?.length && !box.get().goalDriver) {
			const rel = relative(ctx.cwd, resolve(ctx.cwd, target));
			const inScope = (box.get().spec?.scope ?? []).some((g) => rel.startsWith(g.replace(/\*\*?$/, "")));
			if (!inScope) {
				box.get().trajectoryFlags.push(`out-of-scope write: ${rel}`);
				ctx.ui.notify(`⚠ trajectory: ${rel} outside spec.scope`, "warning");
			}
		}
		kit.applyRedirect(ev, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let sp = event.systemPrompt;
		if (box.get().phase === "implementation") sp += "\n\n" + COMMENT_DISCIPLINE_GUIDELINE;
		sp += "\n\n" + CODE_HYGIENE_GUIDELINE + "\n\n" + SWARM_ROUTING_GUIDELINE;
		const bulletin = takeContextBulletin(box.get());
		if (bulletin) {
			sp += "\n\n" + bulletin;
			persist();
		}
		if (sp === event.systemPrompt) return;
		return { systemPrompt: sp };
	});

	pi.on("turn_end", async (ev, ctx) => {
		box.get().turnsUsed++;
		const m = ev.message as { role?: string; usage?: { totalTokens?: number } } | undefined;
		box.get().tokensUsed += m?.role === "assistant" ? (m.usage?.totalTokens ?? 0) : 0;
		kit.updateWidget(ctx);
		persist();
	});

	pi.on("agent_before_settle", async (ev, ctx) => {
		const cfg = readFreshContextConfig(ctx.cwd);
		const hasWork = ev.context.contextEntries.length > 0;
		const alreadyReset = (box.get().freshResetAt ?? 0) > Date.now() - 2_000;
		if (!shouldReset({ enabled: cfg.enabled, alreadyReset, hasWork, aborted: ev.outcome !== "completed" })) return;
		const summary = buildFreshSummary(readHandoff(ctx.cwd));
		box.get().freshResetAt = Date.now();
		persist();
		learn(ctx, `fresh context: task finished — hard reset (retain-none), handoff head ${summary ? `${summary.split("\n").length - 2} item(s)` : "empty"}`);
		return { entries: [freshCompactionEntry(summary || "[zense fresh context] a task finished; this context was reset on purpose. Re-read the repo and state from disk instead of trusting memory.")] };
	});

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

		const wt0 = box.get().worktree;
		if (wt0 && !box.get().worktreeLeaveNotified) {
			box.get().worktreeLeaveNotified = true;
			ctx.ui.notify(`🌳 worktree left unmerged (not yet applied to main): ${wt0.dir}\nbranch ${wt0.branch} — will be applied as staged changes (no commit) automatically when eval passes`, "info");
			persist();
		}
		persist();
	});
}
