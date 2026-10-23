import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import {
	panelize,
} from "../extensions/zense-harness/index.ts";




test("panelize: fake theme.bg injectable via structural type — token 'selectedBg' reaches theme.bg", () => {
	const calls = [];
	const fake = { bg: (color, text) => { calls.push(color); return `<${color}>${text}</${color}>`; } };
	const out = panelize(fake, ["hi"], 10);
	assert.deepEqual(calls, ["selectedBg"]);
	assert.match(out[0], /^<selectedBg>/);
});

test("panelize: a line shorter than w gets padded to full width, then bg-wrapped whole", () => {
	const fake = { bg: (_c, text) => `[BG]${text}[/BG]` };
	const [padded] = panelize(fake, ["abc"], 8);
		assert.equal(padded.slice(4, -5).length, 8);
	assert.equal(padded, `[BG]abc${" ".repeat(5)}[/BG]`);
});

