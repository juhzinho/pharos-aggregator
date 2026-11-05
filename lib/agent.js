import { getAddress } from "viem";
import { ABI, USDC, VENUES } from "./contracts.js";
import { fmtUsdc, makeClient, pct, pinBlocks, withTimeout } from "./chain.js";
import { morphoVault } from "./venues/morpho.js";
import { avalonMarket } from "./venues/avalon.js";
import { PROBE, approveCall, feesAt, simulate, unsignedTx, usdcOverride } from "./prepare.js";

// One interface over every venue: survey (rates + state, all at one block) → route (best venue for this request,
// with the reason) → prepare (unsigned, simulated transactions). A venue that fails is reported and left out;
// it never stops the others.

export const ROUTING = {
  // read when used, not at import, so a caller (e.g. the fork script) can raise it: a fork fetching history is slower
  get venueTimeoutMs() {
    return Number(process.env.PHAROS_VENUE_TIMEOUT_MS ?? 20_000);
  },
  splitMinGain: 0.0005, // a split must beat the best single venue by ≥ 0.05 percentage points…
  splitMinUsdPerYear: 5, // …and ≥ $5 a year, or the extra transactions are not worth it
};

export const buildVenues = (list = VENUES) => list.map((c) => (c.kind === "aave-v3" ? avalonMarket(c) : morphoVault(c)));

/** The root cause, not viem's wrapper ("An unknown error occurred while executing…"). */
export function shortErr(e) {
  let c = e;
  while (c?.cause && c.cause !== c) c = c.cause;
  const msg = c?.details || c?.shortMessage || c?.message || e?.shortMessage || e?.message || String(e);
  return String(msg).split("\n")[0].slice(0, 180);
}
const usd = (raw) => Number(raw) / 1e6;

/** Reads every venue at the same block, each with its own client and deadline. */
export async function survey({ faults = {}, list } = {}) {
  const main = makeClient();
  let block;
  try {
    block = await pinBlocks(main);
  } catch (e) {
    throw new Error(`Pharos Pacific RPC unreachable: ${shortErr(e)}`);
  }
  const at = { number: block.number, timestamp: block.timestamp };
  const rows = await Promise.all(
    buildVenues(list).map(async (v) => {
      const ctx = { client: makeClient({ fault: faults[v.id] }), block: at, past: block };
      const t0 = Date.now();
      try {
        const snap = await withTimeout(v.snapshot(ctx), ROUTING.venueTimeoutMs, v.name);
        // paused: the protocol itself refuses deposits and withdrawals (read on chain, e.g. an Aave reserve pause)
        const status = !snap.accepts.deposit && !snap.accepts.withdraw ? "paused" : snap.check.ok ? "ok" : "degraded";
        return { v, ctx, snap, status, ms: Date.now() - t0, injected: faults[v.id] ?? null };
      } catch (e) {
        return { v, ctx, snap: null, status: "down", reason: shortErr(e), ms: Date.now() - t0, injected: faults[v.id] ?? null };
      }
    }),
  );
  return { block, main, rows };
}

/** A venue as the report shows it (no internal model state). */
export function publicVenue(r) {
  const base = { id: r.v.id, name: r.v.name, protocol: r.v.protocol, address: r.v.address, status: r.status, ms: r.ms, injected: r.injected };
  if (!r.snap) return { ...base, reason: r.reason };
  const { _model, ...snap } = r.snap;
  return { ...base, ...snap, ...(r.status === "degraded" ? { reason: `rate model disagrees with the chain (model ${pct(snap.check.model)} vs ${pct(snap.check.chain)})` } : r.status === "paused" ? { reason: snap.notes.find((n) => /paused|not active/.test(n)) ?? "paused by the protocol" } : {}) };
}

const blockInfo = (b) => ({ number: Number(b.number), timestamp: b.timestamp });
const outageLines = (rows) =>
  rows.filter((r) => r.status !== "ok").map((r) => `${r.v.name} is ${r.status}${r.injected ? " (injected for the demo)" : ""}: ${r.status === "down" ? r.reason : publicVenue(r).reason} — left out; the other venues are unaffected.`);

