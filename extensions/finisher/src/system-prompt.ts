import { CODE_HYGIENE_GUIDELINE, HYGIENE_MAX_BYTES, HYGIENE_MAX_LINES } from "./code-hygiene.ts";
import { SWARM_ROUTING_GUIDELINE } from "./swarm.ts";
import { TIMEOUT_RULE } from "./timeout.ts";
import { DEFAULT_GOAL_LANG, languageGuideline } from "./human-language.ts";
import { CONSULT_GUIDELINE, INTENT_GUIDELINE, type TurnIntent } from "./consult.ts";
import { LEGACY_GUIDELINE } from "./legacy-names.ts";
import { STATE_HOME_LABEL } from "./project-dir.ts";

export const GOAL_FIRST_GUIDELINE =
	"Confirm the goal before you run work: call goal with the goal and the cases it stands on as soon as the human's message gives you enough to draft them. Reading the code yourself is the main agent's job, and you may read to understand the message — but the run starts at goal, not at a guess.";

export const GOAL_WHEN_WORK_GUIDELINE =
	"Once — and only once — you have read this message as a work order, confirm the goal before you run any work: call goal with the goal and the cases it stands on as soon as the request gives you enough to draft them, and read the code first if that is what the draft needs. A message you read as a conversation is answered, never armed, so nothing here demands a goal for it.";

export const WORK_FORCED_GUIDELINE =
	"The human set consultMode: off, so this turn is a work order whatever it reads like: do not spend it on conversation. Draft the goal from their own words and call goal with the cases it stands on, then run it — and if something about the request is genuinely unclear, that is the goal tool's single bounded round, never a reason to answer instead of starting.";

export const CLARIFY_GUIDELINE =
	"Before the goal is confirmed, goal may ask once — at most 3 questions, each with options to pick and an 'as I said is enough' escape — only to confirm that the goal was understood the way the human meant it: what you take it to mean, the word they used, the result they expect. Never ask how the work is done and never ask how far it reaches; a question that reading the code would answer is not asked at all. The round happens once per goal, never at the start of a turn, and answers are folded into the cases before the same confirm dialog; if the human keeps their own words, make the cases concrete in the first lap.";

export const READ_WHOLE_FILE_GUIDELINE =
	`Read a module whole: every file here stays at or under ${HYGIENE_MAX_LINES} lines and ${HYGIENE_MAX_BYTES / 1024}KB, so a read of the path alone returns all of it. A call that passes offset or a limit pages a file that already fits — one turn per page, and what you then reason about is a slice of the module treated as if it were the whole.`;

export const CHECK_PROOF_GUIDELINE =
	`Proof is a recorded check, not another test: a case is proven by a command the harness watched run, and verify writes one PASS/FAIL line per case to ${STATE_HOME_LABEL}/checks/checks.jsonl — never add a test file to prove a case, and never re-run a suite that already ran green after the last edit.`;

export const consultTurn = (intent?: TurnIntent): boolean => intent === "consult";

export const forcedWork = (intent?: TurnIntent): boolean => intent === "work";

export const intentRules = (intent?: TurnIntent): string[] => {
	if (consultTurn(intent)) return [CONSULT_GUIDELINE];
	if (forcedWork(intent)) return [WORK_FORCED_GUIDELINE, GOAL_FIRST_GUIDELINE, CLARIFY_GUIDELINE];
	return [INTENT_GUIDELINE, GOAL_WHEN_WORK_GUIDELINE, CLARIFY_GUIDELINE];
};

export const HARNESS_GUIDELINES = (lang?: string, intent?: TurnIntent): string[] => [
	...intentRules(intent),
	LEGACY_GUIDELINE,
	CODE_HYGIENE_GUIDELINE,
	READ_WHOLE_FILE_GUIDELINE,
	SWARM_ROUTING_GUIDELINE,
	CHECK_PROOF_GUIDELINE,
	TIMEOUT_RULE,
	languageGuideline(lang ?? DEFAULT_GOAL_LANG),
];

export const harnessSystemPrompt = (base: string, lang?: string, bulletin?: string, intent?: TurnIntent): string =>
	[base, ...HARNESS_GUIDELINES(lang, intent), ...(bulletin ? [bulletin] : [])].join("\n\n");

export const countOccurrences = (haystack: string, needle: string): number => {
	if (!needle) return 0;
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
};
