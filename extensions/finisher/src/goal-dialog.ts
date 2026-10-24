import { Key, Text, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { panelize } from "./models.ts";
import { GOAL_CONFIRM_KEYS, GOAL_CONFIRM_TITLE, goalConfirmLines, type GoalAskOutcome, type GoalConfirmLineKind } from "./goal-confirm.ts";
import { type FinisherCustom, type HarnessContext } from "./kit.ts";
import { MAX_TIMER_MS, readConfirmTimeout } from "./goal-run.ts";

export interface GoalPicker {
	ctx: ExtensionContext;
	custom: FinisherCustom;
}

export const goalLineColor = (kind: GoalConfirmLineKind): string =>
	kind === "goal" ? "accent" : kind === "header" ? "muted" : kind === "case" ? "text" : "dim";

export const askGoalViaPicker = (ctx: ExtensionContext, goal: string, cases: string[]): Promise<GoalAskOutcome> => {
	const detail = goalConfirmLines(goal, cases)
		.filter((l) => l.kind !== "blank")
		.map((l) => l.text);
	return ctx.ui.confirm(GOAL_CONFIRM_TITLE, detail.join("\n")).then((ok) => (ok ? "confirmed" : "declined") as GoalAskOutcome);
};

const askGoalViaDialog = ({ ctx, custom }: GoalPicker, goal: string, cases: string[], timeoutMs = 0): Promise<GoalAskOutcome> =>
	custom<GoalAskOutcome | null>(
		ctx,
		{},
		(tui, theme, _kb, finish) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = (v: GoalAskOutcome | null): void => {
				if (timer) clearTimeout(timer);
				timer = undefined;
				finish(v);
			};
			if (timeoutMs > 0) timer = setTimeout(() => done("timeout"), Math.min(timeoutMs, MAX_TIMER_MS));
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const lines = goalConfirmLines(goal, cases);
			return {
				render: (w: number) => {
					const out: string[] = [...border.render(w)];
					out.push(...new Text(theme.fg("accent", theme.bold(GOAL_CONFIRM_TITLE)), 1, 0).render(w));
					for (const line of lines) {
						if (line.kind === "blank") {
							out.push("");
							continue;
						}
						const wrapped = wrapTextWithAnsi(line.text, Math.max(1, w - 4));
						for (const piece of wrapped) out.push(...new Text(theme.fg(goalLineColor(line.kind) as never, piece), 2, 0).render(w));
					}
					out.push(...new Text(theme.fg("dim", GOAL_CONFIRM_KEYS), 1, 0).render(w));
					out.push(...border.render(w));
					return panelize(theme, out, w);
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (matchesKey(data, Key.enter) || data === "y") done("confirmed");
					else if (matchesKey(data, Key.escape) || data === "n") done("declined");
					else tui.requestRender();
				},
			};
		},
		() => true,
	).then((outcome) => outcome ?? "declined");

export const askGoalConfirmation = (picker: GoalPicker, goal: string, cases: string[], timeoutMs?: number): Promise<GoalAskOutcome> => {
	if (!picker.ctx.hasUI) return Promise.resolve("unavailable");
	const ask = (): Promise<GoalAskOutcome> =>
		picker.ctx.mode !== "tui"
			? askGoalViaPicker(picker.ctx, goal, cases).catch(() => "declined" as GoalAskOutcome)
			: Promise.resolve(askGoalViaDialog(picker, goal, cases, timeoutMs)).catch(() => askGoalViaPicker(picker.ctx, goal, cases).catch(() => "declined" as GoalAskOutcome));
	const timed = (run: Promise<GoalAskOutcome>): Promise<GoalAskOutcome> => {
		if (!timeoutMs || timeoutMs <= 0) return run;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<GoalAskOutcome>((res) => {
			timer = setTimeout(() => res("timeout"), Math.min(timeoutMs, MAX_TIMER_MS));
		});
		return Promise.race([run, expired]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	};
	if (picker.ctx.mode === "tui") return timed(ask());
	return timed(ask());
};

export const createGoalPicker = (ctx: HarnessContext) => {
	const custom = ctx.finisherCustom;
	const askGoalConfirm: HarnessContext["askGoalConfirm"] = (toolCtx, goal, cases) =>
		askGoalConfirmation({ ctx: toolCtx, custom }, goal, cases, readConfirmTimeout(toolCtx.cwd));
	return { askGoalConfirm };
};
