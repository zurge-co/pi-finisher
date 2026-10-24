import { Key } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SURFACE_COMMANDS } from "./goal-run.ts";
import { availableModelChoices, ignoredModelKeys, modelsPath, readLadderSlots, writeLadderSlot } from "./models.ts";
import { ladderLabel } from "./ladder-model.ts";
import { readModelLadder } from "./swarm.ts";
import { type HarnessContext } from "./kit.ts";
import { journalPath, readJournal, summarizeGaps, summaryLines } from "./lap-journal.ts";

export const ladderRows = (cwd: string): { key: string; pattern?: string }[] => readLadderSlots(cwd);

export const ladderSummaryLine = (cwd: string): string => {
	const ladder = readModelLadder(cwd);
	return ladder.length ? `priority ladder: ${ladder.join(" > ")}` : "priority ladder: empty — sub-agents fall back to the main session model";
};

export const clearSlotLabel = (key: string): string => `🗑 clear ${key}`;

export const registerCommands = (ctx: HarnessContext) => {
	const pi = ctx.pi;
	const finisherPick = ctx.finisherPick;
	const openAgentsViewer = ctx.openAgentsViewer;

	const setSlot = async (ctx: ExtensionContext, key: string): Promise<void> => {
		const choices = availableModelChoices(ctx);
		const current = readLadderSlots(ctx.cwd).find((s) => s.key === key)?.pattern;
		const sel = await finisherPick(
			ctx,
			`▚ ${key} — which model does this priority run on?`,
			[
				...(current ? [{ value: "__clear__", label: clearSlotLabel(key), description: `currently ${current} — leave this rung empty` }] : []),
				{ value: "__custom__", label: "✏️ type a pattern yourself", description: "e.g. openai/gpt-4o-mini or sonnet:high" },
				...choices.map((c) => ({ value: c.pattern, label: c.label, description: c.description })),
			],
			choices.length ? `${choices.length} models from the catalogue · lower rungs only run when a higher one fails` : "catalogue empty — pick 'type a pattern yourself'",
		);
		if (!sel) return;
		if (sel === "__clear__") {
			writeLadderSlot(ctx.cwd, key, null);
			ctx.ui.notify(`✅ ${key} cleared — sub-agents keep this rung unused`, "info");
			return;
		}
		let pattern = sel;
		if (sel === "__custom__") {
			const typed = (await ctx.ui.input(`model pattern for ${key}:`, "provider/model-id"))?.trim();
			if (!typed) return ctx.ui.notify("cancelled — ladder unchanged", "info");
			pattern = typed;
		}
		writeLadderSlot(ctx.cwd, key, pattern);
		ctx.ui.notify(`✅ ${key}: ${pattern} — wrote ${relative(ctx.cwd, modelsPath(ctx.cwd))} (sub-agents pick it up on their next run)`, "info");
	};

	pi.registerCommand("finisher", {
		description: `finisher: ${SURFACE_COMMANDS.map((c) => `/finisher ${c}`).join(" | ")} — set the model priority ladder every sub-agent picks from`,
		getArgumentCompletions: (prefix) =>
			[...SURFACE_COMMANDS]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub] = args.trim().split(/\s+/);
			if (sub === "gaps") {
				const records = readJournal();
				const summary = summarizeGaps(records);
				const path = journalPath();
				ctx.ui.notify([`▚ extra-lap journal — ${path}`, ...summaryLines(summary), summary.lastAt ? `last recorded: ${new Date(summary.lastAt).toISOString()}` : "", "every replan is appended as one JSON line there: goal, round, lap n/n, the added fix laps, and each case verdict with its reason."].filter(Boolean).join("\n"), "info");
				return;
			}
			if (sub !== "models") return ctx.ui.notify("usage: /finisher models | /finisher gaps", "info");
			if (sub === "models") {
				const rows = ladderRows(ctx.cwd);
				const ladder = readModelLadder(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const ignored = ignoredModelKeys(ctx.cwd);
				const cfgPath = modelsPath(ctx.cwd);
				if (ctx.mode !== "tui") {
					const lines = [
						`▚ priority ladder — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .finisher/models.json — every sub-agent uses the main model)"}`,
						`main agent: ${mainModel}`,
						...rows.map((r, i) => `  ${r.key}: ${r.pattern ?? "— (unused)"}${i === 0 && r.pattern ? "  ← first pick" : ""}`),
						`effective order: ${ladder.length ? ladder.join(" > ") : "(none — main model)"}`,
						"a sub-agent runs the highest-priority rung that is set; the next rung runs only when that one fails.",
						"edit by creating .finisher/models.json, e.g. { \"priority1\": \"anthropic/claude-sonnet\", \"priority2\": \"openai/gpt-5\" } — or open the TUI and use /finisher models",
						...(ignored.length ? [`⚠ keys with no meaning here (ignored, delete when you like): ${ignored.join(", ")}`] : []),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				const key = await finisherPick(
					ctx,
					"▚ pick the priority rung to set",
					rows.map((r, i) => ({
						value: r.key,
						label: `${i + 1}. ${r.key}`,
						description: r.pattern ?? "(unused)",
					})),
					`${ladderSummaryLine(ctx.cwd)} · main agent: ${mainModel} · sub-agents auto-pick from the ladder`,
				);
				if (!key) return;
				await setSlot(ctx, key);
				const after = readModelLadder(ctx.cwd);
				ctx.ui.notify(`▚ ${ladderLabel(after)}${ignored.length ? `\n⚠ ignored keys: ${ignored.join(", ")}` : ""}`, "info");
			}
		},
	});

	pi.registerShortcut(Key.ctrl("_"), {
		description: "finisher: open a sub-agent's live session — ←/→ switches between the running agents",
		handler: (ctx) => openAgentsViewer(ctx),
	});
};
