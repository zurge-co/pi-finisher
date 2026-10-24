import { type TuiMouseEvent } from "@earendil-works/pi-tui";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalDriverDone } from "./goal-driver.ts";
import { hudActive, hudRender, hudSignature, HUD_MAX_ROWS, type HudGoal, type HudInput, type HudTheme } from "./hud.ts";
import { panelTickMs } from "./agent-panel.ts";
import { raceLoaderFrames, raceLoaderMessage, raceState } from "./race-state.ts";
import { type HarnessContext } from "./kit.ts";
import { type SubagentRun } from "./types.ts";

export const RACE_TICK_MS = 1_000;
const LANES = 5;

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
			...(g.confirmedAt ? { confirmedAt: g.confirmedAt } : {}),
			...(g.doneAt ? { doneAt: g.doneAt } : {}),
			...(g.outcome ? { outcome: g.outcome } : {}),
			...(g.phases ? { phases: g.phases } : {}),
			...(g.lap !== undefined ? { lap: g.lap } : {}),
			...(g.lapAt !== undefined ? { lapAt: g.lapAt } : {}),
			...(g.lapMs ? { lapMs: g.lapMs } : {}),
		};
	};

	const hudInput = (): Omit<HudInput, "width"> => ({
		runs: state.subagentRuns,
		goal: goalOf(),
		lanes: LANES,
		maxRows: HUD_MAX_ROWS,
	});

	const widgetVisible = (): boolean => hudActive({ ...hudInput(), width: 1 });

	let lastCtx: ExtensionContext | undefined;
	let lastSignature: string | undefined;
	let lastLoader: string | undefined;

	const colorize = (ctx: ExtensionContext) => (token: string, text: string): string => {
		try {
			return ctx.ui.theme.fg(token as never, text);
		} catch {
			return text;
		}
	};

	const syncLoader = (ctx: ExtensionContext): void => {
		const goal = goalOf();
		if (!goal?.goal) return;
		const race = raceState({ goal, runs: state.subagentRuns, lanes: LANES });
		const frames = raceLoaderFrames(race, colorize(ctx));
		const message = raceLoaderMessage(race);
		const key = `${frames.frames.join("|")}·${frames.intervalMs ?? 0}·${message}`;
		if (key === lastLoader) return;
		lastLoader = key;
		try {
			ctx.ui.setWorkingIndicator(frames);
			ctx.ui.setWorkingMessage(message);
		} catch {
		}
	};

	const updateWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		lastCtx = ctx;
		syncLoader(ctx);
		const signature = hudSignature(hudInput());
		if (signature !== lastSignature) {
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
		}
		rescheduleTicker(ctx);
	};

	const ticker: { timer?: ReturnType<typeof setInterval>; ctx?: ExtensionContext; period?: number } = {};

	const wantedPeriod = (): number | undefined => {
		const goal = state.goalDriver;
		if (goal && !goalDriverDone(goal)) return RACE_TICK_MS;
		const liveCount = state.subagentRuns.filter((r) => r.status === "running").length;
		return liveCount && widgetVisible() ? panelTickMs(liveCount) : undefined;
	};

	const rescheduleTicker = (ctx: ExtensionContext) => {
		ticker.ctx = ctx;
		const want = wantedPeriod();
		if (ticker.timer && want === ticker.period) return;
		if (ticker.timer) clearInterval(ticker.timer);
		ticker.timer = undefined;
		ticker.period = want;
		if (!want) return;
		ticker.timer = setInterval(() => {
			if (!ticker.ctx) return;
			lastSignature = undefined;
			updateWidget(ticker.ctx);
		}, want);
		ticker.timer.unref?.();
	};

	return { activeRun, updateWidget, rescheduleTicker, widgetVisible, syncLoader };
};
