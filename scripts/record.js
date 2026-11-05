// Records the demo's example runs live on Pharos Pacific Mainnet → public/runs/<name>.json.
//   node scripts/record.js            (all)      node scripts/record.js deposit-10k positions   (some)
import { writeFile } from "node:fs/promises";
import { ask, toJson } from "../lib/ask.js";

const WALLET = "0xD27Cb53f5920D484261CC14d32094d3f043265C9"; // a real Pacific wallet with SharpByte + Avalon positions
export const RUNS = [
  { name: "rates", q: "What are the best rates for USDC?" },
  { name: "deposit-10k", q: "Deposit 10,000 USDC" },
  { name: "deposit-10m", q: "Where should I put 10m USDC?" },
  { name: "positions", q: `Positions of ${WALLET}` },
  { name: "withdraw-100k", q: `Withdraw 100,000 USDC from ${WALLET}` },
  { name: "outage", q: "Deposit 10,000 USDC", faults: { rockawayx: "down" } },
];

const pick = process.argv.slice(2);
for (const run of RUNS.filter((r) => !pick.length || pick.includes(r.name))) {
  for (let attempt = 1; ; attempt++) {
    try {
      const report = await ask(run.q, { faults: run.faults ?? {} });
      const bad = report.venues?.filter((v) => v.status === "down" && !v.injected);
      if (bad?.length) throw new Error(`venue unreachable during recording: ${bad.map((v) => v.id).join(", ")}`);
      await writeFile(new URL(`../public/runs/${run.name}.json`, import.meta.url), toJson({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", ...report }));
      console.log(`${run.name}: ${report.outcome} — ${report.summary} (${(report.ms / 1000).toFixed(1)} s)`);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.log(`${run.name}: retry (${e.message})`);
    }
  }
}
process.exit(0);
