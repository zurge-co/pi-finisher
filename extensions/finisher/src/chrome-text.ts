import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";

export const CHROME_TEXT_MAX = 120;

const UNREADABLE = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;

export const usableChrome = (v: unknown): v is string =>
	typeof v === "string" && v.trim().length > 0 && v.trim().length <= CHROME_TEXT_MAX && !UNREADABLE.test(v);

export const cleanChromeText = <K extends string>(keys: readonly K[], overrides: Partial<Record<K, string>> | undefined): Partial<Record<K, string>> => {
	const out: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const value = overrides?.[key];
		if (!usableChrome(value)) continue;
		out[key] = value.trim();
	}
	return out;
};

export const chromeSet = <T extends object>(lang: string | undefined, table: Record<string, T>, fallback: T): T => {
	const tag = lang ?? DEFAULT_GOAL_LANG;
	return table[tag] ?? table[baseLang(tag as HumanLang)] ?? fallback;
};
