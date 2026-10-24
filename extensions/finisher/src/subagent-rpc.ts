import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { withTimeout, settleWithTimeout, timeoutNote } from "./timeout.ts";
import { encodeToolEvent, type ToolEvent } from "./tool-log.ts";

const RPC_CALL_MS = 60_000;

const boundedCall = <T>(run: Promise<T>, label: string, ms: number, onTimeout: () => T): Promise<T> =>
	settleWithTimeout(run, ms, label, onTimeout);

export const timeoutLabel = (label: string, ms: number): string =>
	timeoutNote({ timedOut: true, label, ms });
import { dirname } from "node:path";
import { RpcClient, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const RPC_ENTRY_SPEC = "@earendil-works/pi-coding-agent/rpc-entry";

export const fileUrlToPathSafe = (u: string): string => (u.startsWith("file://") ? decodeURIComponent(new URL(u).pathname) : u);

export const resolveRpcCliPath = (resolveSpec: (spec: string) => string | undefined, exists: (p: string) => boolean, specs: string[] = [RPC_ENTRY_SPEC, "@earendil-works/pi-coding-agent/dist/cli.js"]): string | undefined => {
	for (const spec of specs) {
		const found = resolveSpec(spec);
		if (found && exists(found)) return found;
	}
	return undefined;
};

export const rpcCliPath = (): string => {
	const found = resolveRpcCliPath(
		(spec) => {
			try {
				return fileUrlToPathSafe(import.meta.resolve(spec));
			} catch {
				return undefined;
			}
		},
		(p) => existsSync(p),
	);
	if (!found) throw new Error(`finisher: could not locate pi's RPC entry point (${RPC_ENTRY_SPEC}) — sub-agents cannot start without it`);
	return found;
};

export interface RpcRunHandle {
	role: string;
	client: RpcClient;
	startedAt: number;
	logPath?: string;
	onChunk?: (chunk: string) => void;
}

export interface RpcRunOptions {
	role: string;
	cwd: string;
	prompt: string;
	logPath: string;
	timeoutMs: number;
	cliArgs?: string[];
	model?: string;
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
}

export const liveRpcRuns = new Map<string, RpcRunHandle>();

export const runKey = (role: string, at: number): string => `${role}:${at}`;

export const textFromEvent = (ev: JsonAgentSessionEvent): string => {
	const e = ev as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
	return e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta" && typeof e.assistantMessageEvent.delta === "string" ? e.assistantMessageEvent.delta : "";
};

const outputOf = (result: unknown): string | undefined => {
	const r = result as { content?: unknown; output?: unknown } | undefined;
	if (typeof r?.output === "string") return r.output;
	if (!Array.isArray(r?.content)) return undefined;
	const text = r.content.map((c) => (c as { type?: string; text?: string })?.type === "text" ? ((c as { text?: string }).text ?? "") : "").join("\n").trim();
	return text || undefined;
};

export const toolEventFrom = (ev: JsonAgentSessionEvent): ToolEvent | undefined => {
	const e = ev as { type?: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean; durationMs?: number };
	if (!e.toolName || !e.toolCallId) return undefined;
	if (e.type === "tool_execution_start") return { phase: "start", id: e.toolCallId, name: e.toolName, ...(e.args === undefined ? {} : { args: e.args }) };
	if (e.type === "tool_execution_end") {
		const output = outputOf(e.result);
		return { phase: "end", id: e.toolCallId, name: e.toolName, ...(e.isError === true ? { isError: true } : {}), ...(typeof e.durationMs === "number" ? { durationMs: e.durationMs } : {}), ...(output ? { output } : {}) };
	}
	return undefined;
};

export const toolLineFromEvent = (ev: JsonAgentSessionEvent): string | undefined => {
	const tool = toolEventFrom(ev);
	return tool ? `\n${encodeToolEvent(tool)}\n` : undefined;
};

export const isSettled = (ev: JsonAgentSessionEvent): boolean => (ev as { type?: string }).type === "agent_settled";

export const finalTextFromMessages = (messages: readonly unknown[]): string => {
	const last = [...messages].reverse().find((m) => (m as { role?: string })?.role === "assistant") as { content?: { type?: string; text?: string }[] } | undefined;
	if (!last || !Array.isArray(last.content)) return "";
	return last.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("");
};

export const splitModelPattern = (pattern: string | undefined): { provider?: string; model?: string } => {
	const clean = pattern?.trim();
	if (!clean) return {};
	const slash = clean.indexOf("/");
	if (slash <= 0) return { model: clean };
	return { provider: clean.slice(0, slash), model: clean.slice(slash + 1) };
};

export const modelLabel = (m: { provider?: string; id?: string } | undefined): string | undefined => (m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined);

const writeHeader = (logPath: string, role: string, prompt: string): void => {
	mkdirSync(dirname(logPath), { recursive: true });
	writeFileSync(logPath, `$ pi --mode rpc (finisher sub-agent ${role})\n--- task ${prompt.length} chars ---\n--- live output ---\n`);
};

const TIMED_OUT = Symbol("timeout");

export const raceTimeout = async <T>(run: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | typeof TIMED_OUT> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stopper = new Promise<typeof TIMED_OUT>((res) => {
		const fire = () => res(TIMED_OUT);
		timer = setTimeout(fire, timeoutMs);
		if (signal) {
			onAbort = fire;
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		return await Promise.race([run, stopper]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort && signal) signal.removeEventListener("abort", onAbort);
	}
};

export const runRpcSubagent = async (opts: RpcRunOptions): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string; sessionId?: string }> => {
	writeHeader(opts.logPath, opts.role, opts.prompt);
	if (opts.signal?.aborted) return { ok: false, output: "cancelled by user (Esc) — the sub-agent never started", logPath: opts.logPath };
	const wanted = splitModelPattern(opts.model);
	const client = new RpcClient({
		cliPath: rpcCliPath(),
		cwd: opts.cwd,
		env: { PI_FINISHER_SUBAGENT: "1" },
		args: opts.cliArgs ?? [],
		...(wanted.provider ? { provider: wanted.provider } : {}),
		...(wanted.model ? { model: wanted.model } : {}),
	});
	const startedAt = Date.now();
	const key = runKey(opts.role, startedAt);
	liveRpcRuns.set(key, { role: opts.role, client, startedAt, logPath: opts.logPath, onChunk: opts.onChunk });
	const append = (s: string) => appendFileSync(opts.logPath, s);
	try {
		const started = await withTimeout(client.start(), opts.timeoutMs, `rpc start (${opts.role})`);
		if (started.timedOut) return { ok: false, output: `${timeoutLabel("rpc start", opts.timeoutMs)} — the sub-agent never came up`, logPath: opts.logPath };
		const unsub = client.onEvent((ev) => {
			const tool = toolLineFromEvent(ev);
			if (tool) {
				append(tool);
				opts.onChunk?.(tool);
				return;
			}
			const text = textFromEvent(ev);
			if (text) {
				append(text);
				opts.onChunk?.(text);
			}
		});
		const raced = await raceTimeout(
			settleWithTimeout(client.promptAndWait(opts.prompt, undefined, opts.timeoutMs), opts.timeoutMs + RPC_CALL_MS, `rpc run (${opts.role})`, () => [] as never),
			opts.timeoutMs,
			opts.signal,
		);
		unsub();
		if (raced === TIMED_OUT) {
			await boundedCall(client.abort(), `rpc abort (${opts.role})`, RPC_CALL_MS, () => undefined).catch(() => undefined);
			const partial = finalTextFromMessages(await boundedCall(client.getMessages(), `rpc getMessages (${opts.role})`, RPC_CALL_MS, () => [] as never).catch(() => []));
			const why = opts.signal?.aborted ? "cancelled by user (Esc)" : `TIMEOUT ${Math.round(opts.timeoutMs / 1000)}s`;
			append(`\n--- ${why} ---\n`);
			return { ok: false, output: `${why}\nlast output:\n${partial.slice(-2_000)} (log: ${opts.logPath})`, logPath: opts.logPath };
		}
		const msgs = await boundedCall(client.getMessages(), `rpc getMessages (${opts.role})`, RPC_CALL_MS, () => [] as never);
		const state = (await boundedCall(client.getState(), `rpc getState (${opts.role})`, RPC_CALL_MS, () => undefined).catch(() => undefined)) as { model?: { provider?: string; id?: string }; sessionId?: string } | undefined;
		const usedModel = modelLabel(state?.model);
		const sessionId = typeof state?.sessionId === "string" ? state.sessionId : undefined;
		const output = finalTextFromMessages(msgs);
		append(`\n--- exited ok ---\n--- used model: ${usedModel ?? "(unknown)"} ---\n--- session: ${sessionId ?? "(none)"} ---\n`);
		return { ok: true, output: output.slice(-16_000), logPath: opts.logPath, ...(usedModel ? { usedModel } : {}), ...(sessionId ? { sessionId } : {}) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		append(`\n--- rpc error: ${msg} ---\n`);
		return { ok: false, output: `sub-agent rpc error: ${msg} (log: ${opts.logPath})`, logPath: opts.logPath };
	} finally {
		liveRpcRuns.delete(key);
		await boundedCall(client.stop(), `rpc stop (${opts.role})`, RPC_CALL_MS, () => undefined).catch(() => undefined);
	}
};

export const liveByRole = (role?: string): RpcRunHandle[] => [...liveRpcRuns.values()].filter((r) => !role || r.role === role);

export const steerMarker = (mode: "steer" | "followUp", message: string): string =>
	`\n\n── ${mode === "followUp" ? "follow-up" : "steer"} pushed into this run ──\n${message}\n\n`;

export const markSteerInLog = (logPath: string | undefined, mode: "steer" | "followUp", message: string): void => {
	if (!logPath) return;
	try {
		appendFileSync(logPath, steerMarker(mode, message));
	} catch {
	}
};

const pushIntoLive = async (role: string, message: string, mode: "steer" | "followUp"): Promise<RpcRunHandle[]> => {
	const live = liveByRole(role);
	for (const r of live) {
		markSteerInLog(r.logPath, mode, message);
		if (mode === "followUp") await boundedCall(r.client.followUp(message), `rpc followUp (${r.role})`, RPC_CALL_MS, () => "timed-out" as never).catch(() => undefined);
		else await boundedCall(r.client.steer(message), `rpc steer (${r.role})`, RPC_CALL_MS, () => "timed-out" as never).catch(() => undefined);
	}
	return live;
};

export const steerLive = async (role: string, message: string): Promise<number> => (await pushIntoLive(role, message, "steer")).length;

export const followUpLive = async (role: string, message: string): Promise<number> => (await pushIntoLive(role, message, "followUp")).length;