// ───────────────────────────── queries ─────────────────────────────

export async function rates({ faults } = {}) {
  const s = await survey({ faults });
  const live = s.rows.filter((r) => r.status === "ok" && r.snap.accepts.deposit).sort((a, b) => b.snap.apy - a.snap.apy);
  const best = live[0];
  const explanation = [];
  if (best) {
    explanation.push(`${best.v.name} pays the most right now: ${pct(best.snap.apy)} net (realised ${pct(best.snap.realised1d)} over the last day, ${pct(best.snap.realised7d)} over 7 days).`);
    if (live[1]) explanation.push(`Next: ${live[1].v.name} at ${pct(live[1].snap.apy)} (${((best.snap.apy - live[1].snap.apy) * 100).toFixed(2)} pp less).`);
    explanation.push("Rates are rebuilt from each venue's own contracts at one block and checked against what the venue actually paid; ask with an amount to see the rate after your deposit.");
  } else explanation.push("No venue can take deposits right now.");
  explanation.push(...outageLines(s.rows));
  return { kind: "rates", block: blockInfo(s.block), venues: s.rows.map(publicVenue).sort((a, b) => (b.apy ?? -1) - (a.apy ?? -1)), decision: best ? { venue: best.v.id } : null, outcome: best ? "answered" : "blocked", summary: best ? `Best rate: ${best.v.name}, ${pct(best.snap.apy)} net.` : "No venue available.", explanation };
}

async function walletState(s, user) {
  const [usdc, pros, nonce, allowances] = await Promise.all([
    s.main.readContract({ address: USDC.address, abi: ABI.erc20, functionName: "balanceOf", args: [user], blockNumber: s.block.number }),
    s.main.getBalance({ address: user, blockNumber: s.block.number }),
    s.main.getTransactionCount({ address: user, blockNumber: s.block.number }),
    Promise.all(s.rows.map((r) => s.main.readContract({ address: USDC.address, abi: ABI.erc20, functionName: "allowance", args: [user, r.v.spender], blockNumber: s.block.number }).catch(() => 0n))),
  ]);
  return { address: user, usdc, pros, nonce, allowance: Object.fromEntries(s.rows.map((r, i) => [r.v.id, allowances[i]])) };
}

const publicWallet = (w) => w && { address: w.address, usdc: w.usdc.toString(), pros: w.pros.toString(), nonce: w.nonce };

