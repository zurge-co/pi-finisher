import { Key } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDiscardBulletin, resetCycleState } from "./cycle.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { SUBAGENT_ROLES, orphanRoleKeys, subagentStripFlagsAsync, subagentTimeout } from "./subagent-config.ts";
import { resolveModelPattern } from "./models.ts";
import { discardPendingApply } from "./pending-apply.ts";
import { subagentExtIncludes, writeSubagentExtIncludes, listInstalledExtensions, zenseGlobalConfigDir, extDisplayLabel } from "./subagent-config.ts";
import { discoverResumeState, loadSpecFromDisk } from "./resume.ts";
import { gitOk } from "./worktree.ts";
import { acceptPendingApply, isGitRepo, uncommittedChanges } from "./pending-apply.ts";
import { surfaceLine } from "./goal-run.ts";
import { freshStatusLine, readFreshContextConfig, writeFreshContextConfig } from "./fresh-context.ts";
import { readHandoff, writeHandoff } from "./handoff-stack.ts";
import { memorySummaryLines, aggregateMemory } from "./memory.ts";
import { availableModelChoices, readModelsConfig, writeModelsConfig } from "./models.ts";
import { type AcceptPending, type Escalate, type ExtConfigDialog, type Flag, type LaunchSubagent, type Learn, type OpenAgentsViewer, type Persist, type UpdateWidget, type ZensePick, type HarnessContext } from "./kit.ts";
import { zenseDir, type State } from "./types.ts";

