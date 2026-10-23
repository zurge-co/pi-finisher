import { formatHygieneViolations, isHygieneChecked, scanSource, type HygieneViolation } from "./code-hygiene.ts";
import { analyzeTestFile, formatTestFindings, isTestFile, type TestFinding } from "./test-quality.ts";

export interface FileReview {
	ok: boolean;
	path: string;
	violations: HygieneViolation[];
	weakTests: TestFinding[];
	message: string;
}

export const reviewWrittenFile = (path: string, text: string): FileReview => {
	const violations = isHygieneChecked(path) ? scanSource(text, path).violations : [];
	const weakTests = isTestFile(path) ? analyzeTestFile(text, path) : [];
	const parts: string[] = [];
	if (violations.length) parts.push(formatHygieneViolations(violations));
	if (weakTests.length) parts.push(formatTestFindings(weakTests));
	return {
		ok: !violations.length && !weakTests.length,
		path,
		violations,
		weakTests,
		message: parts.join("\n\n"),
	};
};

export const buildFileReviewReport = (review: FileReview): string =>
	[
		`${review.path} broke the code rules — fix it now, the harness re-checks every write:`,
		review.message,
		"If the file cannot express the intent without a comment, rename or restructure instead; a load-bearing reason may stay as `finisher-hygiene-allow: <why>`.",
	].join("\n\n");

const heredocTargets = (command: string): string[] => {
	const out: string[] = [];
	const re = /(?:>>?|tee(?:\s+-a)?)\s+([^\s;|&<>]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(command))) {
		const target = m[1].replace(/^["']|["']$/g, "");
		if (target && !target.startsWith("-")) out.push(target);
	}
	const code = /(?:python3?|node|ruby|perl)\s+-\s*<<-?\s*['"]?\w+['"]?/.test(command);
	if (code) out.push("<stdin>");
	return [...new Set(out)];
};

export const commandWritePaths = (command: string): string[] => {
	const targets = heredocTargets(command).filter((t) => t !== "<stdin>");
	const patched = [...command.matchAll(/^\*\*\*\s+(?:Update|Add)\s+File:\s*(.+)$/gm)].map((m) => m[1].trim());
	return [...new Set([...targets, ...patched])];
};

export const scriptWrites = (command: string): boolean => heredocTargets(command).includes("<stdin>");

export const stdinTargets = (command: string): string[] => {
	const firstLine = command.split("\n")[0] ?? "";
	const m = firstLine.match(/(?:^|\s)(?:>|>>)\s*([^\s;|&<>]+)\s*$/) ?? firstLine.match(/(?:cat|tee(?:\s+-a)?)\s+([^\s;|&<>]+)\s*>?\s*$/);
	return m ? [m[1].replace(/^["']|["']$/g, "")] : [];
};
