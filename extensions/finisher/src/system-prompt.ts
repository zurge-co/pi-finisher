import { CODE_HYGIENE_GUIDELINE } from "./code-hygiene.ts";
import { SWARM_ROUTING_GUIDELINE } from "./swarm.ts";
import { TIMEOUT_RULE } from "./timeout.ts";
import { DEFAULT_GOAL_LANG, languageGuideline } from "./human-language.ts";
import { INTAKE_GRACE_CALLS } from "./intake.ts";

export const GOAL_FIRST_GUIDELINE = `Confirm the goal before you explore: call goal with the goal and the cases it stands on as soon as the human's message gives you enough to draft them. Reading the code yourself is the main agent's job, but only after the goal is confirmed — the intake budget is ${INTAKE_GRACE_CALLS} exploratory calls per human turn, and code exploration is blocked once it is spent.`;

export const CLARIFY_GUIDELINE =
	"When the human's intent is vague, do not interrogate and do not guess: goal reads the gaps (target, observable, scope) and asks once — at most 3 questions, each with options to pick and an 'as I said is enough' escape — then folds the answers into the cases before the same confirm dialog. Never ask a question that reading the code would answer, and never run a second round for the same goal; if the human keeps their own words, make the cases concrete in the first lap.";

export const CHECK_PROOF_GUIDELINE =
	"Proof is a recorded check, not another test: a case is proven by a command the harness watched run, and verify writes one PASS/FAIL line per case to .finisher/checks/checks.jsonl — never add a test file to prove a case, and never re-run a suite that already ran green after the last edit.";

export const HARNESS_GUIDELINES = (lang?: string): string[] => [
	GOAL_FIRST_GUIDELINE,
	CLARIFY_GUIDELINE,
	CODE_HYGIENE_GUIDELINE,
	SWARM_ROUTING_GUIDELINE,
	CHECK_PROOF_GUIDELINE,
	TIMEOUT_RULE,
	languageGuideline(lang ?? DEFAULT_GOAL_LANG),
];

export const harnessSystemPrompt = (base: string, lang?: string, bulletin?: string): string =>
	[base, ...HARNESS_GUIDELINES(lang), ...(bulletin ? [bulletin] : [])].join("\n\n");

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
