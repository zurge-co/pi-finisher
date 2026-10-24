import { Key, Text, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { panelize } from "./models.ts";
import { GOAL_PAGE_KEYS, GOAL_PAGE_MIN_ROWS, goalPageLines, goalPageMaxOffset, goalPageSummary, goalPageTitle, goalPageWindow } from "./goal-page.ts";
import { REPORT_PAGE_KEYS, REPORT_PAGE_MIN_ROWS, reportPageLines, reportPageMaxOffset, reportPageSummary, reportPageTitle, reportPageWindow } from "./report-page.ts";
import { liveReport, readReportFile, reportMetaFromFile } from "./report-file.ts";
import { goalDriverDone } from "./goal-driver.ts";
import { orderedSessionRuns, sessionBody, sessionKeyLine, sessionNoteLine, sessionSummaryLine, sessionTabs, sessionTitle, sessionToolCount, startSessionIndex, stepSessionIndex, SESSION_MIN_BODY_ROWS } from "./agent-session.ts";
import { type HarnessContext, type OpenAgentsViewer } from "./kit.ts";
import { type SubagentRun } from "./types.ts";

export const createViewers = (ctx: HarnessContext) => {
	const state = ctx.state;
	const finisherCustom = ctx.finisherCustom;
	const OVERLAY_XL = ctx.OVERLAY_XL;
	const scrollKeyAction = ctx.scrollKeyAction;
	const persist = ctx.persist;
	const pi = ctx.pi;

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${r.role} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const logLines = (run: SubagentRun): string[] => {
		if (!run.logPath || !existsSync(run.logPath)) return ["(waiting for the first output…)"];
		try {
			return readFileSync(run.logPath, "utf8").split("\n");
		} catch {
			return ["(the log could not be read)"];
		}
	};

	const sessionSummary = (runs: SubagentRun[], cwd: string): string =>
		runs
			.map((r, i) => `${i + 1}/${runs.length} ${runLabel(r)}${r.slotId ? ` ${r.slotId}` : ""}${r.model ? ` ${r.model}` : ""}${(r.steers ?? []).length ? ` · steered ${(r.steers ?? []).length}×` : ""}\n  task: ${sessionSummaryLine(r)}`)
			.join("\n");

	const openAgentSession = (ctx: ExtensionContext, at?: SubagentRun): Promise<null> => {
		const runs = orderedSessionRuns(state.subagentRuns);
		if (!runs.length) {
			ctx.ui.notify("no sub-agent has run in this session yet — start one with finisher_swarm", "info");
			return Promise.resolve(null);
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify(sessionSummary(runs, ctx.cwd), "info");
			return Promise.resolve(null);
		}
		const wanted = at ? Math.max(0, runs.indexOf(at)) : startSessionIndex(state.subagentRuns);
		return finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("borderAccent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000);
			let index = wanted;
			let expanded = state.toolOutputExpanded === true;
			let cache: { key: string; wrapped: string[] } = { key: "", wrapped: [] };
			const offsets = new Map<number, number>();
			const follows = new Map<number, boolean>();
			const rows = () => Math.max(SESSION_MIN_BODY_ROWS, Math.floor(tui.terminal.rows * 0.9) - 8);
			const current = (): SubagentRun | undefined => runs[Math.min(index, runs.length - 1)];
			const maxOffset = (total: number) => Math.max(0, total - rows());
			const wrappedFor = (run: SubagentRun, width: number): string[] => {
				const st = run.logPath && existsSync(run.logPath) ? statSync(run.logPath) : null;
				const key = `${run.role}:${run.at}:${run.prompt?.length ?? 0}:${(run.steers ?? []).length}:${width}:${expanded ? "x" : "c"}:${st ? `${st.size}:${Math.round(st.mtimeMs)}` : "none"}`;
				if (key !== cache.key) cache = { key, wrapped: sessionBody(run, logLines(run), width, { expanded }).flatMap((ln) => wrapTextWithAnsi(ln, width)) };
				return cache.wrapped;
			};
			return {
				render: (w: number) => {
					const run = current();
					const out: string[] = [...border.render(w)];
					if (!run) {
						out.push(...new Text(theme.fg("dim", "no sub-agent to show"), 1, 0).render(w));
						out.push(...border.render(w));
						return panelize(theme, out, w);
					}
					const body = wrappedFor(run, Math.max(20, w - 4));
					const h = rows();
					const following = follows.get(index) ?? true;
					let offset = offsets.get(index) ?? (following ? maxOffset(body.length) : 0);
					if (following) offset = maxOffset(body.length);
					offset = Math.max(0, Math.min(offset, maxOffset(body.length)));
					offsets.set(index, offset);
					out.push(...new Text(theme.fg("accent", theme.bold(sessionTitle(run, index, runs.length, w))), 1, 0).render(w));
					out.push(...new Text(theme.fg("muted", sessionTabs(runs, index, w)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", `${run.logPath ? relative(ctx.cwd, run.logPath) : "(no log)"} • ${sessionNoteLine(run)}`), 1, 0).render(w));
					const slice = body.slice(offset, offset + h);
					for (const ln of slice) out.push(`  ${ln}`);
					for (let i = slice.length; i < h; i++) out.push("");
					const range = following
						? `▶ following the end • ${Math.min(body.length, offset + h)}/${body.length} lines`
						: `⏸ ${offset + 1}-${Math.min(offset + h, body.length)}/${body.length} — G resumes following`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", sessionKeyLine(runs.length, sessionToolCount(logLines(run)), expanded)), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {
					cache = { key: "", wrapped: [] };
				},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
						done(null);
						return;
					}
					if (data === "t") {
						expanded = !expanded;
						state.toolOutputExpanded = expanded;
						persist();
						tui.requestRender();
						return;
					}
					if (runs.length > 1 && matchesKey(data, Key.right)) {
						index = stepSessionIndex(index, runs.length, 1);
						tui.requestRender();
						return;
					}
					if (runs.length > 1 && matchesKey(data, Key.left)) {
						index = stepSessionIndex(index, runs.length, -1);
						tui.requestRender();
						return;
					}
					const jump = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
					if (jump >= 0 && jump < runs.length) {
						index = jump;
						tui.requestRender();
						return;
					}
					const run = current();
					const total = run ? wrappedFor(run, Math.max(20, tui.terminal.columns - 4)).length : 0;
					const act = scrollKeyAction(data);
					const page = rows();
					if (act === "top") {
						follows.set(index, false);
						offsets.set(index, 0);
					} else if (act === "bottom") {
						follows.set(index, true);
						offsets.set(index, maxOffset(total));
					} else if (act) {
						const step = act.page ? page : 1;
						const next = Math.max(0, Math.min(maxOffset(total), (offsets.get(index) ?? 0) + act.dir * step));
						offsets.set(index, next);
						follows.set(index, next >= maxOffset(total));
					} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
						const dir = matchesKey(data, Key.pageDown) ? 1 : -1;
						const next = Math.max(0, Math.min(maxOffset(total), (offsets.get(index) ?? 0) + dir * page));
						offsets.set(index, next);
						follows.set(index, next >= maxOffset(total));
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		}, () => true);
	};

	const openGoalPage = (ctx: ExtensionContext): Promise<null> => {
		const goal = state.goalDriver;
		if (!goal) {
			ctx.ui.notify("no goal is open — confirm one with finisher_goal to get a lap plan", "info");
			return Promise.resolve(null);
		}
		if (ctx.mode !== "tui") {
			ctx.ui.notify([goalPageTitle(goal), goalPageSummary(goal), ...goalPageLines(goal).map((l) => `${l.mark} ${l.position}/${l.total} ${l.text}`)].join("\n"), "info");
			return Promise.resolve(null);
		}
		return finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("borderAccent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000);
			let offset = 0;
			let following = true;
			const rows = () => Math.max(GOAL_PAGE_MIN_ROWS, Math.floor(tui.terminal.rows * 0.9) - 8);
			return {
				render: (w: number) => {
					const open = state.goalDriver;
					const lines = goalPageLines(open);
					const maxOffset = goalPageMaxOffset(lines.length, rows());
					if (following) offset = maxOffset;
					offset = Math.max(0, Math.min(offset, maxOffset));
					const out: string[] = [...border.render(w)];
					out.push(...new Text(theme.fg("accent", theme.bold(goalPageTitle(open))), 1, 0).render(w));
					out.push(...new Text(theme.fg("muted", goalPageSummary(open)), 1, 0).render(w));
					out.push(...new Text(theme.fg("text", open?.goal ?? ""), 1, 0).render(w).flatMap((ln) => wrapTextWithAnsi(ln, Math.max(20, w - 4))));
					const window = goalPageWindow(lines.length, rows(), offset);
					for (const line of lines.slice(window.from, window.to)) {
						const token = line.mark === "✓" ? "success" : line.mark === "▶" ? "accent" : "dim";
						const head = theme.fg(token, `${line.mark} ${line.position}/${line.total}`);
						const spent = line.spent ? theme.fg("dim", `  (${line.spent})`) : "";
						for (const [i, ln] of wrapTextWithAnsi(`${line.text}${spent}`, Math.max(20, w - 10)).entries()) out.push(`  ${i === 0 ? head : " ".repeat(visibleWidth(`${line.mark} ${line.position}/${line.total}`))}  ${ln}`);
					}
					const range = lines.length > rows() ? ` · ${window.from + 1}-${window.to}/${lines.length}${following ? " following" : ""}` : "";
					out.push(...new Text(theme.fg("dim", `${GOAL_PAGE_KEYS}${range}`), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
						done(null);
						return;
					}
					const total = goalPageLines(state.goalDriver).length;
					const act = scrollKeyAction(data);
					if (act === "top") {
						following = false;
						offset = 0;
					} else if (act === "bottom") {
						following = true;
						offset = goalPageMaxOffset(total, rows());
					} else if (act) {
						const step = act.page ? rows() : 1;
						offset = Math.max(0, Math.min(goalPageMaxOffset(total, rows()), offset + act.dir * step));
						following = offset >= goalPageMaxOffset(total, rows());
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		}, () => true);
	};

	const openReportPage = (ctx: ExtensionContext): Promise<null> => {
		const recorded = state.lastReport;
		const meta = recorded && liveReport(recorded) ? recorded : reportMetaFromFile(ctx.cwd);
		if (!meta) {
			ctx.ui.notify(recorded ? `the report file is gone: ${recorded.path}` : "no report yet — finisher_verify writes one to .finisher/report.md when a goal closes", "info");
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
			const border = new DynamicBorder((s: string) => theme.fg("borderAccent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000);
			const rows = () => Math.max(REPORT_PAGE_MIN_ROWS, Math.floor(tui.terminal.rows * 0.9) - 8);
			let offset = 0;
			let following = true;
			let cache: { key: string; wrapped: string[] } = { key: "", wrapped: [] };
			const bodyAt = (width: number): string[] => {
				const current = readReportFile(meta.path) ?? text;
				const key = `${width}:${current.length}:${current.slice(0, 40)}`;
				if (key !== cache.key) cache = { key, wrapped: reportPageLines(current).flatMap((ln) => wrapTextWithAnsi(ln, width)) };
				return cache.wrapped;
			};
			return {
				render: (w: number) => {
					const body = bodyAt(Math.max(20, w - 4));
					const h = rows();
					const maxOffset = reportPageMaxOffset(body.length, h);
					if (following) offset = maxOffset;
					offset = Math.max(0, Math.min(offset, maxOffset));
					const out: string[] = [...border.render(w)];
					out.push(...new Text(theme.fg("accent", theme.bold(reportPageTitle(meta))), 1, 0).render(w));
					out.push(...new Text(theme.fg("muted", reportPageSummary(meta)), 1, 0).render(w));
					const win = reportPageWindow(body.length, h, offset);
					for (const ln of body.slice(win.from, win.to)) out.push(`  ${ln}`);
					for (let i = win.to - win.from; i < h; i++) out.push("");
					const range = body.length > h ? ` · ${win.from + 1}-${win.to}/${body.length}${following ? " following" : ""}` : "";
					out.push(...new Text(theme.fg("dim", `${REPORT_PAGE_KEYS}${range}`), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {
					cache = { key: "", wrapped: [] };
				},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
						done(null);
						return;
					}
					const total = bodyAt(Math.max(20, tui.terminal.columns - 4)).length;
					const maxOffset = () => reportPageMaxOffset(total, rows());
					const act = scrollKeyAction(data);
					if (act === "top") {
						following = false;
						offset = 0;
					} else if (act === "bottom") {
						following = true;
						offset = maxOffset();
					} else if (act) {
						const next = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? rows() : 1)));
						offset = next;
						following = next >= maxOffset();
					} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
						const dir = matchesKey(data, Key.pageDown) ? 1 : -1;
						const next = Math.max(0, Math.min(maxOffset(), offset + dir * rows()));
						offset = next;
						following = next >= maxOffset();
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		}, () => true);
	};

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> => openAgentSession(ctx, run);

	const openAgentsViewer: OpenAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		await openAgentSession(ctx);
	};

	return { tailViewer, runLabel, openAgentsViewer, openAgentSession, openGoalPage, openReportPage };
};
