import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SUBAGENT_STRIP_FLAGS,
	hasUnsubstitutedPlaceholder,
	modelMatchesPattern,
	normalizeShellCommand,
	runCheckProbes,
} from "../extensions/zense-harness/index.ts";

test("SUBAGENT_STRIP_FLAGS: grader/reviewer fully bare, requirements strips only themes/templates", () => {
	const FULL = ["--no-skills", "--no-prompt-templates", "--no-themes", "--no-extensions"];
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.grader, FULL);
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.reviewer, FULL);
	assert.deepEqual(SUBAGENT_STRIP_FLAGS.requirements, ["--no-themes", "--no-prompt-templates"]);
	assert.equal(SUBAGENT_STRIP_FLAGS["unknown-role"], undefined);
});

test("hasUnsubstitutedPlaceholder: returns offending token for angle/brace templates, null for clean checks", () => {
	assert.equal(hasUnsubstitutedPlaceholder("path exists: <path>"), "<path>");
	assert.equal(hasUnsubstitutedPlaceholder("path exists: src/<module>/x.ts"), "<module>");
	assert.equal(hasUnsubstitutedPlaceholder("{name} gate"), "{name}");
	assert.equal(hasUnsubstitutedPlaceholder("npm test"), null);
	assert.equal(hasUnsubstitutedPlaceholder('node -e "process.exit(1)"'), null);
		assert.equal(hasUnsubstitutedPlaceholder("cat nofile 2>&1 | grep -q ok"), null);
	assert.equal(hasUnsubstitutedPlaceholder('grep -q "${HOME}" README.md'), null);
});

test("runCheckProbes: unsubstituted placeholder in check → skipped (NOT fail), detail points to re-spec", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "ph1", text: "angle placeholder path", check: "path exists: src/<module>/index.ts" },
		{ id: "ph2", text: "brace placeholder shell", check: 'grep -q "ok" {file}' },
		{ id: "ph3", text: "clean shell", check: "node --version" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["skipped", "skipped", "pass"]);
	assert.match(probes[0].detail, /unsubstituted placeholder "<module>"/);
	assert.match(probes[0].detail, /fix spec via zense_spec/);
	assert.match(probes[1].detail, /unsubstituted placeholder "\{file\}"/);
});

test("modelMatchesPattern: exact / thinking-suffix / case-insensitive match, rejects other providers and prefixes", () => {
	assert.ok(modelMatchesPattern("openai/gpt-4.1", "openai/gpt-4.1"));
	assert.ok(modelMatchesPattern("openai/gpt-4.1", "openai/gpt-4.1:high"));
	assert.ok(modelMatchesPattern("OpenAI/GPT-4.1", "openai/gpt-4.1"));
	assert.ok(!modelMatchesPattern("openai/gpt-4.1", "anthropic/claude"));
	assert.ok(!modelMatchesPattern("synthetic/syn:large:text", "synthetic/syn:large")); });

test("normalizeShellCommand: strips leading bash:/sh:/shell:/zsh: prefix once, no-op otherwise", () => {
	assert.equal(normalizeShellCommand("bash: node --version"), "node --version");
	assert.equal(normalizeShellCommand("sh:npm test"), "npm test");
	assert.equal(normalizeShellCommand("SHELL: node --version"), "node --version");
	assert.equal(normalizeShellCommand("zsh: make build"), "make build");
		assert.equal(normalizeShellCommand("npm test"), "npm test");
	assert.equal(normalizeShellCommand("bash --version"), "bash --version");
	assert.equal(normalizeShellCommand('echo "a" && bash: node --version'), 'echo "a" && bash: node --version');
});

test("runCheckProbes: leading runner prefix executes the stripped command (true pass/fail/cmdErr)", () => {
	const probes = runCheckProbes(tmpdir(), [
		{ id: "n1", text: "prefixed pass", check: "bash: node --version" },
		{ id: "n2", text: "prefixed real fail", check: 'sh: node -e "process.exit(7)"' },
		{ id: "n3", text: "prefixed missing cmd", check: "bash: definitely-missing-command-xyz --version" },
		{ id: "n4", text: "prefixed compound", check: "shell: node --version && path exists: definitely-missing-file-xyz" },
	]);
	assert.deepEqual(probes.map((p) => p.status), ["pass", "fail", "skipped", "fail"]);
	assert.equal(probes[1].exitCode, 7); 	assert.equal(probes[2].exitCode, 127); 	assert.match(probes[2].detail, /probe command error/);
	assert.match(probes[3].detail, /not found: definitely-missing-file-xyz/);
});
