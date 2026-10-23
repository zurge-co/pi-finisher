import { Key } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDiscardBulletin, resetCycleState } from "./cycle.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { SUBAGENT_ROLES, orphanRoleKeys, subagentTimeout } from "./subagent-config.ts";
import { resolveModelPattern } from "./models.ts";
import { changePathsSince, discardSinceBaseline } from "./pending-apply.ts";
import { discoverResumeState, loadSpecFromDisk } from "./resume.ts";
import { gitOk } from "./worktree.ts";
import { isGitRepo, uncommittedChanges } from "./pending-apply.ts";
import { SURFACE_COMMANDS, surfaceLine } from "./goal-run.ts";
import { freshStatusLine, readFreshContextConfig, writeFreshContextConfig } from "./fresh-context.ts";
import { readHandoff, writeHandoff } from "./handoff-stack.ts";
import { availableModelChoices, readModelsConfig, writeModelsConfig } from "./models.ts";
import { type AcceptPending, type Escalate, type Flag, type LaunchSubagent, type OpenAgentsViewer, type Persist, type UpdateWidget, type ZensePick, type HarnessContext } from "./kit.ts";
import { zenseDir, type State } from "./types.ts";

export const registerCommands = (ctx: HarnessContext) => {
	const state = ctx.state;
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;
	const launchSubagent = ctx.launchSubagent;
	const acceptPending = ctx.acceptPending;
	const escalate = ctx.escalate;
	const flag = ctx.flag;
	const zensePick = ctx.zensePick;
	const openAgentsViewer = ctx.openAgentsViewer;

	pi.registerShortcut(Key.ctrl("_"), {
		description: "Zense: watch sub-agent runs live (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	const resumeZense = (ctx: ExtensionContext): void => {
		if (state.spec)
			return ctx.ui.notify(
				`nothing to resume — this session already owns spec v${state.spec.version} (${state.spec.approved ? "signed" : "unsigned"})`,
				"warning",
			);
		const disc = discoverResumeState(ctx.cwd);
		if (!disc)
			return ctx.ui.notify(
				"nothing to resume — no valid .zense/spec.json on disk (no spec was ever committed here, or the file is corrupt)",
				"info",
			);
		const disk = disc.spec;
		state.spec = disk;
		state.phase = disk.approved ? "implementation" : "requirements";
		state.specJsonPath = disc.specJsonPath;
		state.specMdPath = disc.specMdPath;
		persist();
		updateWidget(ctx);
		ctx.ui.notify(
			`🔁 resumed spec v${disk.version}${disk.approved ? " (signed — implementation open)" : " (unsigned — sign it with zense_spec)"}: ${disk.title}\nworking directly in the repo (no worktree)`,
			"info",
		);
	};

	pi.registerCommand("zense", {
		description: "Zense harness (zense = human signature/sign): status | resume | accept | discard | agents | models | fresh-context | surface",
		getArgumentCompletions: (prefix) =>
			[...SURFACE_COMMANDS]
				.filter((s) => s.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			if (sub === "surface") {
				ctx.ui.notify(surfaceLine(ctx.cwd), "info");
				return;
			} else if (sub === "status") {
				const disk = state.spec ? null : loadSpecFromDisk(ctx.cwd);
				ctx.ui.notify(
					`phase=${state.phase} spec=${state.spec ? `v${state.spec.version} approved=${state.spec.approved}` : "—"}\n` +
						(disk ? `📄 on-disk spec found: v${disk.version} ${disk.approved ? "(signed)" : "(unsigned)"} — /zense resume to continue it, or ignore to abandon\n` : "") +
						`turns=${state.turnsUsed} tokens=${state.tokensUsed}\n` +
						`changes this cycle: ${changePathsSince(ctx.cwd, state.baselineHead).length} path(s) since ${state.baselineHead?.slice(0, 12) ?? "(no baseline)"}\n` +
						`trajectory flags:\n${state.trajectoryFlags.join("\n") || "(none)"}\nescalations:\n${state.escalations.map((e) => `${e.kind}: ${e.detail}`).join("\n") || "(none)"}`,
					"info",
				);
			} else if (sub === "resume") {
				resumeZense(ctx);
			} else if (sub === "discard") {
				const baseline = state.baselineHead;
				const dr = discardSinceBaseline(ctx.cwd, baseline);
				if (!dr.ok) {
					escalate("need-decision", `discard: ${dr.msg}`, ctx);
					return ctx.ui.notify(`⚠ discard: ${dr.msg}`, "warning");
				}
				const v = state.spec?.version ?? 1;
				state.contextBulletin = buildDiscardBulletin(v);
				resetCycleState(state);
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`✅ ${dr.msg}`, "info");
			} else if (sub === "accept") {
				const r = acceptPending(ctx, rest[0] === "commit", true);
				ctx.ui.notify(r.text, r.ok ? "info" : "warning");
			} else if (sub === "fresh-context") {
				const action = (rest[0] ?? "status").trim().toLowerCase();
				if (action === "on" || action === "off") {
					const enabled = action === "on";
					const ok = writeFreshContextConfig(ctx.cwd, enabled);
					if (!ok) return ctx.ui.notify("could not write .zense/config.json", "warning");
					return ctx.ui.notify(`🧠 fresh context ${enabled ? "ON — each finished task resets the context, keeping only the handoff stack" : "OFF — context keeps accumulating across tasks"}`, "info");
				}
				if (action === "clear") {
					writeHandoff(ctx.cwd, []);
					return ctx.ui.notify("🧹 handoff stack cleared — the next fresh context carries nothing", "info");
				}
				if (action === "status") return ctx.ui.notify(freshStatusLine(readFreshContextConfig(ctx.cwd), readHandoff(ctx.cwd)), "info");
				return ctx.ui.notify("usage: /zense fresh-context [on|off|status|clear]", "info");
		} else if (sub === "agents") {
				await openAgentsViewer(ctx);
			} else if (sub === "models") {
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
			} else {
				ctx.ui.notify(`usage: /zense ${SURFACE_COMMANDS.join("|")} · accept [commit] · fresh-context on|off|status|clear`, "info");
			}
		},
	});

};
