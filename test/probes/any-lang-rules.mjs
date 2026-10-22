const m = await import("../../extensions/zense-harness/index.ts");
const k = (t, p) => m.scanSource(t, p).violations.map((v) => v.kind).sort().join(",");
const body = (n) => Array(n).fill("x = 1").join("\n");
const ok = k(body(500), "app/engine.py") === "" && k(body(501), "app/engine.py") === "length" && k("func f() {\n// hi\n}", "app/main.go") === "comment";
console.log(JSON.stringify({ ok }));
process.exit(ok ? 0 : 1);