export async function positions(user, { faults } = {}) {
  user = getAddress(user);
  const s = await survey({ faults });
  const wallet = await walletState(s, user);
  const rows = await Promise.all(
    s.rows.map(async (r) => {
      if (r.status === "down") return { venue: r.v.id, name: r.v.name, known: false, reason: r.reason };
      try {
        const p = await withTimeout(r.v.position(r.ctx, user), ROUTING.venueTimeoutMs, r.v.name);
        const assets = BigInt(p.assets);
        const exit = BigInt(r.snap.exitLiquidity);
        const can = !r.snap.accepts.withdraw ? 0n : assets < exit ? assets : exit; // a paused venue releases nothing
        return { venue: r.v.id, name: r.v.name, known: true, ...p, apy: r.snap.apy, perYear: usd(assets) * r.snap.apy, withdrawableNow: can.toString(), ...(r.snap.accepts.withdraw ? {} : { locked: publicVenue(r).reason ?? r.snap.notes[0] }) };
      } catch (e) {
        return { venue: r.v.id, name: r.v.name, known: false, reason: shortErr(e) };
      }
    }),
  );
  const held = rows.filter((p) => p.known && BigInt(p.assets) > 0n);
  const total = held.reduce((t, p) => t + BigInt(p.assets), 0n);
  const explanation = held.length ? held.map((p) => `${p.name}: ${fmtUsdc(p.assets)} USDC at ${pct(p.apy)} → ~$${p.perYear.toFixed(0)}/yr; ${p.locked ? `locked — ${p.locked}` : `${fmtUsdc(p.withdrawableNow)} withdrawable right now`}.`) : ["No positions in the venues that could be read."];

  // Same money, better venue: what moving the lowest-rate position to the best open venue would add.
  const live = s.rows.filter((r) => r.status === "ok" && r.snap.accepts.deposit).sort((a, b) => b.snap.apy - a.snap.apy);
  const worst = [...held].sort((a, b) => a.apy - b.apy)[0];
  let insight = null;
  if (worst && live[0] && live[0].v.id !== worst.venue && live[0].snap.apy - worst.apy > 0.005) {
    const move = BigInt(worst.withdrawableNow);
    if (move > 0n) {
      const after = await live[0].v.apyAfter(live[0].ctx, live[0].snap, move).catch(() => null);
      // only worth saying if it is worth doing: ≥ $1 a year more
      if (after != null && after > worst.apy && usd(move) * (after - worst.apy) >= 1) insight = { from: worst.venue, to: live[0].v.id, amount: move.toString(), gainPerYear: usd(move) * (after - worst.apy), apyFrom: worst.apy, apyTo: after };
    }
  }
  if (insight) explanation.push(`Moving ${fmtUsdc(insight.amount)} USDC (what can leave ${rows.find((p) => p.venue === insight.from).name} now) to ${live[0].v.name} would earn ~$${insight.gainPerYear.toFixed(0)}/yr more (${pct(insight.apyFrom)} → ${pct(insight.apyTo)} after the move).`);
  const unknown = rows.filter((p) => !p.known);
  if (unknown.length) explanation.push(`Not included: ${unknown.map((p) => p.name).join(", ")} could not be read, so any position there is unknown (not zero).`);
  explanation.push(...outageLines(s.rows));
  return { kind: "positions", user, block: blockInfo(s.block), wallet: publicWallet(wallet), venues: s.rows.map(publicVenue), positions: rows, total: total.toString(), insight, outcome: "answered", summary: `${fmtUsdc(total)} USDC across ${held.length} venue${held.length === 1 ? "" : "s"}${unknown.length ? ` (+${unknown.length} unreadable)` : ""}, ${fmtUsdc(wallet.usdc)} USDC idle in the wallet.`, explanation };
}

// ───────────────────────────── actions ─────────────────────────────

/** Simulates the deposit of `amount` into a venue for `from`, overriding only what the plan itself provides. */
async function simulateDeposit(r, s, from, amount, wallet, { gas = true } = {}) {
  const needBalance = !wallet || wallet.usdc < amount;
  const needAllowance = !wallet || wallet.allowance[r.v.id] < amount;
  const stateOverride = usdcOverride({ owner: from, spender: r.v.spender, balance: needBalance ? amount : null, allowance: needAllowance ? amount : null });
  const sim = await simulate(r.ctx.client, s.block.number, { from, call: r.v.depositCall(amount, from), stateOverride, gas });
  return { ...sim, overrides: [needBalance && "balance", needAllowance && "allowance (the approve before it)"].filter(Boolean) };
}

