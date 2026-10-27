export type HumanLang = string;

export const DEFAULT_GOAL_LANG: HumanLang = "en";

export const MIN_SCRIPT_LETTERS = 2;

interface Script {
	lang: HumanLang;
	name: string;
	letters: RegExp;
}

const THAI = /[\u0E00-\u0E7F]/;
const KANA = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/;
const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HEBREW = /[\u0590-\u05FF]/;
const CYRILLIC = /[\u0400-\u04FF]/;
const DEVANAGARI = /[\u0900-\u097F]/;
const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/;

const SCRIPTS: Script[] = [
	{ lang: "th", name: "Thai", letters: THAI },
	{ lang: "ja", name: "Japanese", letters: KANA },
	{ lang: "zh", name: "Chinese", letters: HAN },
	{ lang: "ko", name: "Korean", letters: HANGUL },
	{ lang: "ar", name: "Arabic", letters: ARABIC },
	{ lang: "he", name: "Hebrew", letters: HEBREW },
	{ lang: "ru", name: "Russian", letters: CYRILLIC },
	{ lang: "hi", name: "Hindi", letters: DEVANAGARI },
	{ lang: "el", name: "Greek", letters: GREEK },
];

const NAMES: Record<HumanLang, string> = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	nl: "Dutch",
	sv: "Swedish",
	da: "Danish",
	nb: "Norwegian",
	fi: "Finnish",
	pl: "Polish",
	cs: "Czech",
	sk: "Slovak",
	hu: "Hungarian",
	ro: "Romanian",
	bg: "Bulgarian",
	hr: "Croatian",
	sr: "Serbian",
	sl: "Slovenian",
	uk: "Ukrainian",
	tr: "Turkish",
	vi: "Vietnamese",
	id: "Indonesian",
	ms: "Malay",
	tl: "Filipino",
	sw: "Swahili",
	af: "Afrikaans",
	ca: "Catalan",
	et: "Estonian",
	lv: "Latvian",
	lt: "Lithuanian",
	fa: "Persian",
	ur: "Urdu",
	bn: "Bengali",
	ta: "Tamil",
	te: "Telugu",
	ml: "Malayalam",
	kn: "Kannada",
	mr: "Marathi",
	gu: "Gujarati",
	pa: "Punjabi",
	ne: "Nepali",
	si: "Sinhala",
	my: "Burmese",
	km: "Khmer",
	lo: "Lao",
	ka: "Georgian",
	hy: "Armenian",
	az: "Azerbaijani",
	kk: "Kazakh",
	uz: "Uzbek",
	mn: "Mongolian",
	am: "Amharic",
};
for (const s of SCRIPTS) NAMES[s.lang] = s.name;

const READABLE: Record<HumanLang, RegExp> = {};
for (const s of SCRIPTS) READABLE[s.lang] = s.letters;
READABLE.ja = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D\u3400-\u4DBF\u4E00-\u9FFF]/;
READABLE.zh = HAN;
READABLE.ko = HANGUL;
READABLE.ar = ARABIC;

export const LANGUAGE_NAMES: Record<HumanLang, string> = NAMES;

export const languageTag = (raw: unknown): HumanLang | undefined => {
	if (typeof raw !== "string") return undefined;
	const tag = raw.trim().toLowerCase().replace(/_/g, "-");
	return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(tag) ? tag : undefined;
};

export const baseLang = (tag: HumanLang): string => tag.split("-")[0] ?? tag;

export const languageName = (lang: HumanLang | undefined): string => {
	const tag = lang ?? DEFAULT_GOAL_LANG;
	return NAMES[tag] ?? NAMES[baseLang(tag)] ?? tag;
};

export interface ScriptVote {
	lang: HumanLang;
	letters: number;
}

