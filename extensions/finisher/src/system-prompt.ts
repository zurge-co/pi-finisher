import { CODE_HYGIENE_GUIDELINE } from "./code-hygiene.ts";
import { SWARM_ROUTING_GUIDELINE } from "./swarm.ts";
import { TIMEOUT_RULE } from "./timeout.ts";
import { DEFAULT_GOAL_LANG, languageGuideline } from "./human-language.ts";
import { CONSULT_GUIDELINE, INTENT_GUIDELINE, type TurnIntent } from "./consult.ts";
import { LEGACY_GUIDELINE } from "./legacy-names.ts";

export const GOAL_FIRST_GUIDELINE =
	"Confirm the goal before you run work: call goal with the goal and the cases it stands on as soon as the human's message gives you enough to draft them. Reading the code yourself is the main agent's job, and you may read to understand the message — but the run starts at goal, not at a guess.";

export const CLARIFY_GUIDELINE =
	"Before the goal is confirmed, goal may ask once — at most 3 questions, each with options to pick and an 'as I said is enough' escape — only to confirm that the goal was understood the way the human meant it: what you take it to mean, the word they used, the result they expect. Never ask how the work is done and never ask how far it reaches; a question that reading the code would answer is not asked at all. The round happens once per goal, never at the start of a turn, and answers are folded into the cases before the same confirm dialog; if the human keeps their own words, make the cases concrete in the first lap.";

export const CHECK_PROOF_GUIDELINE =
	"Proof is a recorded check, not another test: a case is proven by a command the harness watched run, and verify writes one PASS/FAIL line per case to .finisher/checks/checks.jsonl — never add a test file to prove a case, and never re-run a suite that already ran green after the last edit.";

export const consultTurn = (intent?: TurnIntent): boolean => intent === "consult";

export const HARNESS_GUIDELINES = (lang?: string, intent?: TurnIntent): string[] => [
	...(consultTurn(intent) ? [CONSULT_GUIDELINE] : [INTENT_GUIDELINE, GOAL_FIRST_GUIDELINE, CLARIFY_GUIDELINE]),
	LEGACY_GUIDELINE,
	CODE_HYGIENE_GUIDELINE,
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