export async function deposit(amountRaw, user, { faults } = {}) {
  const amount = BigInt(amountRaw);
  if (amount <= 0n) throw new Error("amount must be positive");
  user = user ? getAddress(user) : null;
  const s = await survey({ faults });
  const wallet = user ? await walletState(s, user) : null;
  const from = user ?? PROBE;

  // 1. score every venue for THIS amount
  const scored = await Promise.all(
    s.rows.map(async (r) => {
      const out = { venue: r.v.id, name: r.v.name, status: r.status };
      if (r.status === "down") return { ...out, eligible: false, why: `unavailable: ${r.reason}` };
      if (r.status === "degraded" || r.status === "paused") return { ...out, eligible: false, why: publicVenue(r).reason };
      if (!r.snap.accepts.deposit) return { ...out, eligible: false, why: r.snap.notes[0] ?? "not accepting deposits" };
      const room = r.snap.depositRoom == null ? null : BigInt(r.snap.depositRoom);
      const [after, sim] = await Promise.all([r.v.apyAfter(r.ctx, r.snap, amount).catch(() => null), room != null && amount > room ? null : simulateDeposit(r, s, from, amount, wallet)]);
      const base = { ...out, apyNow: r.snap.apy, apyAfter: after, depositsTo: r.snap.depositsTo, // your own deposit adds to the free liquidity in every venue type (reserve cash, liquidity market, or idle)
        exitAfter: (BigInt(r.snap.exitLiquidity) + amount).toString(), room: room?.toString() ?? null };
      if (after == null) return { ...base, eligible: false, why: "could not compute the rate after this deposit" };
      if (room != null && amount > room) return { ...base, eligible: false, partialOk: room > 0n, why: `supply cap: only ${fmtUsdc(room)} USDC of room left` };
      if (!sim.ok) {
        if (/CapExceeded/.test(sim.reason)) {
          // A Vault V2 cap: find, by simulation, how much this vault does accept right now — it can still take part.
          const max = await discoverCap(r, s, from, amount, wallet);
          return { ...base, eligible: false, partialOk: max > 0n, room: max.toString(), why: `${sim.reason}: takes at most ~${fmtUsdc(max)} USDC right now (found by simulation)` };
        }
        return { ...base, eligible: false, why: `deposit simulation reverts: ${sim.reason}` };
      }
      return { ...base, eligible: true, gas: sim.gas.toString(), overrides: sim.overrides };
    }),
  );
  const ranked = scored.filter((x) => x.eligible).sort((a, b) => b.apyAfter - a.apyAfter);
  const explanation = [];
  const venuesOut = s.rows.map(publicVenue);
  const best = ranked[0] ?? null;

  // 2. split? Either it earns meaningfully more (a big deposit pushes a venue's own rate down), or it is the only
  //    way to place the amount (no single venue can take all of it).
  const split = await bestSplit(s, scored, amount);
  const gain = split && best ? split.apy - best.apyAfter : null;
  const useSplit = split && split.legs.length > 1 && (!best || (gain >= ROUTING.splitMinGain && usd(amount) * gain >= ROUTING.splitMinUsdPerYear));
  let legs = useSplit ? split.legs : best ? [{ venue: best.venue, amount, apyAfter: best.apyAfter }] : [];
  if (useSplit) {
    // every leg is simulated at its own size; any failure → fall back to the single best venue (if there is one)
    const sims = await Promise.all(legs.map((l) => simulateDeposit(s.rows.find((r) => r.v.id === l.venue), s, from, l.amount, wallet)));
    if (sims.some((x) => !x.ok)) legs = best ? [{ venue: best.venue, amount, apyAfter: best.apyAfter }] : [];
  }
  if (!legs.length) {
    const room = scored.filter((x) => x.partialOk).reduce((t, x) => t + BigInt(x.room), 0n);
    explanation.push(`No venue — or mix of venues — can take ${fmtUsdc(amount)} USDC right now${room > 0n ? `; together they take at most ~${fmtUsdc(room)} USDC` : ""}.`, ...scored.map((x) => `${x.name}: ${x.why}`), ...outageLines(s.rows));
    return { kind: "deposit", amount: amount.toString(), user, block: blockInfo(s.block), wallet: publicWallet(wallet), venues: venuesOut, ranking: scored, plan: [], txs: [], outcome: "blocked", summary: `Blocked: no venue can take ${fmtUsdc(amount)} USDC right now.`, explanation };
  }

  // 3. prepare: approve (only if the allowance is short) + deposit, per leg
  const fees = await feesAt(s.main, s.block.number);
  const txs = [];
  let nonce = wallet?.nonce ?? null;
  for (const l of legs) {
    const r = s.rows.find((x) => x.v.id === l.venue);
    if (!wallet || wallet.allowance[r.v.id] < l.amount) {
      const a = await simulate(s.main, s.block.number, { from, call: approveCall(r.v.spender, l.amount) });
      txs.push({ ...unsignedTx({ from, call: approveCall(r.v.spender, l.amount), gas: a.ok ? a.gas : 60_000n, nonce, fees, label: `Approve ${fmtUsdc(l.amount)} USDC for ${r.v.name}` }), simulation: a.ok ? { ok: true, overrides: [] } : { ok: false, reason: a.reason } });
      if (nonce != null) nonce++;
    }
    const sim = await simulateDeposit(r, s, from, l.amount, wallet);
    txs.push({ ...unsignedTx({ from, call: r.v.depositCall(l.amount, from), gas: sim.ok ? sim.gas : 500_000n, nonce, fees, label: `Deposit ${fmtUsdc(l.amount)} USDC into ${r.v.name}` }), simulation: sim.ok ? { ok: true, overrides: sim.overrides } : { ok: false, reason: sim.reason } });
    if (nonce != null) nonce++;
  }
  const gasCost = txs.reduce((t, x) => t + BigInt(x.tx.gas) * BigInt(x.tx.maxFeePerGas), 0n);

  // 4. checks: every prepared tx must simulate; the wallet (when given) must hold the USDC and the gas
  const blockers = [];
  const failed = txs.find((x) => x.simulation && !x.simulation.ok);
  if (failed) blockers.push(`“${failed.label}” fails in simulation: ${failed.simulation.reason}`);
  if (wallet && wallet.usdc < amount) blockers.push(`the wallet holds ${fmtUsdc(wallet.usdc)} USDC, less than ${fmtUsdc(amount)}`);
  if (wallet && wallet.pros < gasCost) blockers.push(`the wallet holds ${(Number(wallet.pros) / 1e18).toFixed(4)} PROS, gas needs up to ${(Number(gasCost) / 1e18).toFixed(4)} PROS`);

  // 5. the why
  if (legs.length === 1) {
    explanation.push(`${best.name}: ${pct(best.apyAfter)} net after your ${fmtUsdc(amount)} USDC (now ${pct(best.apyNow)}) — the highest rate after the deposit among venues that can take it.`);
    if (ranked[1]) explanation.push(`It beats ${ranked[1].name} (${pct(ranked[1].apyAfter)} after) by ${((best.apyAfter - ranked[1].apyAfter) * 100).toFixed(2)} pp, ~$${(usd(amount) * (best.apyAfter - ranked[1].apyAfter)).toFixed(0)} a year.`);
    if (split && split.legs.length > 1 && !useSplit) explanation.push(`Splitting would add only ${(gain * 100).toFixed(3)} pp — not worth the extra transactions.`);
  } else {
    explanation.push(`Split: ${legs.map((l) => `${fmtUsdc(l.amount)} → ${scored.find((x) => x.venue === l.venue).name} (${pct(l.apyAfter)})`).join(", ")} = ${pct(split.apy)} blended.`);
    if (best) explanation.push(`One venue alone would pay ${pct(best.apyAfter)} (${best.name}): a deposit this size pushes its own rate down, so splitting earns ${(gain * 100).toFixed(2)} pp more, ~$${(usd(amount) * gain).toFixed(0)} a year.`);
    else explanation.push(`No single venue can take ${fmtUsdc(amount)} USDC right now, so each takes what it can, best rate first.`);
  }
  explanation.push(`Where it goes: ${legs.map((l) => `${scored.find((x) => x.venue === l.venue).name} → ${scored.find((x) => x.venue === l.venue).depositsTo}`).join("; ")}.`);
  for (const l of legs) {
    const r = s.rows.find((x) => x.v.id === l.venue);
    if (!r.snap.liquidityMarket && r.snap.kind === "morpho-vault-v2") explanation.push(`${r.v.name} has no liquidity adapter: the USDC waits idle until its curator allocates it.`);
  }
  for (const x of scored.filter((x) => !x.eligible && x.status === "ok")) explanation.push(legs.some((l) => l.venue === x.venue) ? `${x.name} cannot take it all — ${x.why} — so it takes a part.` : x.partialOk ? `${x.name} not used: ${x.why}; at the size it can take, it pays less than the venues chosen.` : `${x.name} not used: ${x.why}.`);
  explanation.push(...outageLines(s.rows));
  explanation.push(`Rates rebuilt from on-chain state at block ${s.block.number} and checked against what each venue paid; every transaction simulated${user ? ` for ${user}` : " (no wallet given: a probe address with overridden USDC balance)"}. Nothing is signed.`);

  return {
    kind: "deposit",
    amount: amount.toString(),
    user,
    block: blockInfo(s.block),
    wallet: publicWallet(wallet),
    venues: venuesOut,
    ranking: scored.sort((a, b) => (b.apyAfter ?? -1) - (a.apyAfter ?? -1)),
    split: split && { apy: split.apy, legs: split.legs.map((l) => ({ venue: l.venue, amount: l.amount.toString(), apyAfter: l.apyAfter })), used: legs.length > 1 },
    plan: legs.map((l) => ({ venue: l.venue, amount: l.amount.toString(), apyAfter: l.apyAfter })),
    txs,
    gasCost: gasCost.toString(),
    blockers,
    outcome: blockers.length ? "blocked" : "prepared",
    summary: blockers.length ? `Route found, but blocked: ${blockers.join("; ")}.` : legs.length === 1 ? `Deposit into ${best.name} at ${pct(best.apyAfter)} net — ${txs.length} unsigned transaction${txs.length > 1 ? "s" : ""} ready.` : `Split across ${legs.length} venues at ${pct(split.apy)} net — ${txs.length} unsigned transactions ready.`,
    explanation,
  };
}

