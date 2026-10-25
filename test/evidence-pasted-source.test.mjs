import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { anchoredCommand, extractCommands as extractRaw, judgeCase as judgeRaw, pastedSource, statusInCode } from "../extensions/finisher/index.ts";

const SRC = "extensions/finisher/src";
const files = [...readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, f)), "extensions/finisher/index.ts"];

const block = (body, result = "RESULT: PASS") => `EVIDENCE:\n${body}${result ? `\n${result}` : ""}`;
const extractCommands = (body) => extractRaw(block(body, ""));
const judgeCase = (id, body) => judgeRaw(id, block(body));

const catN = (text) => text.split("\n").map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join("\n");

test("no line of the real tree can become a status line while also being pasted source", () => {
	let checked = 0;
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			checked += 1;
			assert.equal(/\bexit(?:ed)?(?:\s*(?:code|status))?\s*[:=]?\s*-?\d{1,3}\b/i.test(line) && !pastedSource(line) && !/RESULT/.test(line), false, `${file}: ${line}`);
		}
	}
	assert.ok(checked > 1000, `the property must hold over the whole tree, not a sample (checked ${checked})`);
});

test("a command in front of a pasted status report still counts as a command, so the guard does not swallow real evidence", () => {
	for (const text of ["$ node -e \"run()\"\nexit code 0", "node --test a.test.mjs\nEXIT=0", "node --test a.test.mjs\nexit status = 0"]) {
		const commands = extractCommands(text);
		assert.equal(commands.length, 1, text);
		assert.equal(commands[0].exitCode, 0, text);
		assert.equal(judgeRaw("c1", block(text)).result, "PASS", text);
	}
});

test("a dump line is inert even when it opens with a command name and carries its own status", () => {
	for (const dump of ["   5\t| npm test | 1 |", "  \t| npm test | 1 |", "  \tnpm test  # exit code: 1"]) {
		assert.equal(pastedSource(dump), true, dump);
		assert.equal(anchoredCommand(dump), false, dump);
		assert.deepEqual(extractCommands(dump), [], dump);
		assert.equal(judgeRaw("c1", block(dump)).result, "UNVERIFIED", dump);
	}
});

test("an indented status still belongs to the command above it, so the guard does not block real evidence", () => {
	for (const status of ["\texit code: 6", "    exit 6", "  exit status: 6"]) {
		const commands = extractRaw(block(`npm test\n${status}`, ""));
		assert.equal(commands.length, 1, status);
		assert.equal(commands[0].exitCode, 6, status);
		assert.equal(statusInCode(status), false, status);
	}
});

test("no line of the real tree can make a verifier result fail", () => {
	let checked = 0;
	for (const file of files) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			checked += 1;
			assert.notEqual(judgeRaw("c1", block(line)).result, "FAIL", `${file}: ${line}`);
		}
	}
	assert.ok(checked > 1000, `the property must hold over the whole tree, not a sample (checked ${checked})`);
});

test("a pasted source dump is never read as a failed command, in either dump format", () => {
	const body = [
		"const results = await Promise.all(slices);",
		"",
		"const report = buildReport(results.map((r) => judgeCase(r.id, r.output, r.ok ? {} : { exitCode: 1 })));",
		"return report;",
	];
	const dumps = {
		"cat -n gutter": body.map((line, i) => `${String(131 + i).padStart(6)}\t\t\t${line}`).join("\n"),
		"sed tab indent": body.map((line) => `\t\t\t${line}`).join("\n"),
		"space indent": body.map((line) => `        ${line}`).join("\n"),
	};
	for (const [format, dump] of Object.entries(dumps)) {
		assert.equal(extractCommands(dump).filter((c) => c.command.startsWith("(unowned status)")).length, 0, format);
		assert.equal(extractCommands(dump).filter((c) => typeof c.exitCode === "number").length, 0, format);
		assert.notEqual(judgeCase("m2", `${dump}\nRESULT: PASS`).result, "FAIL", format);
	}
});

test("a command never borrows the status printed inside a pasted dump a few lines below it", () => {
	const texts = [
		"`npm test`\n        const state = { exitCode: 1 };\nRESULT: PASS",
		"`npm test`\n        patch({ exitCode: 1 });\nRESULT: PASS",
		"`npm test`\n   134\t\t\tstate.exitCode = 1\nRESULT: PASS",
		"`npm test`\n    npm ci && exit 1\nRESULT: PASS",
		"`npm test`\n    npm test exit 1\nRESULT: PASS",
		"`npm test`\n    node --test a.test.mjs   exit 1\nRESULT: PASS",
		"`npm test`\n    go test ./... exit 1\nRESULT: PASS",
	];
	for (const text of texts) {
		assert.ok(extractCommands(text).every((c) => c.exitCode === undefined), text);
		const result = judgeCase("c1", text).result;
		assert.notEqual(result, "FAIL", text);
		assert.equal(result, "UNVERIFIED", `a status nobody reported for this command proves nothing: ${text}`);
	}
});

test("a status on a line of its own still belongs to the command above it, indented or not", () => {
	for (const status of ["exit 1", "  exit 1", "\texit code: 6", "      exit status: 6", "exit 6"]) {
		const commands = extractRaw(block(`npm test\n${status}`, ""));
		assert.equal(commands.length, 1, status);
		assert.notEqual(commands[0].exitCode, undefined, status);
		assert.notEqual(judgeRaw("c1", block(`npm test\n${status}`)).result, "UNVERIFIED", status);
	}
});
