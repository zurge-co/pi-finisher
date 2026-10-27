import { baseLang, DEFAULT_GOAL_LANG, type HumanLang } from "./human-language.ts";

export const LEGACY_TOOL_RENAMES: Readonly<Record<string, string>> = {
	finisher_goal: "goal",
	finisher_phase: "lap",
	finisher_swarm: "code",
	finisher_verify: "verify",
	finisher_steer: "steer",
};

export const LEGACY_TOOL_NAMES: readonly string[] = Object.keys(LEGACY_TOOL_RENAMES);

const LEGACY_PREFIX = "finisher_";

const thaiLang = (lang?: string): boolean => baseLang((lang ?? DEFAULT_GOAL_LANG) as HumanLang) === "th";

const LEGACY_RE = new RegExp(`(?<![\\w])(${LEGACY_TOOL_NAMES.join("|")})(?![\\w])`, "gi");

export const legacyRename = (name: string): string | undefined => LEGACY_TOOL_RENAMES[String(name ?? "").trim().toLowerCase()];

export const isLegacyToolName = (name: string): boolean => legacyRename(name) !== undefined;

export const legacyToolName = (name: string): string | undefined => {
	const text = String(name ?? "").trim().toLowerCase();
	const mapped = legacyRename(text);
	if (mapped) return mapped;
	if (!text.startsWith(LEGACY_PREFIX)) return undefined;
	return legacyRename(text.replace(/[[\]]/g, "").split(/\s+/)[0] ?? "");
};

export const legacyNamesIn = (text: string): string[] => {
	const source = typeof text === "string" ? text : "";
	const found: string[] = [];
	for (const match of source.matchAll(LEGACY_RE)) {
		const name = (match[1] ?? "").toLowerCase();
		if (name && !found.includes(name)) found.push(name);
	}
	return found;
};

export const legacyRenamesIn = (text: string): { from: string; to: string }[] =>
	legacyNamesIn(text).map((from) => ({ from, to: LEGACY_TOOL_RENAMES[from] ?? from }));

const pairs = (names: readonly string[]): string => names.map((name) => `${name} → ${LEGACY_TOOL_RENAMES[name] ?? name}`).join(", ");

const namesOf = (source: string | readonly string[]): string[] => (typeof source === "string" ? legacyNamesIn(source) : [...source]);

export const legacyNote = (source: string | readonly string[], lang?: string): string => {
	const names = namesOf(source);
	if (!names.length) return "";
	const mapped = pairs(names);
	return thaiLang(lang)
		? `ชื่อ tool เก่าแล้ว: ${mapped} — tool ไม่มีคำนำหน้า finisher_ แล้ว เรียกด้วยชื่อใหม่ได้เลย`
		: `retired tool name: ${mapped} — the tools carry no finisher_ prefix any more, so call them by their new name`;
};

export const legacyDirective = (prompt: string, lang?: string): string => {
	const names = legacyNamesIn(prompt);
	if (!names.length) return "";
	const mapped = pairs(names);
	const line = (typeof prompt === "string" ? prompt : "").replace(/\s+/g, " ").trim().slice(0, 120);
	return thaiLang(lang)
		? `มนุษย์ใช้ชื่อ tool เก่า (${mapped})${line ? ` ในข้อความ "${line}"` : ""} — นั่นคือการเปลี่ยนชื่อ ไม่ใช่ tool ที่ไม่มีอยู่: เรียกชื่อใหม่แทนทันที และตอบข้อความของมนุษย์ตามปกติ ไม่ต้องรายงานว่า "tool not found"`
		: `the human used a retired tool name (${mapped})${line ? ` in "${line}"` : ""} — that is a rename, not a missing tool: call the new name instead and answer their message as usual instead of reporting a missing tool`;
};

export const legacyToolHint = (toolName: string, lang?: string): string => {
	const mapped = legacyToolName(toolName);
	if (!mapped) return "";
	return thaiLang(lang)
		? `${toolName}: ชื่อนี้ถูกเปลี่ยนแล้ว ใช้ ${mapped} แทน (ไม่ต้องมีคำนำหน้า finisher_)`
		: `${toolName}: that name was renamed — use ${mapped} instead (no finisher_ prefix at all)`;
};

export const LEGACY_GUIDELINE =
	"The tools are named goal, lap, code, verify and steer — never finisher_goal, finisher_phase, finisher_swarm, finisher_verify or finisher_steer. Those old names are not tools: when the human writes one, treat it as a rename to the new name and carry on with the same intent instead of reporting a missing tool.";
