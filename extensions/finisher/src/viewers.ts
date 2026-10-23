import { Container, Key, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { panelize } from "./models.ts";
import { type OpenAgentsViewer, type ScrollKeyAction, type ZenseCustom, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createViewers = (ctx: HarnessContext) => {
	const state = ctx.state;
	const finisherCustom = ctx.finisherCustom;
	const OVERLAY_MD = ctx.OVERLAY_MD;
	const OVERLAY_XL = ctx.OVERLAY_XL;
	const scrollKeyAction = ctx.scrollKeyAction;
	const pi = ctx.pi;

	const tailViewer = (ctx: ExtensionContext, run: SubagentRun): Promise<null> =>
		finisherCustom<null>(ctx, OVERLAY_XL, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const tick = setInterval(() => tui.requestRender(), 1_000);
			let cacheKey = "";
			let wrapped: string[] = [];
			let offset = 0;
			let follow = true;
			const rows = () => Math.max(4, Math.floor(tui.terminal.rows * 0.9) - 6);
			const maxOffset = () => Math.max(0, wrapped.length - rows());
			const readWrapped = (wWrap: number): string[] => {
				const st = run.logPath && existsSync(run.logPath) ? statSync(run.logPath) : null;
				const key = `${wWrap}:${st ? `${st.size}:${Math.round(st.mtimeMs)}` : "none"}`;
				if (key !== cacheKey) {
					cacheKey = key;
					const raw = st ? readFileSync(run.logPath!, "utf8").split("\n") : ["(waiting for output…)"];
					wrapped = raw.flatMap((ln) => wrapTextWithAnsi(ln, wWrap));
				}
				return wrapped;
			};
			return {
				render: (w: number) => {
					const lines = readWrapped(Math.max(20, w - 4));
					const h = rows();
					if (follow) offset = maxOffset();
					offset = Math.max(0, Math.min(offset, maxOffset()));
					const status =
						run.status === "running"
							? `▶ running ${Math.round((Date.now() - (run.startedAt ?? run.at)) / 1000)}s`
							: run.ok
								? "✅ done"
								: "❌ failed";
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧪 sub-agent: ${run.role} — ${status}`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", run.logPath ? relative(ctx.cwd, run.logPath) : "(no log)"), 1, 0).render(w));
					const slice = lines.slice(offset, offset + h);
					for (const ln of slice) out.push("  " + ln);
					for (let i = slice.length; i < h; i++) out.push("");
					const range = follow
						? "▶ tail (following end of log)"
						: `⏸ lines ${offset + 1}-${Math.min(offset + h, lines.length)}/${lines.length} — press G to resume following`;
					out.push(...new Text(theme.fg("dim", range), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "auto refresh 1s • ↑↓ scroll • ←→ page • g/G top/bottom • space = read chat • Esc close (sub-agent keeps running)"), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(null); return; }
					const act = scrollKeyAction(data);
					if (act === "top") { offset = 0; follow = false; }
					else if (act === "bottom") { follow = true; offset = maxOffset(); }
					else if (act) {
						if (act.dir < 0) follow = false;
						offset = Math.max(0, Math.min(maxOffset(), offset + act.dir * (act.page ? rows() : 1)));
						if (offset >= maxOffset()) follow = true;
					}
					tui.requestRender();
				},
				dispose: () => clearInterval(tick),
			};
		});

	const runLabel = (r: SubagentRun) =>
		`${r.status === "running" ? "▶" : r.ok ? "✅" : "❌"} ${r.role} @ ${new Date(r.startedAt ?? r.at).toLocaleTimeString()}`;

	const openAgentsViewer = async (ctx: ExtensionContext): Promise<void> => {
		const runs = state.subagentRuns;
		if (!runs.length) {
			ctx.ui.notify("no sub-agent runs in this session yet", "info");
			return;
		}
		const recent = runs.slice(-15).map((r, i) => ({ run: r, idx: runs.length - Math.min(runs.length, 15) + i })).reverse();
		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				recent.map(({ run: r }) => `${runLabel(r)}  log: ${r.logPath ? relative(ctx.cwd, r.logPath) : "—"}`).join("\n"),
				"info",
			);
			return;
		}
		const picked = await finisherCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("🧪 Zense sub-agent runs (pick one for a live tail)")), 1, 0));
			const list = new SelectList(
				recent.map(({ run: r, idx }) => ({
					value: String(idx),
					label: runLabel(r),
					description: `${r.summary ? r.summary.slice(0, 80) : ""} ${r.logPath ? "| " + relative(ctx.cwd, r.logPath) : ""}`.trim(),
				})),
				Math.min(recent.length, 10),
				{
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter watch • Esc cancel • space = read chat (list hidden, comes back)"), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return {
				render: (w: number) => panelize(theme, container.render(w), w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}, () => true);
		const runIdx = picked == null ? -1 : Number(picked);
		if (runIdx < 0 || !state.subagentRuns[runIdx]) return;
		await tailViewer(ctx, state.subagentRuns[runIdx]);
	};

	return { tailViewer, runLabel, openAgentsViewer };
};
