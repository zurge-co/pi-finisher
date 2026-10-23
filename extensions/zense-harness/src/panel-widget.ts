import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { fmtTok } from "./subagent-log.ts";
import { basename } from "node:path";
import { panelLines, panelTickMs, streamTail, type PanelRun } from "./agent-panel.ts";
import { buildWorktreeCommand, rewritePathForWorktree } from "./worktree.ts";
import { type ApplyRedirect, type Learn, type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createPanelWidget = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const persist = ctx.persist;
	const pi = ctx.pi;

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	let lastWidget: string | undefined;

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

	const applyRedirect = (ev: any, ctx: ExtensionContext) => {
		let wt = state.worktree;
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

	return { activeRun, updateWidget, rescheduleTicker, applyRedirect };
};