/** Largest deposit a venue accepts right now (≤ amount), by bisecting the deposit simulation. */
async function discoverCap(r, s, from, amount, wallet) {
  const tolerance = amount / 1000n > 1_000_000n ? amount / 1000n : 1_000_000n; // 0.1 % of the amount, ≥ 1 USDC
  let lo = 0n;
  let hi = amount;
  while (hi - lo > tolerance) {
    const mid = (lo + hi) / 2n;
    const sim = await simulateDeposit(r, s, from, mid, wallet, { gas: false });
    if (sim.ok) lo = mid;
    else hi = mid;
  }
  return lo - (lo % 1_000_000n); // whole USDC, on the accepted side
}

/** Linear interpolation of a sampled rate curve [[amount, apy], …] (sorted by amount). */
export function interpolate(points, x) {
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * Number(x - x0)) / Number(x1 - x0);
    }
  }
  return points.at(-1)[1];
}

/**
 * Best allocation of `amount` across venues. Each venue's rate-after-deposit curve is sampled with its own
 * contracts (10 points up to what it accepts), the allocation is searched in 1 % steps (plus each venue's exact cap)
 * on those curves, and the chosen legs are then recomputed exactly. Returns null if no mix places the full amount.
 */
export async function bestSplit(s, scored, amount) {
  const pool = scored.filter((x) => (x.eligible || x.partialOk) && x.apyAfter != null);
  if (pool.length < 2) return null;
  const row = (id) => s.rows.find((r) => r.v.id === id);
  const curves = await Promise.all(
    pool.map(async (x) => {
      const r = row(x.venue);
      const cap = x.eligible ? amount : BigInt(x.room);
      const pts = [...new Set([...Array.from({ length: 10 }, (_, i) => (amount * BigInt(i + 1)) / 10n).filter((p) => p <= cap), cap])].sort((a, b) => (a < b ? -1 : 1));
      const sampled = await Promise.all(pts.map(async (p) => [p, await r.v.apyAfter(r.ctx, r.snap, p).catch(() => null)]));
      return { id: x.venue, r, cap, points: [[0n, r.snap.apy], ...sampled.filter(([, a]) => a != null)] };
    }),
  );
  const unit = amount / 100n;
  const options = (c) => {
    const o = [0n];
    for (let k = 1n; k <= 100n && unit * k <= c.cap; k++) o.push(unit * k);
    if (c.cap < amount && !o.includes(c.cap)) o.push(c.cap);
    return o;
  };
  let best = null;
  const walk = (i, left, alloc) => {
    const c = curves[i];
    if (i === curves.length - 1) {
      if (left > c.cap) return;
      const a = [...alloc, left];
      let earned = 0;
      a.forEach((x, k) => x > 0n && (earned += Number(x) * interpolate(curves[k].points, x)));
      const apy = earned / Number(amount);
      if (!best || apy > best.apy) best = { apy, alloc: a };
      return;
    }
    for (const o of options(c)) if (o <= left) walk(i + 1, left - o, [...alloc, o]);
  };
  walk(0, amount, []);
  if (!best) return null;
  // exact numbers for the chosen legs, from the venues' own contracts again (a read failing here drops the split,
  // it never fails the request: the single best venue still stands)
  let legs;
  try {
    legs = await Promise.all(
      best.alloc
        .map((a, i) => [a, curves[i]])
        .filter(([a]) => a > 0n)
        .map(async ([a, c]) => ({ venue: c.id, amount: a, apyAfter: await c.r.v.apyAfter(c.r.ctx, c.r.snap, a) })),
    );
  } catch {
    return null;
  }
  const apy = legs.reduce((t, l) => t + Number(l.amount) * l.apyAfter, 0) / Number(amount);
  return { apy, legs: legs.sort((a, b) => b.apyAfter - a.apyAfter) };
}

