import { appendVerdict, verdictFileFor } from "./verdict-file.ts";
import { type ExtensionAPIRef } from "./kit.ts";

export const READONLY_DENY = ["write", "edit", "multiedit", "apply_patch", "patch", "create", "delete", "move", "rename", "mkdir", "touch"] as const;

export const isReadonlyTool = (name: string): boolean => (READONLY_DENY as readonly string[]).includes(name);

export const VERDICT_TOOL = "finisher_verdict";

export const registerVerdictTool = (pi: ExtensionAPIRef): boolean => {
	const path = verdictFileFor();
	if (!path) return false;
	pi.registerTool({
		name: VERDICT_TOOL,
		label: "finisher · verdict",
		description:
			"Record your judgement for the case you were given. Call it once, at the end: the harness reads this record and nothing else, so a verdict you only write in prose is never counted.",
		promptSnippet: "Record the case verdict (PASS requires a command the harness saw succeed)",
		promptGuidelines: [
			"Call finisher_verdict exactly once, last, after you have run the command that exercises the case.",
			"PASS means the harness recorded at least one of your commands succeeding and none of them failing; anything else is read as a contradiction.",
			"If the case cannot be exercised from a command, use UNVERIFIED — a human must test it by hand. Never guess PASS.",
		],
		parameters: {
			type: "object",
			properties: {
				verdict: { type: "string", enum: ["PASS", "FAIL", "UNVERIFIED"], description: "your judgement for this case" },
				why: { type: "string", description: "one line: what the output showed (PASS) or the single thing that is missing (FAIL)" },
			},
			required: ["verdict", "why"],
		},
		async execute(_id: string, params: { verdict: "PASS" | "FAIL" | "UNVERIFIED"; why: string }) {
			const verdict = params?.verdict;
			const why = (params?.why ?? "").trim();
			if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "UNVERIFIED")
				return { content: [{ type: "text", text: `finisher_verdict: verdict must be PASS, FAIL or UNVERIFIED (got ${JSON.stringify(verdict)})` }], isError: true };
			if (!why) return { content: [{ type: "text", text: "finisher_verdict: why is empty — say what the output showed or what is missing" }], isError: true };
			appendVerdict(path, { verdict, why });
			return { content: [{ type: "text", text: `verdict recorded: ${verdict} — ${why}\nnow end your reply with one line: VERDICT: ${verdict}` }] };
		},
	} as never);
	return true;
};

export const registerReadonlyGuard = (pi: ExtensionAPIRef, role: string | undefined): boolean => {
	if (role !== "verifier") return false;
	pi.on("tool_call", async (ev) => {
		if (!isReadonlyTool(ev.toolName)) return undefined;
		return { block: true, reason: `${ev.toolName} is blocked: a verifier may not change the repo — run a command that exercises the case instead, and put any scratch file outside the repo.` };
	});
	return true;
};
