import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODE_HYGIENE_GUIDELINE } from "./src/code-hygiene.ts";
import { SWARM_ROUTING_GUIDELINE } from "./src/swarm.ts";
import { buildReconcileBulletin, freshState, resetCycleState, takeContextBulletin } from "./src/cycle.ts";
import { gitOk } from "./src/worktree.ts";
import { createEscGuard } from "./src/esc-guard.ts";
import { createStateBox } from "./src/state-box.ts";
import { finisherDir, type State } from "./src/types.ts";
import { type HarnessContext } from "./src/kit.ts";
import { createGui } from "./src/gui.ts";
import { createPanelWidget } from "./src/panel-widget.ts";
import { applyFullscreenDefault } from "./src/fullscreen.ts";
import { createViewers } from "./src/viewers.ts";
import { createGoalPicker } from "./src/goal-dialog.ts";
import { createSubagentLaunch } from "./src/subagent-launch.ts";
import { createCodeSwarm } from "./src/code-swarm.ts";
import { createHygieneHook } from "./src/hygiene-hook.ts";
import { buildFreshSummary, freshCompactionEntry, freshDirective, freshResetDecision, lastUserEntryId, readFreshContextConfig } from "./src/fresh-context.ts";
import { compactionHold, reportUnread } from "./src/compaction-guard.ts";
import { readHandoff } from "./src/handoff-stack.ts";
import { handoffStackFor } from "./src/handoff-gate.ts";
import { ladderFromConfig, registerLadderModel } from "./src/ladder-model.ts";
import { enforceDeadline, TIMEOUT_RULE, withTimeout, readToolTimeout, timeoutNote, TOOL_TIMEOUT_LABEL } from "./src/timeout.ts";
import { registerReadonlyGuard, registerVerdictTool } from "./src/verdict-tool.ts";
import { childRole } from "./src/verdict-file.ts";
import { registerTools } from "./src/tools.ts";
import { registerCommands } from "./src/commands.ts";
export * from "./src/commands.ts";
export * from "./src/panel-widget.ts";
export * from "./src/state-box.ts";

export * from "./src/types.ts";
export * from "./src/worktree.ts";
export * from "./src/pending-apply.ts";
export * from "./src/cycle.ts";
export * from "./src/subagent-config.ts";
export * from "./src/esc-guard.ts";
export * from "./src/subagent-log.ts";
export * from "./src/models.ts";
export * from "./src/swarm.ts";
export * from "./src/code-hygiene.ts";
export * from "./src/test-quality.ts";
export * from "./src/review-file.ts";
export * from "./src/goal-confirm.ts";
export * from "./src/goal-dialog.ts";
export * from "./src/agent-panel.ts";
export * from "./src/agent-session.ts";
export * from "./src/viewers.ts";
export * from "./src/hud.ts";
export * from "./src/swarm-code.ts";
export * from "./src/budget.ts";
export * from "./src/evidence.ts";
export * from "./src/verify-loop.ts";
export * from "./src/goal-driver.ts";
export * from "./src/goal-phase.ts";
export * from "./src/phase-tool.ts";
export * from "./src/race-state.ts";
export * from "./src/evidence-record.ts";
export * from "./src/verdict-file.ts";
export * from "./src/verdict-tool.ts";
export * from "./src/lap-journal.ts";
export * from "./src/goal-run.ts";
export * from "./src/handoff-stack.ts";
export * from "./src/handoff-classify.ts";
export * from "./src/fresh-context.ts";
export * from "./src/compaction-guard.ts";
export * from "./src/fullscreen.ts";
export * from "./src/handoff-model.ts";
export * from "./src/decisions.ts";
export * from "./src/subagent-rpc.ts";
export * from "./src/tool-log.ts";
export * from "./src/handoff-gate.ts";
export * from "./src/ladder-model.ts";
export * from "./src/timeout.ts";

const registerToolTimeoutHook = (pi: ExtensionAPI): void => {
	pi.on("tool_call", async (ev, ctx) => {
		const r = enforceDeadline(ev.toolName, ev.input, ctx.cwd);
		if (!r.blocked) return undefined;
		return { block: true, reason: r.reason ?? "the harness could not bound this command's deadline" };
	});
};

