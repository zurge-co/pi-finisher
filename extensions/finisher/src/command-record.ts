import { type RecordedCall, normalizeCommand } from "./evidence-record.ts";

export const MAX_RECORDED_CALLS = 400;

export interface CommandEvent {
	toolName?: string;
	input?: { command?: unknown } | undefined;
	isError?: boolean;
}

export const recordedCommand = (ev: CommandEvent): string | undefined => {
	if (ev.toolName !== "bash" && ev.toolName !== "powershell") return undefined;
	const command = ev.input?.command;
	if (typeof command !== "string") return undefined;
	const trimmed = normalizeCommand(command);
	return trimmed ? trimmed.slice(0, 400) : undefined;
};

export const appendCommand = (calls: RecordedCall[], ev: CommandEvent, at = Date.now()): RecordedCall[] => {
	const command = recordedCommand(ev);
	if (!command) return calls;
	return [...calls, { command, ok: ev.isError !== true, at }].slice(-MAX_RECORDED_CALLS);
};

export const resetCommands = (): RecordedCall[] => [];
