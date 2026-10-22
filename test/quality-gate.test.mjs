import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyQualityGate, buildRequirementsPrompt } from "../extensions/zense-harness/index.ts";

test("applyQualityGate: scope pointing at a non-existent path is caught (gate would be toothless otherwise)", () => {
	const dir = mkdtempSync(join(tmpdir(), "zense-scope-"));
	try {
		mkdirSync(join(dir, "src", "real-dir"), { recursive: true }); 		const { notes, draft } = applyQualityGate(dir, {
			title: "t",
			intent: "i",
			scope: ["src/real-dir", "ghost/nope-xyz"],
			constraints: [],
			criteria: [{ id: "c1", text: "t", check: "npm test" }],
			specDebt: [],
		});
		assert.ok(notes.some((n) => n.startsWith("scope-missing:ghost/nope-xyz")));
		assert.ok(!notes.some((n) => n.startsWith("scope-missing:src/real-dir")));
		assert.ok(draft.specDebt.some((d) => d.includes("ghost/nope-xyz")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
