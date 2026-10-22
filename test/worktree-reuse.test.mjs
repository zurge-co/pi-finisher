import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canReuseWorktree } from "../extensions/zense-harness/index.ts";

test("canReuseWorktree: null/missing-dir → false, existing dir → true (guards against a spec bump orphaning in-progress work)", async () => {
	const { canReuseWorktree } = await import("../extensions/zense-harness/index.ts");
	assert.equal(canReuseWorktree(null), false);
	assert.equal(canReuseWorktree(undefined), false);
	assert.equal(canReuseWorktree({ root: "/nonexistent-zense-wt-xyz-123", branch: "zense/impl/v1-x", dir: "/nonexistent-zense-wt-xyz-123" }), false);
	const dir = mkdtempSync(join(tmpdir(), "zense-reuse-"));
	try {
				assert.equal(canReuseWorktree({ root: dir, branch: "zense/impl/v3-old", dir }), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
