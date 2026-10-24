import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const src = (f) => readFileSync(join(here, "extensions/finisher", f), "utf8");

const CORE = new Set(["pi", "state", "persist", "flag", "escalate", "updateWidget", "rescheduleTicker"]);

test("every kit member a kit or tool destructures off the shared context is actually provided by a kit", () => {
	const provided = new Set(CORE);
	for (const file of ["src/gui.ts", "src/viewers.ts", "src/panel-widget.ts", "src/subagent-launch.ts", "src/code-swarm.ts", "src/goal-dialog.ts"]) {
		for (const m of src(file).matchAll(/^\treturn \{([^}]*)\}/gm))
			for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) provided.add(name);
	}
	assert.ok(provided.size > 8, `no kit members were found, the parse is broken (${provided.size})`);
	for (const file of ["src/tools.ts", "src/commands.ts", "index.ts"]) {
		for (const m of src(file).matchAll(/const (\w+) = ctx\.(\w+);/g)) {
			assert.ok(provided.has(m[2]), `${file} uses ctx.${m[2]} but no kit returns it — it would be undefined at runtime`);
		}
	}
});

test("a replan cannot crash the driver: the round it arms is a real function", () => {
	const swarm = src("src/code-swarm.ts");
	assert.match(swarm, /return \{ runCodeSwarm, armGoalRound \};/, "createCodeSwarm defines armGoalRound, so it must hand it back to the context");
	assert.match(src("src/verify-tool.ts"), /step\.action === "replan"[\s\S]{0,40}armGoalRound\(/, "the replan path calls it on the real tool path");
});
