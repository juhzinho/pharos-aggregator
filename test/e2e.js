// End-to-end, live on Pharos Pacific Mainnet (read-only: nothing is signed or sent), plus the fork loop.
//   npm run test:e2e            (mainnet cases)        npm run test:e2e -- --fork   (also the Anvil fork loop)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ask } from "../lib/ask.js";

const W = "0xD27Cb53f5920D484261CC14d32094d3f043265C9";
const U = (n) => BigInt(n) * 1_000_000n;
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}
const ids = (r) => r.venues.map((v) => `${v.id}:${v.status}`).join(" ");

await check("rates: every venue read at one block, model matches chain, best = highest net APY", async () => {
  const r = await ask("What are the best rates?");
  assert.equal(r.venues.length, 3, ids(r));
  assert.ok(r.venues.every((v) => v.status === "ok" && v.block === r.block.number), ids(r));
  assert.ok(r.venues.every((v) => v.check.ok), "model ↔ chain check");
  const best = [...r.venues].sort((a, b) => b.apy - a.apy)[0];
  assert.equal(r.decision.venue, best.id);
});

await check("deposit 10k: routed to the highest rate AFTER the deposit, approve + deposit simulated", async () => {
  const r = await ask("Deposit 10,000 USDC");
  assert.equal(r.outcome, "prepared", r.summary);
  const eligible = r.ranking.filter((x) => x.eligible).sort((a, b) => b.apyAfter - a.apyAfter);
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].venue, eligible[0].venue);
  assert.equal(r.txs.length, 2);
  assert.ok(r.txs.every((t) => t.simulation?.ok), "simulations");
  assert.ok(r.txs.every((t) => t.tx.chainId === 1672 && t.tx.type === "0x2"));
});

await check("deposit 10M: a vault cap is found by simulation and the amount is split across venues", async () => {
  const r = await ask("Where should I put 10m USDC?");
  assert.equal(r.outcome, "prepared", r.summary);
  assert.ok(r.plan.length >= 2, "split");
  assert.equal(r.plan.reduce((t, l) => t + BigInt(l.amount), 0n), U(10_000_000), "legs add up exactly");
  for (const l of r.plan) {
    const x = r.ranking.find((y) => y.venue === l.venue);
    if (x.partialOk) assert.ok(BigInt(l.amount) <= BigInt(x.room), `${l.venue} leg within its cap`);
  }
  assert.ok(r.txs.filter((t) => t.label.startsWith("Deposit")).every((t) => t.simulation.ok));
});

await check("positions: a real wallet's positions in several venues", async () => {
  const r = await ask(`Positions of ${W}`);
  const held = r.positions.filter((p) => p.known && BigInt(p.assets) > 0n);
  assert.ok(held.length >= 2, "positions in ≥ 2 venues");
  assert.equal(BigInt(r.total), held.reduce((t, p) => t + BigInt(p.assets), 0n));
  for (const p of held) assert.ok(BigInt(p.withdrawableNow) <= BigInt(p.assets));
});

await check("withdraw 100k: lowest-paying first, bounded by free liquidity, partial when liquidity is short", async () => {
  const r = await ask(`Withdraw 100,000 USDC from ${W}`);
  const legs = r.plan.map((l) => r.holdings.find((h) => h.venue === l.venue));
  for (let i = 1; i < legs.length; i++) assert.ok(legs[i - 1].apy <= legs[i].apy, "ordered by APY");
  for (const l of r.plan) assert.ok(BigInt(l.amount) <= BigInt(r.holdings.find((h) => h.venue === l.venue).withdrawable));
  const free = r.holdings.filter((h) => h.known).reduce((t, h) => t + BigInt(h.withdrawable), 0n);
  assert.equal(BigInt(r.covered), free < U(100_000) ? free : U(100_000));
  assert.equal(r.outcome, free < U(100_000) ? "partial" : "prepared");
  assert.ok(r.txs.every((t) => t.simulation.ok), "each withdrawal simulated from the wallet");
});

await check("one venue down: reported, left out, the others route normally", async () => {
  const r = await ask("Deposit 10,000 USDC", { faults: { rockawayx: "down" } });
  const rock = r.venues.find((v) => v.id === "rockawayx");
  assert.equal(rock.status, "down");
  assert.equal(rock.injected, "down");
  assert.ok(r.venues.filter((v) => v.id !== "rockawayx").every((v) => v.status === "ok"), ids(r));
  assert.equal(r.outcome, "prepared");
  assert.ok(!r.plan.some((l) => l.venue === "rockawayx"));
});

await check("one venue hangs: cut off at its deadline, the others are unaffected", async () => {
  const r = await ask("What are the best rates?", { faults: { avalon: "slow" } });
  assert.equal(r.venues.find((v) => v.id === "avalon").status, "down");
  assert.match(r.venues.find((v) => v.id === "avalon").reason, /no answer within/);
  assert.equal(r.venues.filter((v) => v.status === "ok").length, 2);
  assert.equal(r.outcome, "answered");
});

await check("a wallet without enough USDC is blocked, with the reason", async () => {
  const r = await ask(`Deposit 5,000,000 USDC for ${W}`);
  assert.equal(r.outcome, "blocked");
  assert.ok(r.blockers.some((b) => /wallet holds/.test(b)), r.blockers.join("; "));
});

await check("requests that would move funds without the facts are refused", async () => {
  assert.equal((await ask("withdraw 50 usdc")).outcome, "refused");
  assert.equal((await ask("deposit usdc")).outcome, "refused");
  assert.equal((await ask("deposit 1.234,5 USDC")).outcome, "refused");
});

if (process.argv.includes("--fork")) {
  await check("fork loop: prepared deposit + withdrawal sent and verified; a real Avalon pause is handled", async () => {
    execFileSync(process.execPath, ["scripts/fork-loop.js"], { stdio: "inherit" });
    const r = JSON.parse(await readFile(new URL("../public/runs/fork-loop.json", import.meta.url), "utf8"));
    for (const s of [r.steps[0].report, r.steps[1].report, r.steps[2].positions]) assert.ok(s.venues.every((v) => v.status !== "down"), "every venue read on the fork");
    const best = r.steps[0].report.ranking.filter((x) => x.eligible).sort((a, b) => b.apyAfter - a.apyAfter)[0];
    assert.equal(r.steps[0].report.plan[0].venue, best.venue, "deposit routed to the best venue");
    assert.equal(r.steps[0].verify.outcome, "success");
    assert.equal(r.steps[1].verify.outcome, "success");
    const p = r.steps[2];
    assert.equal(p.positions.venues.find((v) => v.id === "avalon").status, "paused");
    assert.ok(p.positions.positions.find((x) => x.venue === "avalon").locked, "Avalon position shown as locked");
    assert.ok(!p.deposit.plan.some((l) => l.venue === "avalon"));
    assert.ok(!p.withdraw.plan.some((l) => l.venue === "avalon"));
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
