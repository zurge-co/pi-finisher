import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtTok } from "./subagent-log.ts";
import { panelLines, panelTickMs, streamTail, type PanelRun } from "./agent-panel.ts";
import { type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createPanelWidget = (ctx: HarnessContext) => {
	const state = ctx.state;
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
			(state.trajectoryFlags.length ? ` · ⚠ ${state.trajectoryFlags.length} traj-flags` : "") +
			(state.hygieneViolations?.length ? ` · 🧹 ${state.hygieneViolations.length} code-rule` : "") +
			(state.escalations.length ? ` · 🚨 ${state.escalations.length}` : "");
		const text = [line, ...live].join("\n");
		if (text === lastWidget) return;
		lastWidget = text;
		ctx.ui.setWidget("finisher", text.split("\n"));
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

	return { activeRun, updateWidget, rescheduleTicker };
};
