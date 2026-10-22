
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zenseDir } from "./types.ts";
import { SUBAGENT_EXCLUDE_TOOLS, SUBAGENT_STRIP_FLAGS, subagentTimeout, buildSubagentArgv } from "./subagent-config.ts";

export const fmtTok = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

export const subagentLogPath = (cwd: string, role: string): string => {
	const dir = join(zenseDir(cwd), "subagents");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return join(dir, `${stamp}-${role}.log`);
};

export function runSubagent(
	role: string,
	task: string,
	cwd: string,
	timeoutMs = subagentTimeout("default", cwd),
	onChunk?: (chunk: string) => void,
	logPath: string = subagentLogPath(cwd, role),
	modelPattern?: string,
	excludeTools?: string[],
	stripFlags?: string[],
	abortSignal?: AbortSignal,
): Promise<{ ok: boolean; output: string; logPath: string; usedModel?: string }> {
	const relLog = relative(cwd, logPath);
	return new Promise((res) => {
						if (abortSignal?.aborted) {
			res({ ok: false, output: "cancelled by user (Esc) — the sub-agent never started", logPath });
			return;
		}
				const argv = buildSubagentArgv(task, modelPattern, excludeTools, role, stripFlags);
		const strip = stripFlags ?? SUBAGENT_STRIP_FLAGS[role];
		writeFileSync(logPath, `$ pi --mode json --no-session${strip?.length ? ` ${strip.join(" ")}` : ""}${excludeTools?.length ? ` --exclude-tools ${excludeTools.join(",")}` : ""}${modelPattern ? ` --model ${modelPattern}` : ""} <task ${task.length} chars>\n--- live output (${role}) ---\n`);
		const child = spawn("env", argv, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let usedModel: string | undefined; 		let finalText = ""; 		const append = (chunk: string) => {
			out = (out + chunk).slice(-1_000_000);
			appendFileSync(logPath, chunk);
			onChunk?.(chunk);
		};
						let lineBuf = "";
		const fmtArgs = (args: unknown): string => {
			try {
				const s = JSON.stringify(args);
				return s.length > 120 ? `${s.slice(0, 117)}…` : s;
			} catch {
				return "";
			}
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let ev: { type?: string; [k: string]: unknown };
			try {
				ev = JSON.parse(line);
			} catch {
				append(`${line}\n`);
				return;
			}
			switch (ev.type) {
				case "session":
					append(`[session ${(ev as { id?: string }).id ?? "?"}]\n`);
					break;
				case "tool_execution_start": {
					const t = ev as { toolName?: string; args?: unknown };
					append(`\n⚙ ${t.toolName} ${fmtArgs(t.args)}\n`);
					break;
				}
				case "tool_execution_end": {
					const t = ev as { toolName?: string; isError?: boolean };
					if (t.isError) append(`✗ ${t.toolName} failed\n`);
					break;
				}
				case "message_update": {
										const a = (ev as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
					if (a?.type === "text_delta" && typeof a.delta === "string") append(a.delta);
					break;
				}
				case "message_end": {
																																			type JsonMsg = { role?: string; provider?: string; model?: string; content?: { type?: string; text?: string }[] };
					const boxed = ev as { message?: JsonMsg; assistantMessageEvent?: JsonMsg };
					const msg = boxed.message ?? boxed.assistantMessageEvent;
					if (!usedModel && msg?.role === "assistant" && typeof msg.provider === "string" && typeof msg.model === "string")
						usedModel = `${msg.provider}/${msg.model}`;
					if (msg?.role === "assistant" && Array.isArray(msg.content)) {
						const text = msg.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
						if (text.trim()) {
							finalText = text;
							append("\n"); 						}
					}
					break;
				}
				default:
					break;
			}
		};
		child.stdout?.on("data", (d) => {
			lineBuf += String(d);
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr?.on("data", (d) => append(String(d)));
												let timedOut = false;
		let cancelled = false; 		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, timeoutMs);
				const onAbort = () => {
			cancelled = true;
			clearTimeout(timer);
			appendFileSync(logPath, `\n--- cancelled by user (Esc) — SIGTERM ---\n`);
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			clearTimeout(timer);
			abortSignal?.removeEventListener("abort", onAbort);
			appendFileSync(logPath, `\n[spawn error] ${err.message}\n`);
			res({ ok: false, output: `sub-agent spawn error: ${err.message} (log: ${relLog})`, logPath });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			abortSignal?.removeEventListener("abort", onAbort);
			if (lineBuf.trim()) handleLine(lineBuf); 			appendFileSync(logPath, `\n--- exited code=${code} signal=${signal}${timedOut ? " (timeout SIGTERM)" : cancelled ? " (cancelled SIGTERM)" : ""} ---\n`);
			appendFileSync(logPath, `--- used model: ${usedModel ?? "(not captured from events)"} ---\n`);
			const modelInfo = usedModel !== undefined ? { usedModel } : {};
			if (cancelled)
				res({
					ok: false,
					output: `cancelled by user (Esc) — the ${role} sub-agent was killed mid-run\nlast output:\n${out.slice(-2_000)}\n(full log: ${relLog})`,
					logPath,
					...modelInfo,
				});
			else if (code === 0 && !signal) res({ ok: true, output: (finalText || out).slice(-16_000), logPath, ...modelInfo });
			else
				res({
					ok: false,
					output:
						`sub-agent exited code=${code} signal=${signal}${timedOut ? ` (TIMEOUT ${timeoutMs / 1000}s — bump per-role limit in .zense/config.json key subagentTimeoutMs)` : ""}\n` +
						`last output:\n${out.slice(-4_000)}\n(full log: ${relLog})`,
					logPath,
					...modelInfo,
				});
		});
	});
}