export default function (pi: ExtensionAPI) {
	if (process.env.PI_FINISHER_SUBAGENT === "1") {
		registerToolTimeoutHook(pi);
		registerReadonlyGuard(pi, childRole());
		registerVerdictTool(pi);
		return;
	}

	registerToolTimeoutHook(pi);

	const box = createStateBox(freshState());

	const persist = () => pi.appendEntry("finisher-state", box.get());

	const flag = (msg: string, ctx: ExtensionContext): void => {
		box.get().trajectoryFlags.push(msg);
	};

	const escalate = (kind: string, detail: string, ctx: ExtensionContext): void => {
		box.get().escalations.push({ kind, detail, at: Date.now() });
		if (ctx.hasUI) ctx.ui.notify(`🚨 finisher escalation (${kind}): ${detail}`, "warning");
	};

	const kit = {
		pi,
		get state() {
			return box.get();
		},
		persist,
		flag,
		escalate,
	} as unknown as HarnessContext;

	kit.escGuard = createEscGuard();
	kit.OVERLAY_LG = { width: "92%", minWidth: 60, maxHeight: "85%" };
	kit.OVERLAY_MD = { width: "80%", minWidth: 56, maxHeight: "80%" };
	kit.OVERLAY_XL = { width: "95%", minWidth: 60, maxHeight: "90%" };
	kit.REJECT_WITH_REASON = "__finisher_reject_reason__";

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
	const goalPicker = createGoalPicker(kit);
	Object.assign(kit, goalPicker);

	createHygieneHook(kit);
	registerTools(kit);
	registerCommands(kit);

	const ensureFullscreenDefault = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : undefined;
			const merged = applyFullscreenDefault(raw);
			if (!merged || !merged.changed) return;
			mkdirSync(dirname(settingsPath), { recursive: true });
			writeFileSync(settingsPath, merged.text);
			ctx.ui.notify(
				"🖥 finisher: fullscreen TUI mode is now the default in ~/.pi/agent/settings.json — takes effect on the next pi launch (this session: /settings → TUI mode; to opt out: change tuiMode in that file)",
				"info",
			);
		} catch {
		}
	};

	pi.on("session_start", async (_ev, ctx) => {
		ensureFullscreenDefault(ctx);
		try {
			const registered = registerLadderModel({ register: (m) => pi.registerVirtualModel(m as never), readLadder: () => ladderFromConfig(ctx.cwd) });
		} catch (err) {
		}
		kit.escGuard.reset();
		if (ctx.mode === "tui") {
			kit.escGuardUnsubscribe?.();
			kit.escGuardUnsubscribe = ctx.ui.onTerminalInput(kit.escGuard.handleInput);
		}
		for (const e of ctx.sessionManager.getEntries())
			if (e.type === "custom" && e.customType === "finisher-state")
				box.set({ ...freshState(), ...(e.data as State) });
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
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") box.get().humanAt = Date.now();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const held = compactionHold({ reason: event.reason, goal: box.get().goalDriver, humanAt: box.get().humanAt });
		if (!held.hold) return;
		if (ctx.hasUI && held.note) ctx.ui.notify(held.note, "info");
		return { cancel: true };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let sp = event.systemPrompt;
		sp += "\n\n" + CODE_HYGIENE_GUIDELINE + "\n\n" + SWARM_ROUTING_GUIDELINE + "\n\n" + TIMEOUT_RULE;
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
		const decision = freshResetDecision({
			enabled: cfg.enabled,
			hasWork: ev.context.contextEntries.length > 0,
			aborted: ev.outcome !== "completed",
			lastResetAt: box.get().freshResetAt,
			goal: box.get().goalDriver as { doneAt?: number } | undefined,
			consumedGoalAt: box.get().freshResetGoalAt,
			reportUnread: reportUnread(box.get().goalDriver, box.get().humanAt),
			now: Date.now(),
		});
		if (!decision.reset) return;
		const summary = buildFreshSummary(handoffStackFor(readHandoff(ctx.cwd)));
		box.get().freshResetAt = Date.now();
		box.get().freshResetGoalAt = decision.goalAt;
		persist();
		return { entries: [freshCompactionEntry(freshDirective(summary), lastUserEntryId(ev.context.contextEntries))] };
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

		persist();
	});
}