/**
 * Which positions to take `target` from: lowest-paying first (it gives up the least yield for the same cash),
 * each bounded by what can leave it right now. Withdrawing a whole position is flagged (redeem / max, no dust).
 */
export function planWithdrawal(holdings, target) {
  const legs = [];
  let left = target;
  for (const h of [...holdings].sort((a, b) => a.apy - b.apy)) {
    if (left <= 0n) break;
    const can = BigInt(h.withdrawable);
    if (can <= 0n) continue;
    const take = left < can ? left : can;
    legs.push({ venue: h.venue, amount: take, full: take >= BigInt(h.assets), pos: h.pos });
    left -= take;
  }
  return { legs, covered: target - left };
}

export async function withdraw(amountArg, user, { faults } = {}) {
  if (!user) throw new Error("a withdrawal needs the wallet address that holds the position");
  user = getAddress(user);
  const all = amountArg === "all";
  const want = all ? null : BigInt(amountArg);
  if (!all && want <= 0n) throw new Error("amount must be positive");
  const s = await survey({ faults });
  const wallet = await walletState(s, user);

  const held = await Promise.all(
    s.rows.map(async (r) => {
      const out = { venue: r.v.id, name: r.v.name, status: r.status };
      if (r.status === "down") return { ...out, known: false, why: `unavailable: ${r.reason}` };
      try {
        const p = await withTimeout(r.v.position(r.ctx, user), ROUTING.venueTimeoutMs, r.v.name);
        const exit = r.snap.accepts.withdraw ? BigInt(r.snap.exitLiquidity) : 0n; // paused: the position is real but locked
        const assets = BigInt(p.assets);
        return { ...out, known: true, pos: p, assets: p.assets, apy: r.snap.apy, exit: exit.toString(), withdrawable: (assets < exit ? assets : exit).toString(), ...(r.snap.accepts.withdraw ? {} : { locked: r.snap.notes.find((n) => /paused|not active/.test(n)) ?? "withdrawals disabled" }) };
      } catch (e) {
        return { ...out, known: false, why: `position unreadable: ${shortErr(e)}` };
      }
    }),
  );
  const holding = held.filter((h) => h.known && BigInt(h.assets) > 0n);
  const totalHeld = holding.reduce((t, h) => t + BigInt(h.assets), 0n);
  const target = all ? totalHeld : want;

  const { legs, covered } = planWithdrawal(holding, target);

  const fees = await feesAt(s.main, s.block.number);
  const txs = [];
  let nonce = wallet.nonce;
  for (const l of legs) {
    const r = s.rows.find((x) => x.v.id === l.venue);
    const call = r.v.withdrawCall(l.amount, user, l.full ? l.pos : null);
    const sim = await simulate(r.ctx.client, s.block.number, { from: user, call });
    txs.push({ ...unsignedTx({ from: user, call, gas: sim.ok ? sim.gas : 500_000n, nonce, fees, label: `Withdraw ${fmtUsdc(l.amount)} USDC from ${r.v.name}${l.full ? " (whole position)" : ""}` }), simulation: sim.ok ? { ok: true, overrides: [] } : { ok: false, reason: sim.reason } });
    nonce++;
  }
  const gasCost = txs.reduce((t, x) => t + BigInt(x.tx.gas) * BigInt(x.tx.maxFeePerGas), 0n);
  const blockers = [];
  if (txs.some((t) => !t.simulation.ok)) blockers.push(`a withdrawal simulation reverts: ${txs.find((t) => !t.simulation.ok).simulation.reason}`);
  if (txs.length && wallet.pros < gasCost) blockers.push(`the wallet holds ${(Number(wallet.pros) / 1e18).toFixed(4)} PROS, gas needs up to ${(Number(gasCost) / 1e18).toFixed(4)} PROS`);

  const explanation = [];
  const name = (id) => held.find((h) => h.venue === id).name;
  if (!holding.length) explanation.push("This wallet has no position in the venues that could be read.");
  for (const [i, l] of legs.entries()) {
    const h = held.find((x) => x.venue === l.venue);
    explanation.push(i === 0 ? `${name(l.venue)} first: of the venues that can pay out now it pays the least (${pct(h.apy)}), so taking ${fmtUsdc(l.amount)} USDC from it gives up the least yield; ${fmtUsdc(h.exit)} USDC can leave it right now.` : `Then ${name(l.venue)} (${pct(h.apy)}): ${fmtUsdc(l.amount)} USDC.`);
  }
  for (const h of holding.filter((h) => h.locked)) explanation.push(`${h.name}: ${fmtUsdc(h.assets)} USDC held but locked — ${h.locked}.`);
  for (const h of holding.filter((h) => !h.locked && BigInt(h.withdrawable) < BigInt(h.assets))) explanation.push(`${h.name}: ${fmtUsdc(h.assets)} USDC held, but only ${fmtUsdc(h.withdrawable)} can leave now (free liquidity) — the rest waits until borrowers repay or the curator reallocates.`);
  if (covered < target) explanation.push(`Only ${fmtUsdc(covered)} of ${fmtUsdc(target)} USDC can be withdrawn right now; the plan below takes all of it.`);
  for (const h of held.filter((h) => !h.known && h.status !== "down")) explanation.push(`${h.name}: ${h.why} — any position there is not counted.`);
  for (const h of held.filter((h) => h.status === "down")) explanation.push(`${h.name} could not be read, so any position there is unknown (not zero) and not part of this plan.`);
  explanation.push(...outageLines(s.rows));
  explanation.push(`Positions and liquidity read at block ${s.block.number}; each withdrawal simulated from ${user}. Nothing is signed.`);

  const outcome = blockers.length ? "blocked" : !legs.length ? "blocked" : covered < target ? "partial" : "prepared";
  return {
    kind: "withdraw",
    amount: target.toString(),
    all,
    user,
    block: blockInfo(s.block),
    wallet: publicWallet(wallet),
    venues: s.rows.map(publicVenue),
    holdings: held.map(({ pos, ...h }) => h),
    plan: legs.map((l) => ({ venue: l.venue, amount: l.amount.toString(), full: l.full })),
    covered: covered.toString(),
    txs,
    gasCost: gasCost.toString(),
    blockers,
    outcome,
    summary: outcome === "prepared" ? `Withdraw ${fmtUsdc(covered)} USDC: ${legs.map((l) => name(l.venue)).join(" + ")} — ${txs.length} unsigned transaction${txs.length > 1 ? "s" : ""} ready.` : outcome === "partial" ? `Only ${fmtUsdc(covered)} of ${fmtUsdc(target)} USDC can leave now: ${legs.map((l) => name(l.venue)).join(" + ")}.` : blockers.length ? `Blocked: ${blockers.join("; ")}.` : "Nothing to withdraw.",
    explanation,
  };
}