export const registerCommands = (ctx: HarnessContext) => {
	const state = ctx.state;
	const learn = ctx.learn;
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;
	const launchSubagent = ctx.launchSubagent;
	const acceptPending = ctx.acceptPending;
	const escalate = ctx.escalate;
	const flag = ctx.flag;
	const zensePick = ctx.zensePick;
	const extConfigDialog = ctx.extConfigDialog;
	const openAgentsViewer = ctx.openAgentsViewer;

	pi.registerShortcut(Key.ctrl("_"), {
		description: "Zense: watch sub-agent runs live (live tail)",
		handler: (ctx) => openAgentsViewer(ctx),
	});

	const runExtConfig = async (ctx: ExtensionContext, role: string, action?: string, vals: string[] = []): Promise<void> => {
		const exts = (await listInstalledExtensions(ctx.cwd)).filter((e) => e.enabled);
		const cur = new Set(subagentExtIncludes(role, ctx.cwd));
		const apply = (includes: string[]) => {
			const { globalSeeded } = writeSubagentExtIncludes(ctx.cwd, role, includes);
			ctx.ui.notify(
				`✅ ${role}: will load ${includes.length}/${exts.length} extensions${includes.length ? "" : " (bare boot)"} — saved to local .zense/config.json${globalSeeded ? " (+ first-time global seed ~/.pi/agent/zense/config.json)" : ""} · takes effect on the next sub-agent run`,
				"info",
			);
		};
		if (ctx.mode === "tui" && !action) {
			const includes = await extConfigDialog(
				ctx,
				role,
				exts.map((e) => ({ path: e.path, label: `${extDisplayLabel(e)} · ${e.source}`, checked: cur.has(e.path) })),
			);
			if (includes === null) return ctx.ui.notify("cancelled — config unchanged", "info");
			apply(includes);
			return;
		}
		if (action === "all") apply(exts.map((e) => e.path));
		else if (action === "none" || action === "default") apply([]);
		else if (action === "on" || action === "off") {
			const target = vals.join(" ").trim();
			if (!target) return ctx.ui.notify(`missing target — /zense ext-config-show ${role} ${action} <index|path>`, "warning");
			const asNum = Number(target);
			const hit =
				Number.isInteger(asNum) && asNum >= 1 && asNum <= exts.length ? exts[asNum - 1].path : exts.find((e) => e.path.includes(target))?.path;
			if (!hit) return ctx.ui.notify(`extension "${target}" not found — see the list with /zense ext-config-show ${role} (no action)`, "warning");
			const next = new Set(cur);
			if (action === "on") next.add(hit);
			else next.delete(hit);
			apply([...next]);
		} else if (!action) {
			ctx.ui.notify(
				[
					`installed (enabled) extensions — ${role} loads ${cur.size}/${exts.length}:`,
					...exts.map((e, i) => `  ${i + 1}. ${cur.has(e.path) ? "[x]" : "[ ]"} ${e.path}`),
					`toggle: /zense ext-config ${role} on|off <index|path> · all = load everything · none = load nothing (default)`,
				].join("\n"),
				"info",
			);
		} else {
			return ctx.ui.notify(`unknown action: "${action}" — no action (TUI=checkbox / non-TUI=list) | all | none | on|off <index|path>`, "warning");
		}
	};

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
		let wtLine: string;
		if (disc.worktree) {
			state.worktree = disc.worktree;
			state.worktreeLeaveNotified = true;
			wtLine =
				`🌳 worktree rewired: ${disc.worktree.root}\n  branch ${disc.worktree.branch} — tool calls are redirected here; applied as staged changes on eval PASS` +
				(disc.worktreeExactVersion === false ? `\n  ⚠ branch predates spec v${disk.version} (reused worktree across a version bump) — verify it holds the right in-progress work` : "");
			learn(ctx, `resume: worktree rewired ${disc.worktree.branch} @ ${disc.worktree.root}`);
		} else {
			wtLine = "no matching worktree found — working directly in main";
		}
		let paLine = "";
		if (disc.pendingApply) {
			state.pendingApply = disc.pendingApply;
			learn(ctx, `resume: pendingApply restored (${disc.pendingApply.paths.length} staged path(s))`);
			paLine = `\n⏳ pending apply restored: ${disc.pendingApply.paths.length} file(s) staged awaiting a commit — git commit -F .zense/pending-apply.msg · /zense accept · or /zense discard`;
		}
		learn(ctx, `resumed spec v${disk.version} from disk (approved=${disk.approved})`);
		persist();
		updateWidget(ctx);
		ctx.ui.notify(
			`🔁 resumed spec v${disk.version}${disk.approved ? " (signed — implementation gate open)" : " (unsigned — gate closed; sign via /zense approve)"}: ${disk.title}\n${wtLine}${paLine}`,
			"info",
		);
	};

	pi.registerCommand("zense", {
		description: "Zense harness (zense = human signature/sign): status | resume | approve | accept | discard | agents | gate on|off | memory | models | ext-config-show",
		getArgumentCompletions: (prefix) =>
			["status", "resume", "accept", "discard", "agents", "memory", "models", "ext-config-show", "fresh-context", "surface"]
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
						(state.worktree ? `worktree: ${state.worktree.dir}\n  branch ${state.worktree.branch} (active — applied as staged changes on eval PASS, never auto-committed)\n` : `worktree: (none — working in main)\n`) +
						`turns=${state.turnsUsed} tokens=${state.tokensUsed}\n` +
						(state.pendingApply
							? `⏳ pending apply: spec v${state.pendingApply.specVersion} — ${state.pendingApply.paths.length} file(s) staged awaiting a commit (from ${state.pendingApply.branch})\n  commit: git commit -F .zense/pending-apply.msg · accept after committing: /zense accept · roll back: /zense discard (reverse patch)\n`
							: "") +
						`trajectory flags:\n${state.trajectoryFlags.join("\n") || "(none)"}\nescalations:\n${state.escalations.map((e) => `${e.kind}: ${e.detail}`).join("\n") || "(none)"}`,
					"info",
				);
			} else if (sub === "resume") {
				resumeZense(ctx);
			} else if (sub === "discard") {
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to discard (the change was already committed, or never applied)", "info");
				const dr = discardPendingApply(ctx.cwd);
				if (!dr.ok) {
					escalate("need-decision", `discard: ${dr.msg}`, ctx);
					return ctx.ui.notify(`⚠ discard failed: ${dr.msg}`, "warning");
				}
				const v = state.pendingApply.specVersion;
				state.pendingApply = undefined;
				learn(ctx, `spec v${v} discarded after review (reverse-applied)`);
				state.contextBulletin = buildDiscardBulletin(v);
				resetCycleState(state);
				persist();
				updateWidget(ctx);
				ctx.ui.notify(`✅ ${dr.msg} — spec v${v} has been rolled back out of main`, "info");
			} else if (sub === "accept") {
				if (!state.pendingApply) return ctx.ui.notify("no pending apply to accept (already committed/accepted, or never applied)", "info");
				let commitIfStaged = rest[0] === "commit";
				if (!commitIfStaged && !gitOk(["diff", "--cached", "--quiet"], ctx.cwd).ok) {
					const ok =
						ctx.mode === "tui" &&
						(await ctx.ui.confirm(
							`✅ accepting spec v${state.pendingApply.specVersion} — but staged changes are still pending (not yet committed)`,
							"have the harness commit them with .zense/pending-apply.msg, then accept? (hooks run normally)\nchoosing No cancels: commit yourself, then /zense accept again",
						));
					if (!ok)
						return ctx.ui.notify(
							"not committed yet — commit yourself with `git commit -F .zense/pending-apply.msg`, then /zense accept; or let the harness do it: /zense accept commit",
							"info",
						);
					commitIfStaged = true;
				}
				const r = acceptPending(ctx, commitIfStaged, true);
				ctx.ui.notify(r.text, r.ok ? "info" : "warning");
			} else if (sub === "fresh-context") {
				const action = (rest[0] ?? "status").trim().toLowerCase();
				if (action === "on" || action === "off") {
					const enabled = action === "on";
					const ok = writeFreshContextConfig(ctx.cwd, enabled);
					if (!ok) return ctx.ui.notify("could not write .zense/config.json", "warning");
					learn(ctx, `fresh context: ${enabled ? "ON" : "OFF"} (via /zense fresh-context ${action})`);
					return ctx.ui.notify(`🧠 fresh context ${enabled ? "ON — each finished task resets the context, keeping only the handoff stack" : "OFF — context keeps accumulating across tasks"}`, "info");
				}
				if (action === "clear") {
					writeHandoff(ctx.cwd, []);
					learn(ctx, "handoff stack cleared by the human");
					return ctx.ui.notify("🧹 handoff stack cleared — the next fresh context carries nothing", "info");
				}
				if (action === "status") return ctx.ui.notify(freshStatusLine(readFreshContextConfig(ctx.cwd), readHandoff(ctx.cwd)), "info");
				return ctx.ui.notify("usage: /zense fresh-context [on|off|status|clear]", "info");
		} else if (sub === "agents") {
				await openAgentsViewer(ctx);
			} else if (sub === "memory") {
				if (rest[0] === "json") {
					const f = join(zenseDir(ctx.cwd), "memory.jsonl");
					ctx.ui.notify(existsSync(f) ? readFileSync(f, "utf8").slice(-2000) : "(empty)", "info");
				} else {
					const lines = memorySummaryLines(ctx.cwd);
					ctx.ui.notify(
						lines.length ? [...lines, "(raw: /zense memory json)"].join("\n") : "📚 memory is empty — lessons accumulate on every escalation/flag/eval/sub-agent failure",
						"info",
					);
				}
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
			} else if (sub === "ext-config-show" || sub === "ext-config") {
				const roles: readonly string[] = [...SUBAGENT_ROLES];
				const [role, action, ...vals] = rest;
				if (!role || !roles.includes(role)) {
					ctx.ui.notify(
						[
							"🧩 sub-agent extension loading (per role) — default: bare boot, no extensions · tick to opt specific ones back in",
							...roles.map((r) => {
								const inc = subagentExtIncludes(r, ctx.cwd);
								return `  ${r}: ${inc.length ? `loads ${inc.length}` : "bare boot (no extensions)"}`;
							}),
							`persist: local ${join(zenseDir(ctx.cwd), "config.json")} · global ${join(zenseGlobalConfigDir(), "config.json")} (first-time seed + fallback)`,
							"configure: /zense:ext-config:swarm | :verifier (TUI = instant checkboxes) or /zense ext-config-show <role> all|none|on|off <index|path>",
						].join("\n"),
						"info",
					);
					return;
				}
				await runExtConfig(ctx, role, action, vals);
			} else {
				ctx.ui.notify("usage: /zense status|resume|approve|accept [commit]|discard|agents|gate on|off|memory|models|ext-config-show|fresh-context on|off|status|clear", "info");
			}
		},
	});

	for (const role of SUBAGENT_ROLES)
		pi.registerCommand(`zense:ext-config:${role}`, {
			description: `which extensions sub-agent "${role}" loads (default: bare boot — opt in by ticking; saved to local .zense + first-time global seed)`,
			handler: async (_args, ctx) => runExtConfig(ctx as ExtensionContext, role),
		});
};
