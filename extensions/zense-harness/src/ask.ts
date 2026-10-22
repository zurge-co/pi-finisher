
import { asClarifyQuestions, scanClarifyQuestions, questionPolicyError, type ClarifyQuestion } from "./spec-draft.ts";

export type AskQuestion = ClarifyQuestion;

export const ASK_MAX_QUESTIONS = 5;

export const asAskQuestions = (v: unknown): AskQuestion[] | undefined => asClarifyQuestions(v)?.slice(0, ASK_MAX_QUESTIONS);

export const askQuestionScan = (v: unknown): { questions: AskQuestion[]; violations: string[] } => {
	const { questions, violations } = scanClarifyQuestions(v);
	return { questions: questions.slice(0, ASK_MAX_QUESTIONS), violations };
};

export const askPolicyError = (violations: string[]): string => `zense_ask rejected: ${questionPolicyError(violations)}`;

export interface AskAnswer {
	question: string;
	answer: string | undefined;
}

export const formatAskAnswers = (answers: AskAnswer[]): string =>
	answers
		.map(
			(a, i) =>
				`${i + 1}. ${a.question}\n   → ${a.answer === undefined ? "(skipped — the human pressed Esc; do NOT infer an answer, continue without it or ask again later)" : a.answer}`,
		)
		.join("\n");

export const ASK_NO_UI_TEXT =
	"This session has no interactive UI (RPC/print mode) — the multiple-choice picker cannot open and zense_ask will not block. Ask the human the same questions as plain chat text instead (a short numbered option list is acceptable there) and continue from their reply.";
