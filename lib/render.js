import { fmtUsdc, pct } from "./chain.js";
import { explorerAddress } from "./contracts.js";

// Terminal report. Colours only when stdout is a TTY.
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1), dim = c(2), green = c(32), red = c(31), yellow = c(33), blue = c(34);
const pad = (s, n) => String(s).padEnd(n);
const STATUS = { ok: green("● ok"), degraded: yellow("● degraded"), down: red("● down"), paused: red("● paused") };
const OUTCOME = { prepared: green("PREPARED FOR SIGNATURE"), answered: green("ANSWERED"), partial: yellow("PARTIAL"), blocked: red("BLOCKED"), refused: yellow("REFUSED") };

export function render(r) {
  const out = [];
  out.push("", `${bold(OUTCOME[r.outcome] ?? r.outcome)}  ${r.summary}`);
  if (r.question) out.push(dim(`“${r.question}”${r.block ? ` · Pacific block ${r.block.number}` : ""}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ""}`));
  if (r.venues?.length) {
    out.push("", bold("Venues"), dim(`  ${pad("venue", 34)}${pad("status", 13)}${pad("net APY", 10)}${pad("1d / 7d paid", 17)}${pad("TVL", 15)}${pad("can leave now", 16)}deposits go to`));
    for (const v of r.venues) {
      if (v.status === "down" || v.status === "paused") {
        out.push(`  ${pad(v.name, 34)}${pad(STATUS[v.status], 13 + (tty ? 9 : 0))}${dim(v.reason)}`);
        continue;
      }
      out.push(`  ${pad(v.name, 34)}${pad(STATUS[v.status], 13 + (tty ? 9 : 0))}${pad(pct(v.apy), 10)}${pad(`${pct(v.realised1d)} / ${pct(v.realised7d)}`, 17)}${pad(fmtUsdc(v.tvl), 15)}${pad(fmtUsdc(v.exitLiquidity), 16)}${v.depositsTo}`);
    }
  }
  if (r.ranking?.length) {
    out.push("", bold(`For ${fmtUsdc(r.amount)} USDC`));
    for (const x of r.ranking) out.push(`  ${x.eligible ? green("✓") : red("✗")} ${pad(x.name, 32)}${x.apyAfter != null ? `${pct(x.apyNow)} → ${bold(pct(x.apyAfter))} after` : ""}${x.eligible ? "" : `  ${dim(x.why)}`}`);
  }
  if (r.positions?.length) {
    out.push("", bold("Positions"));
    for (const p of r.positions) out.push(p.known ? `  ${pad(p.name, 34)}${pad(fmtUsdc(p.assets), 16)}${pad(pct(p.apy), 9)}can leave now ${fmtUsdc(p.withdrawableNow)}` : `  ${pad(p.name, 34)}${red("unknown")}  ${dim(p.reason)}`);
  }
  out.push("", bold("Why"));
  for (const l of r.explanation ?? []) out.push(`  • ${l}`);
  if (r.txs?.length) {
    out.push("", bold("Unsigned transactions") + dim("  (sign them in your wallet; this agent never signs)"));
    for (const [i, t] of r.txs.entries()) {
      out.push(`  ${i + 1}. ${t.label}  ${t.simulation ? (t.simulation.ok ? green("simulated ✓") : red(`simulation ✗ ${t.simulation.reason}`)) : ""}`);
      out.push(dim(`     ${t.call} → ${t.tx.to}`), dim(`     ${t.cast}`));
    }
  }
  if (r.blockers?.length) out.push("", red(bold("Blocked: ")) + r.blockers.join("; "));
  if (r.venues) out.push("", dim(r.venues.map((v) => `${v.name}: ${explorerAddress(v.address)}`).join("\n")));
  return out.join("\n");
}
