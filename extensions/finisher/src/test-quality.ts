export type TestFindingKind = "no-assertion" | "tautology" | "shape-only";

export interface TestFinding {
	file: string;
	line: number;
	name: string;
	kind: TestFindingKind;
	detail: string;
}

export interface TestBlock {
	name: string;
	line: number;
	text: string;
}

interface Lang {
	blocks: (text: string) => TestBlock[];
	assertions: (text: string) => string[];
}

const blockScanners: { match: RegExp; apply: (lines: string[], i: number) => string | undefined }[] = [
	{
		match: /^\s*(?:test|it)\(\s*(["'`])(.*?)\1\s*,/,
		apply: () => undefined,
	},
];

const scanBlocks = (text: string, start: RegExp, nameOf: (m: RegExpMatchArray) => string): TestBlock[] => {
	const lines = text.split("\n");
	const blocks: TestBlock[] = [];
	let current: TestBlock | undefined;
	const close = () => {
		if (current) blocks.push(current);
		current = undefined;
	};
	lines.forEach((line, i) => {
		const m = line.match(start);
		if (m) {
			close();
			current = { name: nameOf(m), line: i + 1, text: "" };
		}
		if (current) current.text += line + "\n";
	});
	close();
	return blocks;
};

export const testBlocks = (text: string): TestBlock[] => scanBlocks(text, /^\s*(?:test|it)\(\s*(["'`])(.*?)\1\s*,/, (m) => m[2]);

export const testBlocksFor = (text: string, path: string): TestBlock[] => {
	if (/\.py$/.test(path)) return scanBlocks(text, /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/, (m) => m[1]);
	if (/\.go$/.test(path)) return scanBlocks(text, /^\s*func\s+(Test\w+)\s*\(/, (m) => m[1]);
	if (/\.rb$/.test(path)) return scanBlocks(text, /^\s*(?:it|test|specify)\s+(["'])(.*?)\1/, (m) => m[2]);
	if (/\.(java|kt|cs|swift|scala)$/.test(path)) return scanBlocks(text, /^\s*(?:public\s+)?(?:fun|void|func)?\s*(?:@Test\s*)?[\w<>\[\]]*\s*(test\w*)\s*\(/i, (m) => m[1]);
	return testBlocks(text);
};

const WEAK = [/^typeof\s/, /^!.+\.\w+$/, /^typeof\s.*\s(?:===|!==)\s*["'`]/];
const ALWAYS_TRUE = /^(?:true|!!\s*\S|Boolean\(.*\))$/;

const argList = (call: string): string[] => {
	const out: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let cur = "";
	for (const ch of call) {
		if (quote) {
			cur += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			cur += ch;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
};

export const assertions = (blockText: string): { method: string; args: string[]; line: number }[] => {
	const found: { method: string; args: string[]; line: number }[] = [];
	blockText.split("\n").forEach((line, i) => {
		const re = /assert\s*\.\s*(\w+)\s*\(/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(line))) {
			const start = m.index + m[0].length;
			let depth = 1;
			let quote: string | undefined;
			let i2 = start;
			for (; i2 < line.length && depth > 0; i2++) {
				const ch = line[i2];
				if (quote) {
					if (ch === quote) quote = undefined;
					continue;
				}
				if (ch === '"' || ch === "'" || ch === "`") quote = ch;
				else if (ch === "(") depth++;
				else if (ch === ")") depth--;
			}
			found.push({ method: m[1], args: argList(line.slice(start, Math.max(start, i2 - 1))), line: i + 1 });
		}
	});
	return found;
};

const assertionCount = (text: string): number => {
	const js = assertions(text).length;
	const py = (text.match(/^\s*assert\b/gm) ?? []).length;
	const go = (text.match(/\bt\.(?:Fatal|Fatalf|Error|Errorf|Fail|FailNow)\b/g) ?? []).length;
	const other = (text.match(/\b(?:expect|assert_eq!|assert!|assertEqual|assertThat|XCTAssert\w*)\b/g) ?? []).length;
	return js + py + go + other;
};

const isTautology = (a: { method: string; args: string[] }): boolean => {
	const [x, y] = a.args;
	if (y === undefined && (a.method === "ok" || a.method === "strictEqual" || a.method === "equal") && ALWAYS_TRUE.test((x ?? "").trim())) return true;
	if (y !== undefined && x === y && x !== "") return true;
	return false;
};

const isWeak = (a: { method: string; args: string[] }): boolean => WEAK.some((r) => r.test(a.args[0] ?? ""));

export const analyzeTestFile = (text: string, file: string): TestFinding[] => {
	const findings: TestFinding[] = [];
	for (const block of testBlocksFor(text, file)) {
		const asserts = assertions(block.text);
		if (!assertionCount(block.text)) {
			findings.push({ file, line: block.line, name: block.name, kind: "no-assertion", detail: "this test asserts nothing — it cannot fail, so it proves nothing" });
			continue;
		}
		if (!asserts.length) continue;
		const tautology = asserts.find(isTautology);
		if (tautology)
			findings.push({
				file,
				line: block.line + tautology.line - 1,
				name: block.name,
				kind: "tautology",
				detail: `\`assert.${tautology.method}(${tautology.args.join(", ")})\` is true by construction — it can never fail`,
			});
		if (asserts.every(isWeak) && asserts.some((a) => !isTautology(a)))
			findings.push({
				file,
				line: block.line,
				name: block.name,
				kind: "shape-only",
				detail: "every assertion here only checks that a value exists or has a type — the logic could be wrong and this test would still pass",
			});
	}
	return findings;
};

export const isTestFile = (path: string): boolean => {
	const p = path.replace(/\\/g, "/");
	if (/(^|\/)(test|tests|__tests__|spec)\//.test(p)) return true;
	if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return true;
	if (/(^|\/)[\w.-]*_test\.(py|go|rb|exs?|dart)$/.test(p)) return true;
	if (/(^|\/)test_[\w.-]*\.py$/.test(p)) return true;
	if (/_spec\.rb$/.test(p)) return true;
	if (/(^|\/)[\w]*Test\.(java|kt|cs|swift)$/.test(p)) return true;
	if (/(^|\/)Test[A-Z][\w]*\.(java|kt|cs|swift)$/.test(p)) return true;
	return false;
};

export const formatTestFindings = (findings: TestFinding[], limit = 12): string => {
	if (!findings.length) return "";
	const lines = [`${findings.length} weak test(s) — these prove nothing, so they are filler:`, ""];
	for (const f of findings.slice(0, limit)) lines.push(`  ${f.file}:${f.line} "${f.name}" — ${f.kind}: ${f.detail}`);
	if (findings.length > limit) lines.push(`  … and ${findings.length - limit} more`);
	lines.push("", "Fix by asserting the law, not the shape: a bound that must hold for every input, an ordering that must be total, a boundary that must be exact, an invariant that must survive. If nothing can fail, delete the test instead of padding the count.");
	return lines.join("\n");
};
