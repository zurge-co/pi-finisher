import { Key } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { subagentLogPath } from "./subagent-log.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { SUBAGENT_ROLES, orphanRoleKeys, subagentTimeout } from "./subagent-config.ts";
import { resolveModelPattern } from "./models.ts";
import { SURFACE_COMMANDS } from "./goal-run.ts";
import { availableModelChoices, readModelsConfig, writeModelsConfig } from "./models.ts";
import { type AcceptPending, type Escalate, type Flag, type LaunchSubagent, type OpenAgentsViewer, type Persist, type UpdateWidget, type ZensePick, type HarnessContext } from "./kit.ts";
import { zenseDir, type State } from "./types.ts";

export const registerCommands = (ctx: HarnessContext) => {
	const state = ctx.state;
	const pi = ctx.pi;
	const launchSubagent = ctx.launchSubagent;
	const flag = ctx.flag;
	const zensePick = ctx.zensePick;
	const openAgentsViewer = ctx.openAgentsViewer;

	pi.registerShortcut(Key.ctrl("_"), {
		description: "Zense: watch sub-agent runs live (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	pi.registerCommand("zense", {
		description: `Zense: ${SURFACE_COMMANDS.map((c) => `/zense ${c}`).join(" | ")} — choose which model each sub-agent role runs on`,
		getArgumentCompletions: (prefix) =>
			[...SURFACE_COMMANDS]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub] = args.trim().split(/\s+/);
			if (sub !== "models") return ctx.ui.notify("usage: /zense models", "info");
			if (sub === "models") {
				const cfgPath = join(zenseDir(ctx.cwd), "models.json");
				const cfg = readModelsConfig(ctx.cwd);
				const mainModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(no active model)";
				const roles: readonly string[] = [...SUBAGENT_ROLES];
				const orphans = orphanRoleKeys(cfg, roles);
				if (ctx.mode !== "tui") {
					const lines = [
						`🧪 sub-agent models — config: ${existsSync(cfgPath) ? relative(ctx.cwd, cfgPath) : "(no .zense/models.json — every role uses the main model)"}`,
						`main agent: ${mainModel}`,
						...roles.map((r) => `  ${r}: ${cfg[r] ? cfg[r] + " (from config)" : mainModel + " (fallback)"}`),
						"edit by creating .zense/models.json, e.g. { \"verifier\": \"openai/gpt-4o-mini\" } — or open the TUI and use /zense models for an interactive picker",
						...(orphans.length ? [`⚠ keys with no role any more (ignored, delete when you like): ${orphans.join(", ")}`] : []),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				const role = await zensePick(
					ctx,
					"🧪 pick the sub-agent role to set a model for",
					roles.map((r) => ({
						value: r,
						label: r,
						description: cfg[r] ? `${cfg[r]} (from config)` : `${mainModel} (fallback)`,
					})),
					`main agent: ${mainModel}`,
				);
				if (!role) return;
				const choices = availableModelChoices(ctx);
				const sel = await zensePick(
					ctx,
					`🧪 pick a model for role "${role}"`,
					[
						{ value: "__default__", label: "↩️ use the main model (remove override)", description: `falls back to ${mainModel}` },
						{ value: "__custom__", label: "✏️ type a pattern yourself", description: "e.g. openai/gpt-4o-mini or sonnet:high" },
						...choices.map((c) => ({ value: c.pattern, label: c.label, description: c.description })),
					],
					choices.length ? `${choices.length} models from the catalogue` : "catalogue empty — pick 'type a pattern yourself'",
				);
				if (!sel) return;
				if (sel === "__default__") {
					writeModelsConfig(ctx.cwd, role, null);
					ctx.ui.notify(`✅ ${role}: override removed — the next sub-agent run falls back to the main model (${mainModel})`, "info");
					return;
				}
				let pattern = sel;
				if (sel === "__custom__") {
					const typed = (await ctx.ui.input(`model pattern for "${role}":`, "provider/model-id"))?.trim();
					if (!typed) return ctx.ui.notify("cancelled — model unchanged", "info");
					pattern = typed;
				}
				writeModelsConfig(ctx.cwd, role, pattern);
				ctx.ui.notify(`✅ ${role}: ${pattern} — wrote ${relative(ctx.cwd, cfgPath)} (takes effect on the next sub-agent run)`, "info");
			}
		},
	});

};
