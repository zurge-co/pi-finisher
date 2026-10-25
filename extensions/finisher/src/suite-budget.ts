import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SuiteSize {
	files: number;
	cases: number;
}

export const SUITE_GROWTH_MIN = 3;
export const SUITE_GROWTH_RATIO = 0.05;

export const TEST_FILE_MARK = /\.(?:test|spec)\.(?:mjs|ts|js)$/;

const CASE_DECL = /(?:^|[^\w$])(?:test|it)\s*\(/gm;

const size = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export const countTestCases = (text: string): number => {
	let count = 0;
	for (const line of String(text ?? "").split(/\r?\n/)) {
		if (line.trimStart().startsWith("//")) continue;
		const hits = line.match(CASE_DECL);
		if (hits) count += hits.length;
	}
	return count;
};

const entriesOf = (dir: string): { name: string; isDirectory(): boolean }[] => {
	try {
		return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: String(entry.name), isDirectory: () => entry.isDirectory() }));
	} catch {
		return [];
	}
};

const walk = (dir: string, out: string[]): string[] => {
	for (const entry of entriesOf(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (TEST_FILE_MARK.test(entry.name)) out.push(path);
	}
	return out;
};

export const countSuite = (root: string): SuiteSize => {
	const dir = join(root, "test");
	if (!existsSync(dir)) return { files: 0, cases: 0 };
	const files = walk(dir, []);
	let cases = 0;
	for (const file of files) {
		try {
			cases += countTestCases(readFileSync(file, "utf8"));
		} catch {
		}
	}
	return { files: files.length, cases };
};

export const suiteCeiling = (baseline: SuiteSize): SuiteSize => {
	const files = size(baseline?.files ?? 0);
	const cases = size(baseline?.cases ?? 0);
	return { files: files + 1, cases: cases + Math.max(SUITE_GROWTH_MIN, Math.ceil(cases * SUITE_GROWTH_RATIO)) };
};

export const suiteGrowth = (baseline: SuiteSize | undefined, now: SuiteSize): SuiteSize => {
	if (!baseline) return { files: 0, cases: 0 };
	return {
		files: Math.max(0, size(now?.files ?? 0) - size(baseline.files)),
		cases: Math.max(0, size(now?.cases ?? 0) - size(baseline.cases)),
	};
};

export const suiteBudget = (baseline: SuiteSize | undefined, now: SuiteSize): { ok: boolean; over: string[]; note: string } => {
	if (!baseline) return { ok: true, over: [], note: "" };
	const ceiling = suiteCeiling(baseline);
	const over: string[] = [];
	if (size(now?.files ?? 0) > ceiling.files) over.push("test files");
	if (size(now?.cases ?? 0) > ceiling.cases) over.push("test cases");
	if (!over.length) return { ok: true, over: [], note: "" };
	return {
		ok: false,
		over,
		note: `the test suite is at its ceiling (${ceiling.files} files, ${ceiling.cases} cases): proof belongs in the check file at .finisher/checks, not in another test`,
	};
};

export const suiteRefusal = (baseline: SuiteSize | undefined, now: SuiteSize, target: string): string | undefined => {
	const budget = suiteBudget(baseline, now);
	if (budget.ok) return undefined;
	return `⚠ ${target}: the test-suite growth ceiling is reached (${budget.over.join(" and ")} over) — ${budget.note}; record PASS/FAIL for each case in .finisher/checks instead`;
};

export const suiteWriteGate = (baseline: SuiteSize | undefined, root: string, target: string, exists: boolean): string | undefined => {
	const path = String(target ?? "");
	if (!baseline || exists || !TEST_FILE_MARK.test(path)) return undefined;
	return suiteRefusal(baseline, countSuite(root), path);
};
