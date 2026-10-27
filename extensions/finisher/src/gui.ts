import { Container, Key, Markdown, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions, type SelectItem } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEscGuard } from "./esc-guard.ts";
import { CLARIFY_PICK_HINT } from "./clarify-dialog.ts";
import { panelize } from "./models.ts";
import { scrollKeyAction as scrollKeys } from "./scroll-page.ts";
import { type AskClarify, type AskRejectReason, type FinisherCustom, type FinisherPick, type ScrollKeyAction, type HarnessContext } from "./kit.ts";

export const createGui = (ctx: HarnessContext) => {
	const pi = ctx.pi;

	const escGuard = createEscGuard();
	let escGuardUnsubscribe: (() => void) | undefined;

	const finisherCustom = <T>(
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

	const scrollKeyAction = scrollKeys;

	const REJECT_WITH_REASON = "__finisher_reject_reason__";

	const askRejectReason = async (ctx: ExtensionContext, what: string): Promise<string | undefined> => {
		try {
			const reason = await ctx.ui.input(`✏️ ${what} — why not? (optional: type the correction so the agent fixes the right thing)`, "(Esc / empty = close without a reason)");
			return reason?.trim() || undefined;
		} catch {
			return undefined;
		}
	};

	type SpecSignResult = { picked: string | null; reason?: string };

	const finisherPick = (ctx: ExtensionContext, title: string, items: SelectItem[], hint = ""): Promise<string | null> => {
		let filter = "";
		return finisherCustom<string | null>(ctx, OVERLAY_MD, (tui, theme, _kb, done) => {
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

	const askClarifyQuestion: AskClarify = (ctx, q) => {
		const choices = (q.choices ?? []).map((choice) => String(choice ?? "").trim()).filter(Boolean);
		if (!choices.length || typeof ctx.ui?.custom !== "function") return Promise.resolve(undefined);
		const items = choices.map((choice) => ({ value: choice, label: choice }));
		return finisherPick(ctx, q.question, items, CLARIFY_PICK_HINT).then(
			(picked) => picked ?? undefined,
			() => undefined,
		);
	};

	return { escGuard, escGuardUnsubscribe, finisherCustom, OVERLAY_LG, OVERLAY_MD, OVERLAY_XL, scrollKeyAction, REJECT_WITH_REASON, askRejectReason, askClarifyQuestion, finisherPick };
};
