// The full loop on an Anvil fork of Pacific (the agent never signs, so the fork stands in for the user's wallet):
//   1. route + prepare a 10,000 USDC deposit for a real Pacific wallet → send exactly those txs → verify
//   2. route + prepare a 5,000 USDC withdrawal → send → verify
//   3. Avalon's real pool admin pauses the USDC reserve (a genuine protocol outage, on the fork) → the agent
//      keeps routing among the others, and reports the Avalon position as locked, not zero.
// Writes public/runs/fork-loop.json.
import { writeFile } from "node:fs/promises";
import { createPublicClient, encodeFunctionData, http, parseAbi } from "viem";
import { startFork } from "../lib/fork.js";
import { ABI, USDC, VENUES } from "../lib/contracts.js";
import { verifyPlan } from "../lib/verify.js";
import { toJson } from "../lib/ask.js";

const WALLET = "0xD27Cb53f5920D484261CC14d32094d3f043265C9"; // real Pacific wallet: SharpByte + Avalon positions, idle USDC
const AVALON_ADMIN = "0xc6f56760f2F4E41095DB8269c5D8380B0fd184F4"; // PoolAddressesProvider.getACLAdmin(), a pool admin
const AVALON_CONFIGURATOR = "0x4BbD637d772c23a6f12498e7520797F45D747012"; // PoolAddressesProvider.getPoolConfigurator()

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8546) });
process.env.PHAROS_RPC_URL = fork.url; // every agent read now goes to the fork
process.env.PHAROS_VENUE_TIMEOUT_MS ??= "120000"; // Anvil fetches each historical slot from Pacific on first use
const { deposit, withdraw, positions } = await import("../lib/agent.js");
const client = createPublicClient({ transport: http(fork.url, { timeout: 60_000 }) });
const log = (m) => console.log(m);

const usdcOf = (a) => client.readContract({ address: USDC.address, abi: ABI.erc20, functionName: "balanceOf", args: [a] });
async function send(txs) {
  const receipts = [];
  for (const t of txs) {
    const { from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = t.tx;
    const hash = await client.request({ method: "eth_sendTransaction", params: [{ from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas }] });
    receipts.push(await client.waitForTransactionReceipt({ hash }));
    log(`   sent ${t.label}: ${hash.slice(0, 18)}… ${receipts.at(-1).status}`);
  }
  return receipts;
}
// The proof is only meaningful if every venue was read: a venue lost to a slow fork would change the route.
function allRead(report) {
  const lost = report.venues.filter((v) => v.status === "down" && !v.injected);
  if (lost.length) throw new Error(`venue not read on the fork: ${lost.map((v) => `${v.id} (${v.reason})`).join(", ")}`);
  return report;
}
async function execute(report) {
  allRead(report);
  const before = await usdcOf(WALLET);
  const receipts = await send(report.txs);
  const after = await usdcOf(WALLET);
  const v = verifyPlan({ report, receipts, usdcBefore: before, usdcAfter: after, venues: VENUES });
  log(`   ${v.outcome}: ${v.summary}`);
  return { hashes: receipts.map((r) => r.transactionHash), verify: v };
}

try {
  await client.request({ method: "anvil_impersonateAccount", params: [WALLET] });
  const steps = [];

  log("1. deposit 10,000 USDC");
  const dep = await deposit(10_000_000_000n, WALLET);
  log(`   ${dep.summary}`);
  steps.push({ step: "deposit", report: dep, ...(await execute(dep)) });

  log("2. withdraw 5,000 USDC");
  const wd = await withdraw(5_000_000_000n, WALLET);
  log(`   ${wd.summary}`);
  steps.push({ step: "withdraw", report: wd, ...(await execute(wd)) });

  log("3. Avalon's pool admin pauses the USDC reserve");
  await client.request({ method: "anvil_impersonateAccount", params: [AVALON_ADMIN] });
  await client.request({ method: "anvil_setBalance", params: [AVALON_ADMIN, "0x8AC7230489E80000"] });
  let pauseHash;
  for (const sig of ["function setReservePause(address asset, bool paused)", "function setReservePause(address asset, bool paused, uint40 gracePeriod)"]) {
    const abi = parseAbi([sig]);
    const args = sig.includes("uint40") ? [USDC.address, true, 0] : [USDC.address, true];
    try {
      pauseHash = await client.request({ method: "eth_sendTransaction", params: [{ from: AVALON_ADMIN, to: AVALON_CONFIGURATOR, data: encodeFunctionData({ abi, functionName: "setReservePause", args }), gas: "0x100000" }] });
      const rc = await client.waitForTransactionReceipt({ hash: pauseHash });
      if (rc.status === "success") break;
      pauseHash = null;
    } catch {
      pauseHash = null;
    }
  }
  if (!pauseHash) throw new Error("could not pause the Avalon reserve on the fork");
  log(`   paused: ${pauseHash.slice(0, 18)}…`);
  const pos = allRead(await positions(WALLET));
  log(`   positions: ${pos.summary}`);
  const dep2 = await deposit(10_000_000_000n, WALLET);
  log(`   deposit while paused: ${dep2.summary}`);
  const wd2 = await withdraw(100_000_000_000n, WALLET);
  log(`   withdraw 100,000 while paused: ${wd2.summary}`);
  steps.push({ step: "paused", pauseTx: pauseHash, positions: pos, deposit: dep2, withdraw: wd2 });

  await writeFile(new URL("../public/runs/fork-loop.json", import.meta.url), toJson({ recordedAt: new Date().toISOString(), network: "Anvil fork of Pharos Pacific", wallet: WALLET, steps }));
  log("wrote public/runs/fork-loop.json");
} finally {
  fork.stop();
}
process.exit(0);
