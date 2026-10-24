import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const CHILD_EXIT_EVENT = "agent_exit";

export const isSettledEvent = (ev: JsonAgentSessionEvent): boolean => (ev as { type?: string }).type === "agent_settled";

export const isChildExitEvent = (ev: JsonAgentSessionEvent): boolean => (ev as { type?: string }).type === CHILD_EXIT_EVENT;

export const exitEvent = (why: string): JsonAgentSessionEvent => ({ type: CHILD_EXIT_EVENT, why }) as unknown as JsonAgentSessionEvent;

export const childExitReason = (code: number | null | undefined, signal: string | null | undefined, stderr?: string): string =>
	`the sub-agent process exited (code=${code ?? "?"} signal=${signal ?? "none"}) before it settled${stderr?.trim() ? ` — stderr: ${stderr.trim().slice(-600)}` : ""}`;

export const subscribeCaptured = (subscribe: (onEvent: (ev: JsonAgentSessionEvent) => void) => () => void, onEvent: (ev: JsonAgentSessionEvent) => void): (() => void) => subscribe(onEvent);

export interface WaitOutcome {
	kind: "settled" | "exited" | "deadline" | "cancelled";
	why?: string;
	events?: JsonAgentSessionEvent[];
}

export interface WaitWatchers {
	deadlineMs: number;
	signal?: AbortSignal;
	probe?: () => string | undefined;
	probeMs?: number;
}

export const waitForRun = (subscribe: (onEvent: (ev: JsonAgentSessionEvent) => void) => () => void, watchers: WaitWatchers): { done: Promise<WaitOutcome>; stop: () => void } => {
	let unsubscribe: () => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let probeTimer: ReturnType<typeof setInterval> | undefined;
	let onAbort: (() => void) | undefined;
	let settle: (o: WaitOutcome) => void = () => {};
	let finished = false;
	const stop = (): void => {
		if (timer) clearTimeout(timer);
		if (probeTimer) clearInterval(probeTimer);
		if (onAbort && watchers.signal) watchers.signal.removeEventListener("abort", onAbort);
		unsubscribe();
	};
	const done = new Promise<WaitOutcome>((res) => {
		settle = (o) => {
			if (finished) return;
			finished = true;
			stop();
			res(o);
		};
		unsubscribe = subscribe((ev) => {
			if (isSettledEvent(ev)) settle({ kind: "settled" });
			else if (isChildExitEvent(ev)) settle({ kind: "exited", why: (ev as { why?: string }).why ?? "the sub-agent process exited before it settled" });
		});
		timer = setTimeout(() => settle({ kind: "deadline" }), Math.max(1, watchers.deadlineMs));
		if (watchers.probe) {
			probeTimer = setInterval(() => {
				const why = watchers.probe?.();
				if (why) settle({ kind: "exited", why });
			}, Math.max(250, watchers.probeMs ?? 1_000));
		}
		if (watchers.signal) {
			if (watchers.signal.aborted) settle({ kind: "cancelled" });
			else {
				onAbort = () => settle({ kind: "cancelled" });
				watchers.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
	return { done, stop };
};

export const outcomeLabel = (o: WaitOutcome, deadlineMs: number): string => {
	if (o.kind === "cancelled") return "cancelled by user (Esc)";
	if (o.kind === "exited") return o.why ?? "the sub-agent process exited before it settled";
	return `TIMEOUT ${Math.round(deadlineMs / 1000)}s`;
};

export const promptRefused = (disposition: string | undefined): boolean => disposition === "handled";

export const isSettled = isSettledEvent;

export const isChildExit = isChildExitEvent;

export type RunEvent = { kind: "event"; ev: JsonAgentSessionEvent } | { kind: "settled" } | { kind: "exited"; why: string };
