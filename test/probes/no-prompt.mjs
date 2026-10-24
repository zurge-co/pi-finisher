const { readFileSync } = await import("node:fs");
const s = readFileSync(new URL("../../extensions/finisher/src/hygiene-hook.ts", import.meta.url), "utf8");
const asks = ["ui.confirm", "ui.select", "ui.input", "finisherPick"].filter((x) => s.includes(x));
const ok = s.includes("isError") && asks.length === 0 && s.includes("reviewWrittenFile");
console.log(JSON.stringify({ asks, ok }));
process.exit(ok ? 0 : 1);
