import { Key, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { panelize } from "./models.ts";
import { roleTag } from "./agent-panel.ts";
import { GOAL_PAGE_CLOSE, GOAL_PAGE_KEYS, goalPageBody, goalPageLines, goalPageRowOf, goalPageSummary, goalPageTitle, type GoalPageGoal, type GoalPageLine } from "./goal-page.ts";
import { REPORT_PAGE_CLOSE, REPORT_PAGE_KEYS, reportPageLines, reportPageSummary, reportPageTitle, type HudReport } from "./report-page.ts";
import { SCROLL_CLOSE, createScrollPage, scrollCloses, scrollProgress, scrollRange } from "./scroll-page.ts";
import { liveReport, readReportFile, reportMetaFromFile } from "./report-file.ts";
import { goalDriverDone } from "./goal-driver.ts";
import { createLogReader, orderedSessionRuns, sessionBody, sessionKeyLine, sessionNoteLine, sessionSummaryLine, sessionTabs, sessionTitle, sessionToolCount, startSessionIndex, stepSessionIndex } from "./agent-session.ts";
import { type HarnessContext, type OpenAgentsViewer } from "./kit.ts";
import { stateLabel, shortHome } from "./project-dir.ts";
import { type SubagentRun } from "./types.ts";

export const createViewers = (ctx: HarnessContext) => {
	const state = ctx.state;
	const finisherCustom = ctx.finisherCustom;
	const OVERLAY_XL = ctx.OVERLAY_XL;
	const persist = ctx.persist;
	const pi = ctx.pi;

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${roleTag(r.role).toLowerCase()} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const sessionSummary = (runs: SubagentRun[], cwd: string): string =>
		runs
			.map((r, i) => `${i + 1}/${runs.length} ${runLabel(r)}${r.slotId ? ` ${r.slotId}` : ""}${r.model ? ` ${r.model}` : ""}${(r.steers ?? []).length ? ` · steered ${(r.steers ?? []).length}×` : ""}\n  task: ${sessionSummaryLine(r)}`)
			.join("\n");

	const openAgentSession = (ctx: ExtensionContext, at?: SubagentRun): Promise<null> => {
		const runs = orderedSessionRuns(state.subagentRuns);
		if (!runs.length) {
			ctx.ui.notify("no sub-agent has run in this session yet — start one with code", "info");
			return Promise.resolve(null);
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify(sessionSummary(runs, ctx.cwd), "info");
			return Promise.resolve(null);
		}
		const wanted = at ? Math.max(0, runs.indexOf(at)) : startSessionIndex(state.subagentRuns);
		return finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const tick = setInterval(() => tui.requestRender(), 1_000);
			let index = wanted;
			let expanded = state.toolOutputExpanded === true;
			let cache: { key: string; wrapped: string[] } = { key: "", wrapped: [] };
			let tools: { key: string; count: number } = { key: "", count: 0 };
			const logs = createLogReader();
			const current = (): SubagentRun | undefined => runs[Math.min(index, runs.length - 1)];
			const frameKey = (run: SubagentRun, width: number): string =>
				`${run.role}:${run.at}:${run.prompt?.length ?? 0}:${(run.steers ?? []).length}:${width}:${expanded ? "x" : "c"}:${logs.logKeyOf(run)}`;
			const rememberTools = (run: SubagentRun, lines: string[]): string[] => {
				tools = { key: logs.logKeyOf(run), count: sessionToolCount(lines) };
				return lines;
			};
			const wrappedFor = (run: SubagentRun, width: number): string[] => {
				const key = frameKey(run, width);
				if (key !== cache.key) cache = { key, wrapped: sessionBody(run, rememberTools(run, logs(run)), width, { expanded }).flatMap((ln) => wrapTextWithAnsi(ln, width)) };
				return cache.wrapped;
			};
			const toolCount = (): number => {
				const run = current();
				if (!run) return 0;
				if (tools.key !== logs.logKeyOf(run)) rememberTools(run, logs(run));
				return tools.count;
			};
			const page = createScrollPage<{ run?: SubagentRun; index: number }, string>({
				requestRender: () => tui.requestRender(),
				termRows: () => tui.terminal.rows,
				border: () => new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
				head: () => ({ run: current(), index }),
				renderHead: (w, shown) => {
					const run = shown?.run;
					if (!run) return [...new Text(theme.fg("dim", "no sub-agent to show"), 1, 0).render(w)];
					return [
						...new Text(theme.fg("accent", theme.bold(sessionTitle(run, shown.index, runs.length, w))), 1, 0).render(w),
						...new Text(theme.fg("muted", sessionTabs(runs, shown.index, w)), 1, 0).render(w),
						...new Text(theme.fg("dim", `${run.logPath ? shortHome(run.logPath) : "(no log)"} • ${sessionNoteLine(run)}`), 1, 0).render(w),
					];
				},
				body: (w) => {
					const run = current();
					return run ? wrappedFor(run, w) : [];
				},
				bodyOf: (lines) => lines,
				keyLine: (w, view) => [
					...new Text(theme.fg("dim", scrollProgress(view)), 1, 0).render(w),
					...new Text(theme.fg("dim", sessionKeyLine(runs.length, toolCount(), expanded)), 1, 0).render(w),
				],
				onClose: (data) => {
					if (!scrollCloses(data, SCROLL_CLOSE)) return false;
					done(null);
					return true;
				},
				take: (data) => {
					if (data === "t") {
						expanded = !expanded;
						state.toolOutputExpanded = expanded;
						cache = { key: "", wrapped: [] };
						persist();
						return true;
					}
					if (runs.length > 1 && matchesKey(data, Key.right)) {
						index = stepSessionIndex(index, runs.length, 1);
						return true;
					}
					if (runs.length > 1 && matchesKey(data, Key.left)) {
						index = stepSessionIndex(index, runs.length, -1);
						return true;
					}
					const jump = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
					if (jump >= 0 && jump < runs.length) {
						index = jump;
						return true;
					}
					return false;
				},
				pageKey: () => index,
				startFollowing: true,
				footerRows: (w) => new Text(theme.fg("dim", sessionKeyLine(runs.length, toolCount(), expanded)), 1, 0).render(w).length,
				dispose: () => clearInterval(tick),
			});
			return {
				render: (w: number) => {
					logs.beginFrame();
					return panelize(theme, page.render(w), w);
				},
				invalidate: () => {
					cache = { key: "", wrapped: [] };
					logs.invalidate();
					page.invalidate();
				},
				handleInput: (data: string) => page.handleInput(data),
				handleMouse: (event: { type?: string; wheelDelta?: number }) => page.handleMouse(event),
				dispose: () => page.dispose(),
			};
		}, () => true);
	};

	const openGoalPage = (ctx: ExtensionContext): Promise<null> => {
		const goal = state.goalDriver;
		if (!goal) {
			ctx.ui.notify("no goal is open — confirm one with goal to get a lap plan", "info");
			return Promise.resolve(null);
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify([goalPageTitle(goal), goalPageSummary(goal), ...goalPageLines(goal).map((l) => `${l.mark} ${l.position}/${l.total} ${l.text}`)].join("\n"), "info");
			return Promise.resolve(null);
		}
		return finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const tick = setInterval(() => tui.requestRender(), 1_000);
			const page = createScrollPage<GoalPageGoal | undefined, GoalPageLine>({
				requestRender: () => tui.requestRender(),
				termRows: () => tui.terminal.rows,
				border: () => new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
				head: () => state.goalDriver,
				renderHead: (w, open) => [
					truncateToWidth(theme.fg("accent", theme.bold(goalPageTitle(open))), w, ""),
					truncateToWidth(theme.fg("muted", goalPageSummary(open)), w, ""),
					...wrapTextWithAnsi(open?.goal ?? "", Math.max(20, Math.floor(w) - 4)).map((ln) => `  ${ln}`),
				],
				body: () => goalPageLines(state.goalDriver),
				bodyOf: (lines, w) => goalPageBody(lines, w, 0, Number.MAX_SAFE_INTEGER).text,
				decorate: (rows, from, w) => {
					const lines = goalPageLines(state.goalDriver);
					const width = Math.max(20, Math.floor(w) - 4);
					const heads = new Map<number, string>(lines.map((line, i) => [goalPageRowOf(lines, width)[i], theme.fg(line.mark === "✓" ? "success" : line.mark === "▶" ? "accent" : "dim", `${line.mark} ${line.position}/${line.total}`)]));
					return rows.map((line, i) => {
						const head = heads.get(from + i);
						return head ? `  ${head}  ${line.slice(visibleWidth(head) + 4)}` : `  ${line}`;
					});
				},
				keyLine: (w, view) => [truncateToWidth(theme.fg("dim", `${GOAL_PAGE_KEYS}${scrollRange(view.total, view.rows, view)}`), w, "")],
				onClose: (data) => {
					if (!scrollCloses(data, GOAL_PAGE_CLOSE)) return false;
					done(null);
					return true;
				},
				startFollowing: false,
				dispose: () => clearInterval(tick),
			});
			return {
				render: (w: number) => panelize(theme, page.render(w), w),
				invalidate: () => page.invalidate(),
				handleInput: (data: string) => page.handleInput(data),
				handleMouse: (event: { type?: string; wheelDelta?: number }) => page.handleMouse(event),
				dispose: () => page.dispose(),
			};
		}, () => true);
	};

	const openReportPage = (ctx: ExtensionContext): Promise<null> => {
		const recorded = state.lastReport;
		const meta = recorded && liveReport(recorded) ? recorded : reportMetaFromFile(ctx.cwd);
		if (!meta) {
			ctx.ui.notify(recorded ? `the report file is gone: ${recorded.path}` : `no report yet — verify writes one to ${stateLabel(ctx.cwd, "report.md")} when a goal closes`, "info");
			return Promise.resolve(null);
		}
		const text = readReportFile(meta.path);
		if (!text) {
			ctx.ui.notify(`the report file is gone: ${meta.path}`, "info");
			return Promise.resolve(null);
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify([reportPageTitle(meta), reportPageSummary(meta), "", ...reportPageLines(text).slice(0, 80)].join("\n"), "info");
			return Promise.resolve(null);
		}
		return finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const tick = setInterval(() => tui.requestRender(), 1_000);
			let cache: { key: string; wrapped: string[] } = { key: "", wrapped: [] };
			const bodyAt = (width: number): string[] => {
				const current = readReportFile(meta.path) ?? text;
				const key = `${width}:${current.length}:${current.slice(0, 40)}`;
				if (key !== cache.key) cache = { key, wrapped: reportPageLines(current).flatMap((ln) => wrapTextWithAnsi(ln, width)) };
				return cache.wrapped;
			};
			const page = createScrollPage<HudReport, string>({
				requestRender: () => tui.requestRender(),
				termRows: () => tui.terminal.rows,
				border: () => new DynamicBorder((s: string) => theme.fg("borderAccent", s)),
				head: () => meta,
				renderHead: (w, report) => [
					truncateToWidth(theme.fg("accent", theme.bold(reportPageTitle(report ?? meta))), w, ""),
					truncateToWidth(theme.fg("muted", reportPageSummary(report ?? meta)), w, ""),
				],
				body: (w) => bodyAt(w),
				bodyOf: (lines) => lines,
				keyLine: (w, view) => [truncateToWidth(theme.fg("dim", `${REPORT_PAGE_KEYS}${scrollRange(view.total, view.rows, view)}`), w, "")],
				onClose: (data) => {
					if (!scrollCloses(data, REPORT_PAGE_CLOSE)) return false;
					done(null);
					return true;
				},
				startFollowing: true,
				dispose: () => clearInterval(tick),
			});
			return {
				render: (w: number) => panelize(theme, page.render(w), w),
				invalidate: () => {
					cache = { key: "", wrapped: [] };
					page.invalidate();
				},
				handleInput: (data: string) => page.handleInput(data),
				handleMouse: (event: { type?: string; wheelDelta?: number }) => page.handleMouse(event),
				dispose: () => page.dispose(),
			};
		}, () => true);
	};

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> => openAgentSession(ctx, run);

	const openAgentsViewer: OpenAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		await openAgentSession(ctx);
	};

	return { tailViewer, runLabel, openAgentsViewer, openAgentSession, openGoalPage, openReportPage };
};
