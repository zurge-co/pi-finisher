import { clarifyChrome, type ClarifyChromeOverrides, type ClarifyQuestion } from "./goal-clarify.ts";

export const CLARIFY_ANSWER_MAX = 240;

export const CLARIFY_PICK_HINT = "enter = choose  •  esc = stop asking  •  type to filter";

export type ClarifyAsk = (question: ClarifyQuestion) => Promise<string | null | undefined>;

export interface ClarifyAsked {
	answers: Record<string, string>;
	asked: number;
	stopped: boolean;
}

export const askClarify = async (ask: ClarifyAsk, questions: readonly ClarifyQuestion[], lang?: string, chrome?: ClarifyChromeOverrides): Promise<ClarifyAsked> => {
	const words = clarifyChrome(lang, chrome);
	const answers: Record<string, string> = {};
	let asked = 0;
	for (const question of questions ?? []) {
		if (!question?.question || !question?.options?.length) continue;
		const picked = await ask(question);
		asked++;
		if (picked === undefined || picked === null) return { answers, asked, stopped: true };
		const text = String(picked).replace(/\s+/g, " ").trim().slice(0, CLARIFY_ANSWER_MAX);
		if (!text || text.toLowerCase() === words.asIs.toLowerCase()) continue;
		answers[question.question] = text;
	}
	return { answers, asked, stopped: false };
};
