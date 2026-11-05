import { decodeEventLog, getAddress, parseAbi } from "viem";
import { USDC } from "./contracts.js";

// After a prepared plan is signed and mined: did exactly what was planned happen? Checked from the receipts' own
// events (exact amounts) and from the wallet's USDC balance before/after (exact delta).

const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
]);

function decode(log) {
  try {
    return { address: getAddress(log.address), ...decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics }) };
  } catch {
    return null;
  }
}

const eq = (a, b) => getAddress(a) === getAddress(b);

/**
 * @param report  the deposit/withdraw report that prepared the transactions
 * @param receipts their receipts, in order
 * @param usdcBefore/usdcAfter the wallet's USDC balance around the plan
 */
export function verifyPlan({ report, receipts, usdcBefore, usdcAfter, venues }) {
  const user = report.user;
  const checks = [];
  const add = (label, ok, expected, observed) => checks.push({ label, ok, expected: String(expected), observed: String(observed) });

  receipts.forEach((r, i) => add(`tx ${i + 1} mined`, r.status === "success", "success", r.status));
  const events = receipts.flatMap((r) => r.logs.map(decode).filter(Boolean));

  for (const leg of report.plan) {
    const v = venues.find((x) => x.id === leg.venue);
    const amount = BigInt(leg.amount);
    if (report.kind === "deposit") {
      const ev = v.kind === "aave-v3" ? events.find((e) => e.eventName === "Supply" && eq(e.address, v.address) && eq(e.args.onBehalfOf, user)) : events.find((e) => e.eventName === "Deposit" && eq(e.address, v.address) && eq(e.args.owner, user));
      const got = ev ? (v.kind === "aave-v3" ? ev.args.amount : ev.args.assets) : null;
      add(`${v.name}: deposit event`, got === amount, amount, got ?? "none");
      const into = v.kind === "aave-v3" ? v.aToken : v.address;
      const t = events.find((e) => e.eventName === "Transfer" && eq(e.address, USDC.address) && eq(e.args.from, user) && eq(e.args.to, into));
      add(`${v.name}: USDC moved from the wallet`, t?.args.value === amount, amount, t?.args.value ?? "none");
    } else {
      const ev = v.kind === "aave-v3" ? events.find((e) => e.eventName === "Withdraw" && eq(e.address, v.address) && e.args.reserve && eq(e.args.user, user)) : events.find((e) => e.eventName === "Withdraw" && eq(e.address, v.address) && e.args.owner && eq(e.args.owner, user));
      const got = ev ? (v.kind === "aave-v3" ? ev.args.amount : ev.args.assets) : null;
      // a whole-position exit (redeem / type(uint256).max) also pays the interest accrued since the plan was made
      const ok = got != null && (leg.full ? got >= amount : got === amount);
      add(`${v.name}: withdraw event`, ok, leg.full ? `≥ ${amount} (whole position)` : amount, got ?? "none");
    }
  }
  const delta = usdcAfter - usdcBefore;
  const planned = report.plan.reduce((t, l) => t + BigInt(l.amount), 0n);
  if (report.kind === "deposit") add("wallet USDC change", delta === -planned, -planned, delta);
  else {
    const full = report.plan.some((l) => l.full);
    add("wallet USDC change", full ? delta >= planned : delta === planned, full ? `≥ ${planned}` : planned, delta);
  }
  const ok = checks.every((c) => c.ok);
  return { outcome: ok ? "success" : "failure", checks, summary: ok ? `Verified on chain: ${report.kind} of ${Number(planned) / 1e6} USDC happened exactly as planned.` : `Does NOT match the plan: ${checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}.` };
}
