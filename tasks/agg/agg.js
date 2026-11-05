#!/usr/bin/env node
// Multi-protocol yield aggregator on Pharos Pacific: one interface over Morpho (RockawayX, SharpByte) and Avalon.
//   npm run agg -- "What are the best rates?"
//   npm run agg -- "Deposit 10,000 USDC"                        (optionally "for 0x…")
//   npm run agg -- "Positions of 0x…"
//   npm run agg -- "Withdraw 100,000 USDC from 0x…"
//   flags: --down <venue>[,<venue>]  (inject an outage)  · --slow <venue>  · --json  · --out file.json
import { writeFile } from "node:fs/promises";
import { ask, toJson } from "../../lib/ask.js";
import { render } from "../../lib/render.js";
import { VENUES } from "../../lib/contracts.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv.splice(i + 1, 1)[0] : true;
  argv.splice(i, 1);
  return v;
};
const json = flag("json");
const out = flag("out");
const faults = {};
for (const [name, kind] of [["down", "down"], ["slow", "slow"]]) {
  const v = flag(name);
  if (!v) continue;
  for (const id of String(v).split(",")) {
    if (!VENUES.some((x) => x.id === id)) {
      console.error(`unknown venue "${id}" (venues: ${VENUES.map((x) => x.id).join(", ")})`);
      process.exit(2);
    }
    faults[id] = kind;
  }
}
const USAGE = `usage: npm run agg -- "<request>" [--down <venue>[,<venue>]] [--slow <venue>] [--json] [--out run.json]
  requests: "What are the best rates?" · "Deposit 10,000 USDC [for 0x…]" · "Positions of 0x…" · "Withdraw 5,000 USDC from 0x…" (or "all")
  venues:   ${VENUES.map((x) => x.id).join(", ")}
  Nothing is ever signed: actions come back as unsigned, simulated transactions.`;
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const question = argv.join(" ").trim();
if (!question) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const report = await ask(question, { faults });
  if (out) await writeFile(out, toJson({ recordedAt: new Date().toISOString(), ...report }));
  console.log(json ? toJson(report) : render(report));
  process.exit(report.outcome === "refused" ? 2 : 0);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
