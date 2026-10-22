import { Container, Key, Markdown, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEscGuard } from "./esc-guard.ts";
import { panelize } from "./models.ts";
import { type AskClarify, type AskRejectReason, type ExtConfigDialog, type ScrollKeyAction, type ZenseCustom, type ZensePick, type HarnessContext } from "./kit.ts";
import { type ClarifyQuestion } from "./spec-draft.ts";

export const createGui = (ctx: HarnessContext) => {
	const pi = ctx.pi;

	const escGuard = createEscGuard();
	let escGuardUnsubscribe: (() => void) | undefined;

	const zenseCustom = <T>(
		ctx: ExtensionContext,
		options: unknown,
		factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any,
		canPeek?: () => boolean,
	): Promise<T> => {
		let overlayHidden: ((hidden: boolean) => void) | undefined;
		return ctx.ui.custom<T>((tui, theme, kb, done) => {
			let closed = false;
			const trackedDone = (v: T) => {
				if (closed) return;
				closed = true;
				handle.close();
				done(v);
			};
			const handle = escGuard.open(
				() => trackedDone(null as T),
				(hidden) => overlayHidden?.(hidden),
				canPeek,
			);
			try {
				return factory(tui, theme, kb, trackedDone);
			} catch (e) {
				trackedDone(null as T);
				throw e;
			}
		}, {
			...((options as Record<string, unknown>) ?? {}),
			onHandle: (h: any) => {
				overlayHidden = (hidden: boolean) => h.setHidden(hidden);
			},
		} as never);
	};

	const OVERLAY_LG = { overlay: true, overlayOptions: { width: "92%", minWidth: 60, maxHeight: "85%" } } as const;

	const OVERLAY_MD = { overlay: true, overlayOptions: { width: "80%", minWidth: 56, maxHeight: "80%" } } as const;

	const OVERLAY_XL = { overlay: true, overlayOptions: { width: "95%", minWidth: 60, maxHeight: "90%" } } as const;

	type ScrollAction = { dir: 1 | -1; page: boolean } | "top" | "bottom" | null;

	const scrollKeyAction = (data: string): ScrollAction => {
		if (matchesKey(data, Key.up)) return { dir: -1, page: false };
		if (matchesKey(data, Key.down)) return { dir: 1, page: false };
		if (matchesKey(data, Key.left)) return { dir: -1, page: true };
		if (matchesKey(data, Key.right)) return { dir: 1, page: true };
		if (data === "g") return "top";
		if (data === "G") return "bottom";
		return null;
	};

	const REJECT_WITH_REASON = "__zense_reject_reason__";

	const askRejectReason = async (ctx: ExtensionContext, what: string): Promise<string | undefined> => {
		try {
			const reason = await ctx.ui.input(`✏️ ${what} — why not? (optional: type the correction so the agent fixes the right thing)`, "(Esc / empty = close without a reason)");
			return reason?.trim() || undefined;
		} catch {
			return undefined;
		}
	};

	type SpecSignResult = { picked: string | null; reason?: string };

	const extConfigDialog = (ctx: ExtensionContext, role: string, items: { path: string; label: string; checked: boolean }[]): Promise<string[] | null> =>
		zenseCustom<string[] | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			let cursor = 0;
			const checked = items.map((i) => i.checked);
			const visRows = () => Math.max(6, Math.floor(tui.terminal.rows * 0.6));
			return {
				render: (w: number) => {
					const h = visRows();
					const start = Math.max(0, Math.min(cursor - 2, Math.max(0, items.length - h)));
					const out: string[] = [];
					out.push(...border.render(w));
					out.push(...new Text(theme.fg("accent", theme.bold(`🧩 sub-agent extensions — role "${role}" (default: bare boot · space = opt into loading)`)), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", "↑↓ move • space toggle • a = load all • n = load none • enter save • esc cancel"), 1, 0).render(w));
					for (let i = start; i < Math.min(items.length, start + h); i++) {
						const box = checked[i] ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
						const mark = i === cursor ? theme.fg("accent", "▸") : " ";
						const line = ` ${mark} ${box} ${items[i].label}`;
						out.push(i === cursor ? theme.bold(line) : line);
					}
					if (items.length > h) out.push(...new Text(theme.fg("dim", `— ${start + 1}-${Math.min(start + h, items.length)}/${items.length} —`), 1, 0).render(w));
					out.push(...new Text(theme.fg("dim", `${checked.filter(Boolean).length}/${items.length} extensions will load`), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
					else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
					else if (data === " ") checked[cursor] = !checked[cursor];
					else if (data === "a") checked.fill(true);
					else if (data === "n") checked.fill(false);
					else if (matchesKey(data, Key.enter)) {
						done(items.filter((_, i) => checked[i]).map((it) => it.path));
						return;
					} else if (matchesKey(data, Key.escape)) {
						done(null);
						return;
					}
					tui.requestRender();
				},
			};
		},
		() => false);

	const zensePick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint = ""): Promise<string | null> => {
		let filter = "";
		return zenseCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			return {
				render: (w: number) =>
					panelize(theme, [
						...border.render(w),
						...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(w),
						...new Text(theme.fg("dim", `filter: ${filter || "(type to filter)"}${hint ? ` • ${hint}` : ""}`), 1, 0).render(w),
						...selectList.render(w),
						...new Text(theme.fg("dim", `↑↓ select • Enter confirm • Esc cancel • type = filter${filter ? "" : " • space = read chat"}`), 1, 0).render(w),
						...border.render(w),
					], w),
				invalidate: () => {
					selectList.invalidate();
				},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						selectList.setFilter(filter);
					} else if (data.length === 1 && data >= " " && !matchesKey(data, Key.enter)) {
						filter += data;
						selectList.setFilter(filter);
					} else {
						selectList.handleInput(data);
					}
					tui.requestRender();
				},
			};
		}, () => filter === "");
	};

	const askClarifyQuestion = async (ctx: ExtensionContext, q: ClarifyQuestion): Promise<string | undefined> => {
		if (!q.choices.length) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(a short answer is fine — Esc/empty = skip)");
		const FREE_TEXT = "__clarify_free_text__";
		const picked = await zensePick(ctx, `❓ requirements asks: ${q.question}`, [
			...q.choices.map((c) => ({ value: c, label: c })),
			{ value: FREE_TEXT, label: "Other (type your own)", description: "pick this, then type your answer" },
		]);
		if (picked === null) return undefined;
		if (picked === FREE_TEXT) return ctx.ui.input(`❓ requirements asks: ${q.question}`, "(type your answer — Esc/empty = skip)");
		return picked;
	};

	return { escGuard, escGuardUnsubscribe, zenseCustom, OVERLAY_LG, OVERLAY_MD, OVERLAY_XL, scrollKeyAction, REJECT_WITH_REASON, askRejectReason, extConfigDialog, zensePick, askClarifyQuestion };
};
