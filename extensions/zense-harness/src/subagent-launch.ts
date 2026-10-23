import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_EXCLUDE_TOOLS, SUBAGENT_STRIP_FLAGS, subagentTimeout, buildRpcSubagentArgs, diagnoseProviderMissing, buildProviderMissingGuidance, modelMatchesPattern } from "./subagent-config.ts";
import { runRpcSubagent } from "./subagent-rpc.ts";
import { subagentLogPath } from "./subagent-log.ts";
import { appendHandoff, handoffInjection, readHandoff } from "./handoff-stack.ts";
import { decideKeep, describeDecision, classifyGateway, type ChatAsk } from "./handoff-classify.ts";
import { readHandoffModel, resolveHandoffPlan, handoffPlanNote, HANDOFF_ASK_PROMPT, parseHandoffVerdict } from "./handoff-model.ts";
import { addDecisions, parseDecisions, withDecisionRule } from "./decisions.ts";
import { streamTail } from "./agent-panel.ts";
import { resolveModelPattern } from "./models.ts";
import { type Persist, type RescheduleTicker, type UpdateWidget, type HarnessContext } from "./kit.ts";
import { type State, type SubagentRun } from "./types.ts";

export const createSubagentLaunch = (ctx: HarnessContext) => {
	const state = ctx.state;
	const handoffNoted = new Set<string>();
	const handoffOffNoted = new Set<string>();
	const persist = ctx.persist;
	const pi = ctx.pi;
	const updateWidget = ctx.updateWidget;
	const rescheduleTicker = ctx.rescheduleTicker;

	const launchSubagent = async (
		ctx: ExtensionContext,
		role: string,
		task: string,
		onChunk?: (chunk: string) => void,
		signal?: AbortSignal,
		modelOverride?: string,
	): Promise<{ ok: boolean; output: string; logPath: string }> => {
		const logPath = subagentLogPath(ctx.cwd, role);
		const mainModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		const modelPattern = modelOverride ?? resolveModelPattern(ctx.cwd, role, mainModel);
		const run: SubagentRun = { role, ok: false, summary: "", at: Date.now(), startedAt: Date.now(), logPath, status: "running" };
		state.subagentRuns.push(run);
		rescheduleTicker(ctx);
		updateWidget(ctx);
		const runChunk = (chunk: string) => {
			run.streamTail = streamTail(chunk);
			onChunk?.(chunk);
		};
		try {
			const subCwd = ctx.cwd;
			const stripFlags = SUBAGENT_STRIP_FLAGS[role] ?? [];
			const handoff = handoffInjection(readHandoff(ctx.cwd));
			const prompt = withDecisionRule(handoff ? `${task}\n\n${handoff}` : task);
			const r0 = await runRpcSubagent({
				role,
				cwd: subCwd,
				prompt,
				logPath,
				timeoutMs: subagentTimeout(role, subCwd, ctx.cwd),
				cliArgs: buildRpcSubagentArgs(SUBAGENT_EXCLUDE_TOOLS[role], role, stripFlags),
				model: modelPattern,
				onChunk: runChunk,
				signal,
			});
			const diagnosis = diagnoseProviderMissing(modelPattern, r0);
			const r = diagnosis && !r0.ok ? { ...r0, output: `${buildProviderMissingGuidance(role, diagnosis.patternProvider)}\n---\n${r0.output}` } : r0;
			run.ok = r.ok;
			run.summary = r.output.slice(0, 300);
			run.status = r.ok ? "done" : "failed";
			run.streamTail = undefined;
			if (r.usedModel) run.model = r.usedModel;
			if (modelPattern && r.usedModel && !modelMatchesPattern(r.usedModel, modelPattern)) {
				ctx.ui.notify(`⚠ sub-agent model mismatch: ${role} — config asked for "${modelPattern}" but actually ran "${r.usedModel}" (pi fallback? check .zense/models.json / /zense models)`, "warning");
			}
			if (r.ok && r.output.trim()) {
				const captured = parseDecisions(role, r.output);
				if (captured.length) {
					state.decisions = addDecisions(state.decisions ?? [], captured);
					run.decisions = captured.length;
				}
				const route = await resolveHandoffPlan({
					slot: readHandoffModel(ctx.cwd),
					isClassifier: (p, i) => isClassifierModel(ctx, p, i),
					availableClassifiers: () => (ctx.modelRegistry as unknown as { getAvailableOfType: (t: string) => Promise<readonly { provider: string; id: string }[]> }).getAvailableOfType("classifier"),
				});
				if (route.kind === "off") {
					if (!handoffOffNoted.has(role)) {
						handoffOffNoted.add(role);
						state.contextBulletin = `${state.contextBulletin ? `${state.contextBulletin}\n` : ""}${handoffPlanNote(route)}`;
					}
					return r;
				}
				const chatAsk: ChatAsk | undefined =
					route.kind === "chat"
						? async (from, text) => {
								const ask = await runRpcSubagent({
									role: "verifier",
									cwd: ctx.cwd,
									prompt: HANDOFF_ASK_PROMPT(from, text),
									logPath: subagentLogPath(ctx.cwd, `${role}-handoff`),
									timeoutMs: subagentTimeout("verifier", ctx.cwd),
									cliArgs: buildRpcSubagentArgs([], "verifier"),
									model: `${route.provider}/${route.id}`,
								});
								return ask.ok ? parseHandoffVerdict(ask.output) : undefined;
							}
						: undefined;
				if (!handoffNoted.has(role)) {
					handoffNoted.add(role);
					state.contextBulletin = `${state.contextBulletin ? `${state.contextBulletin}\n` : ""}${handoffPlanNote(route)}`;
				}
				const decision = await decideKeep(chatAsk ? undefined : classifyGateway(ctx.modelRegistry), { from: role, text: r.output.slice(-4_000), ...(chatAsk ? { chatAsk } : {}) });
				if (decision.keep) {
					const next = appendHandoff(ctx.cwd, { at: Date.now(), from: role, text: r.output.slice(-4_000) });
					run.handoffItems = next.length;
				}
			}
			return r;
		} finally {
			rescheduleTicker(ctx);
			persist();
			updateWidget(ctx);
		}
	};

	const isClassifierModel = (ctx: ExtensionContext, provider: string, id: string): boolean => {
		try {
			const reg = ctx.modelRegistry as unknown as { getModelOfType?: (t: string, p: string, i: string) => unknown };
			return !!reg.getModelOfType?.("classifier", provider, id);
		} catch {
			return false;
		}
	};

	return { launchSubagent, isClassifierModel };
};
