import { test } from "node:test";
import assert from "node:assert/strict";
import { goalDialogWrap, graphemes } from "../extensions/finisher/index.ts";

const THAI_MARK = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/;

const thai = "ทำให้กล่องยืนยันเป้าหมายอ่านออกในภาษาที่คนพิมพ์เขียนและไม่ตัดคำกลางกราฟีม";

test("a Thai goal with no spaces is broken between graphemes, never through one", () => {
	for (const width of [6, 9, 12, 21, 40]) {
		const rows = goalDialogWrap(thai, width);
		assert.equal(rows.join(""), thai, `no Thai character is lost or reordered at width ${width}`);
		assert.ok(
			rows.every((r) => !THAI_MARK.test(r[0] ?? "")),
			`a Thai mark never opens a row at width ${width} — got ${JSON.stringify(rows)}`,
		);
		assert.ok(
			rows.every((r) => graphemes(r).length <= width),
			`every row stays within ${width} on width ${width}`,
		);
	}
});

test("mixed text keeps every character and still breaks Latin words at spaces", () => {
	const mixed = "ยืนยัน goal dialog ภาษาไทยและ keep every word whole";
	const rows = goalDialogWrap(mixed, 14);
	assert.equal(rows.join(" ").replace(/\s+/g, ""), mixed.replace(/\s+/g, ""), "no character is lost or reordered in mixed text");
	assert.ok(rows.every((r) => graphemes(r).length <= 14), "every row is within the width");
	const latin = "ship refresh tokens with rotation";
	const latinRows = goalDialogWrap(latin, 60);
	assert.deepEqual(latinRows, [latin], "a Latin goal narrower than the box is not broken at all");
});

test("the width is a hard bound: a wider box never produces more rows", () => {
	const counts = [4, 8, 16, 32, 64].map((w) => goalDialogWrap(thai, w).length);
	for (let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1], `rows must not grow as the box widens: ${JSON.stringify(counts)}`);
	assert.equal(goalDialogWrap(thai, graphemes(thai).length).length, 1, "a box as wide as the goal needs exactly one row");
});
