import { type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hudActive, hudRender, hudSignature, HUD_MAX_ROWS, type HudGoal, type HudInput, type HudTheme } from "./hud.ts";
import { panelTickMs } from "./agent-panel.ts";
import { type HarnessContext } from "./kit.ts";
import { type SubagentRun } from "./types.ts";

export const createPanelWidget = (ctx: HarnessContext) => {
	const state = ctx.state;
	const openAgentSession = ctx.openAgentSession;

	const activeRun = (): SubagentRun | undefined => {
		for (let i = state.subagentRuns.length - 1; i >= 0; i--) if (state.subagentRuns[i].status === "running") return state.subagentRuns[i];
		return undefined;
	};

	const goalOf = (): HudGoal | undefined => {
		const g = state.goalDriver;
		if (!g) return undefined;
		return {
			goal: g.goal,
			round: g.attempts?.rounds ?? 0,
			doneAt: g.doneAt,
			...(g.outcome ? { outcome: g.outcome } : {}),
		};
	};

	const hudInput = (): Omit<HudInput, "width"> => ({
		runs: state.subagentRuns,
		turns: state.turnsUsed,
		tokens: state.tokensUsed,
		goal: goalOf(),
		flags: state.trajectoryFlags.length,
		hygiene: state.hygieneViolations?.length ?? 0,
		escalations: state.escalations.length,
		maxRows: HUD_MAX_ROWS,
	});

	const widgetVisible = (): boolean => hudActive({ ...hudInput(), width: 1 });

	let lastCtx: ExtensionContext | undefined;
	let lastSignature: string | undefined;

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		const input = hudInput();
		const signature = hudSignature(input);
		if (signature === lastSignature) return;
		lastSignature = signature;
		ctx.ui.setWidget(
			"finisher",
			(_tui, theme) => {
				let hits: (number | undefined)[] = [];
				const clicked = (event: TuiMouseEvent): { handled: boolean } | undefined => {
					if (event.type !== "click") return undefined;
					const index = hits[event.y];
					const run = index === undefined ? undefined : state.subagentRuns[index];
					if (!run || !lastCtx) return undefined;
					void openAgentSession(lastCtx, run);
					return { handled: true };
				};
				return {
					render: (width: number) => {
						const painted = hudRender({ ...hudInput(), width }, theme as unknown as HudTheme);
						hits = painted.hits;
						return painted.lines;
					},
					invalidate: () => {},
					handleMouse: clicked,
				};
			},
			{ placement: "belowEditor" },
		);
	};

	const ticker: { timer?: ReturnType<typeof setInterval>; ctx?: ExtensionContext; period?: number } = {};

	const rescheduleTicker = (ctx: ExtensionContext) => {
		ticker.ctx = ctx;
		const liveCount = state.subagentRuns.filter((r) => r.status === "running").length;
		const want = liveCount && widgetVisible() ? panelTickMs(liveCount) : undefined;
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

	return { activeRun, updateWidget, rescheduleTicker, widgetVisible };
};