export const scriptVotes = (text: string): ScriptVote[] => {
	const counts = new Map<HumanLang, number>();
	let kana = 0;
	let han = 0;
	const bump = (lang: HumanLang, by = 1): void => {
		counts.set(lang, (counts.get(lang) ?? 0) + by);
	};
	for (const ch of text) {
		if (KANA.test(ch)) kana++;
		else if (HAN.test(ch)) han++;
		else {
			const hit = SCRIPTS.find((s) => s.letters.test(ch));
			if (hit) bump(hit.lang);
		}
	}
	if (kana) bump("ja", kana + han);
	else if (han) bump("zh", han);
	return SCRIPTS.filter((s) => (counts.get(s.lang) ?? 0) > 0).map((s) => ({ lang: s.lang, letters: counts.get(s.lang) ?? 0 }));
};

export const languageVote = (text: string): HumanLang | undefined => {
	let best: HumanLang | undefined;
	let bestLetters = MIN_SCRIPT_LETTERS - 1;
	for (const vote of scriptVotes(text)) {
		if (vote.letters > bestLetters) {
			best = vote.lang;
			bestLetters = vote.letters;
		}
	}
	return best;
};

export const humanLanguage = (stored: HumanLang | undefined, text: string): HumanLang => languageVote(text) ?? stored ?? DEFAULT_GOAL_LANG;

export const scriptKey = (lang: HumanLang | undefined): string => {
	if (!lang) return "latin";
	const base = baseLang(lang);
	return SCRIPTS.some((s) => s.lang === base) ? base : "latin";
};

export const resolveGoalLang = (declared: HumanLang | undefined, voted: HumanLang | undefined): HumanLang => {
	if (declared && scriptKey(declared) === scriptKey(voted)) return declared;
	return voted ?? declared ?? DEFAULT_GOAL_LANG;
};

export const readableIn = (lang: HumanLang | undefined, text: string): boolean => {
	const tag = lang ?? DEFAULT_GOAL_LANG;
	const matcher = READABLE[tag] ?? READABLE[baseLang(tag)];
	if (!matcher) return true;
	let letters = 0;
	for (const ch of text) {
		if (!matcher.test(ch)) continue;
		letters++;
		if (letters >= MIN_SCRIPT_LETTERS) return true;
	}
	return false;
};

export const languageGuideline = (lang: HumanLang | undefined): string => {
	const code = lang ?? DEFAULT_GOAL_LANG;
	const name = languageName(code);
	return [
		`human language: ${name} (${code}).`,
		`The human writes and reads ${name}: write the goal text and every case in ${name}, and report to them in ${name}.`,
		"Keep file paths, identifiers, commands, code and quoted output exactly as they are — never translate those.",
	].join(" ");
};

export const goalLanguageNote = (lang: HumanLang | undefined): string => {
	const name = languageName(lang);
	return [
		`goal: the human reads ${name}, and this goal text is not ${name} — so the dialog would ask them to confirm something they cannot read, and nothing was started.`,
		`State the goal and every case in ${name}, keeping file paths, identifiers and commands verbatim, then call goal again.`,
	].join(" ");
};

type SegmenterLike = new (locales?: string | string[], options?: { granularity: "grapheme" }) => { segment: (text: string) => Iterable<{ segment: string }> };

const Segmenter = (Intl as unknown as { Segmenter?: SegmenterLike }).Segmenter;

let graphemeSegmenter: { segment: (text: string) => Iterable<{ segment: string }> } | undefined;
const segmenter = (): typeof graphemeSegmenter => {
	if (graphemeSegmenter) return graphemeSegmenter;
	try {
		graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : undefined;
	} catch {
		graphemeSegmenter = undefined;
	}
	return graphemeSegmenter;
};

export const graphemes = (text: string): string[] => {
	const seg = segmenter();
	if (!seg) return Array.from(text);
	const out: string[] = [];
	for (const part of seg.segment(text)) out.push(part.segment);
	return out;
};

export const breakGraphemes = (text: string, limit: number): string[] => {
	const width = Math.max(1, Math.floor(Number.isFinite(limit) && limit > 0 ? limit : 1));
	const units = graphemes(text);
	if (!units.length) return [""];
	const out: string[] = [];
	for (let i = 0; i < units.length; i += width) out.push(units.slice(i, i + width).join(""));
	return out;
};
