import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, parseAbi } from "viem";
import { parseIntent, normalizeNumber } from "../lib/intent.js";
import { supplyApy, vaultNetApy } from "../lib/venues/morpho.js";
import { decodeConfig, aprRayToApy } from "../lib/venues/avalon.js";
import { realisedApy, SECONDS_PER_YEAR } from "../lib/chain.js";
import { revertReason, usdcOverride, PROBE } from "../lib/prepare.js";
import { bestSplit, interpolate, planWithdrawal } from "../lib/agent.js";
import { verifyPlan } from "../lib/verify.js";
import { USDC, VENUES } from "../lib/contracts.js";

const U = (n) => BigInt(Math.round(n * 1e6)); // USDC → base units
const W = "0xD27Cb53f5920D484261CC14d32094d3f043265C9";
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ───────── requests ─────────
test("intent: the four operations, English and Portuguese", () => {
  assert.deepEqual(parseIntent("What are the best rates?"), { kind: "rates" });
  assert.deepEqual(parseIntent("Qual a melhor taxa?"), { kind: "rates" });
  assert.equal(parseIntent("Deposit 5,000 USDC").amount, U(5000));
  assert.equal(parseIntent(`positions of ${W.toLowerCase()}`).user, W);
  assert.deepEqual(parseIntent(`sacar tudo da carteira ${W}`), { kind: "withdraw", amount: "all", user: W });
  assert.equal(parseIntent("best rate for 50k").kind, "deposit", "a rate question with an amount is answered for that amount");
});

test("intent: amounts are read in the request's language — 5.000 is five thousand in Portuguese, five in English", () => {
  assert.equal(parseIntent("Depositar 5.000 USDC").amount, U(5000));
  assert.equal(parseIntent("depositar 2,5 USDC").amount, U(2.5));
  assert.equal(parseIntent("deposit 2.5 USDC").amount, U(2.5));
  assert.equal(parseIntent("aplicar 10 mil USDC").amount, U(10000));
  assert.equal(parseIntent("deposit 2.5k usdc").amount, U(2500));
  assert.equal(parseIntent("Where should I put 1.5m USDC?").amount, U(1_500_000));
  assert.equal(parseIntent("deposit 1,000,000 USDC").amount, U(1_000_000));
  assert.equal(normalizeNumber("1.234,5", "en"), null, "mixed separators in English are refused, not guessed");
  assert.throws(() => parseIntent("deposit 1.234,5 USDC"), /ambiguous/);
  assert.throws(() => parseIntent("deposit 0.0000001 USDC"), /6 decimals/);
});

test("regression: a negative or zero amount is refused, never read as positive", () => {
  assert.throws(() => parseIntent("deposit -5 USDC"), /positive/);
  assert.throws(() => parseIntent("withdraw −5 USDC from 0xD27Cb53f5920D484261CC14d32094d3f043265C9"), /positive/);
  assert.throws(() => parseIntent("deposit 0 USDC"), /positive/);
  assert.equal(parseIntent("deposit 0.000001 USDC").amount, 1n, "one base unit is a valid amount");
});

test("intent: anything that would move funds without the facts is refused", () => {
  assert.match(parseIntent("deposit usdc").error, /how much/);
  assert.match(parseIntent("withdraw 50 usdc").error, /wallet/);
  assert.match(parseIntent("hello").error, /not understood/);
});

// ───────── rate maths ─────────
test("Morpho market supply APY = borrow APY × utilisation × (1 − fee)", () => {
  const r = BigInt(Math.round((Math.log(1.1) / SECONDS_PER_YEAR) * 1e18)); // 10% borrow APY, per second (WAD)
  const m = { totalSupplyAssets: 1000n, totalBorrowAssets: 900n, fee: 0n };
  close(supplyApy(r, m), 0.09, 1e-9);
  close(supplyApy(r, { ...m, fee: 10n ** 17n }), 0.081, 1e-9);
  assert.equal(supplyApy(r, { ...m, totalSupplyAssets: 0n }), 0);
});

test("Vault V2 net APY: idle cash earns nothing, then the performance fee; maxRate caps growth", () => {
  const base = { allocations: [{ assets: 900n, supplyApy: 0.1 }], idle: 100n, performanceFee: 15n * 10n ** 16n, managementFee: 0n, maxRate: 0n };
  const v = vaultNetApy(base);
  close(v.gross, 0.09);
  close(v.net, 0.0765);
  const cap = BigInt(Math.round((0.05 / SECONDS_PER_YEAR) * 1e18));
  close(vaultNetApy({ ...base, maxRate: cap }).gross, 0.05, 1e-6);
  // a deposit that stays idle dilutes the rate: 1000 more idle → half the gross
  close(vaultNetApy({ ...base, idle: 1100n }).gross, 0.045);
});

test("Aave: reserve configuration bits and APR(ray) → APY", () => {
  const cfg = (6n << 48n) | (1n << 56n) | (1n << 60n) | (4500n << 64n) | (1_000_000n << 116n);
  assert.deepEqual(decodeConfig(cfg), { decimals: 6, active: true, frozen: false, paused: true, reserveFactor: 4500n, supplyCap: 1_000_000n });
  close(aprRayToApy(5n * 10n ** 25n), Math.pow(1 + 0.05 / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1);
});

test("realised APY compounds the index change to a year", () => {
  close(realisedApy(101n * 10n ** 16n, 10n ** 18n, SECONDS_PER_YEAR / 12), Math.pow(1.01, 12) - 1, 1e-12);
  assert.equal(realisedApy(1n, 0n, 100), null);
});

// ───────── simulation helpers ─────────
test("USDC state override sets only what the plan provides", () => {
  const o = usdcOverride({ owner: PROBE, spender: VENUES[0].address, balance: 5n, allowance: null });
  assert.equal(o[0].address, USDC.address);
  assert.equal(o[0].stateDiff.length, 1);
  assert.equal(usdcOverride({ owner: PROBE, spender: VENUES[0].address }), undefined);
});

test("revert reasons are decoded: Vault V2 caps, Aave error codes, arithmetic underflow", () => {
  const err = (data) => ({ walk: () => ({ data }) });
  assert.equal(revertReason(err(encodeErrorResult({ abi: parseAbi(["error AbsoluteCapExceeded()"]), errorName: "AbsoluteCapExceeded" }))), "AbsoluteCapExceeded");
  assert.match(revertReason(err(encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["51"] }))), /supply cap exceeded/);
  assert.match(revertReason(err(encodeErrorResult({ abi: parseAbi(["error Panic(uint256)"]), errorName: "Panic", args: [0x11n] }))), /not enough free liquidity/);
});

// ───────── routing ─────────
const fakeVenue = (id, apy, curve) => ({ v: { id, apyAfter: async (_c, _s, x) => curve(x) }, ctx: {}, snap: { apy } });
const T = U(1_000_000);

test("split: a venue whose rate falls with size shares the deposit where marginal rates meet", async () => {
  // A: 6% falling to 3% at the full amount; B: flat 4%. Optimum: A takes 1/3 → 4.33% blended vs 4% single.
  const s = { rows: [fakeVenue("a", 0.06, (x) => 0.06 - (0.03 * Number(x)) / Number(T)), fakeVenue("b", 0.04, () => 0.04)] };
  const scored = [{ venue: "a", eligible: true, apyAfter: 0.03 }, { venue: "b", eligible: true, apyAfter: 0.04 }];
  const r = await bestSplit(s, scored, T);
  const a = r.legs.find((l) => l.venue === "a").amount;
  assert.ok(a >= U(320_000) && a <= U(340_000), `A gets ~1/3, got ${a}`);
  assert.equal(r.legs.reduce((t, l) => t + l.amount, 0n), T, "legs add up to the amount exactly");
  close(r.apy, 0.04333, 2e-4);
});

test("split: a capped venue takes exactly what it accepts; with no single venue able, the mix is the plan", async () => {
  const s = { rows: [fakeVenue("a", 0.08, () => 0.08), fakeVenue("b", 0.04, () => 0.04)] };
  const capped = await bestSplit(s, [{ venue: "a", partialOk: true, room: String(U(123_456)), apyAfter: 0.08 }, { venue: "b", eligible: true, apyAfter: 0.04 }], T);
  assert.equal(capped.legs.find((l) => l.venue === "a").amount, U(123_456));
  const needed = await bestSplit(s, [{ venue: "a", partialOk: true, room: String(U(600_000)), apyAfter: 0.08 }, { venue: "b", partialOk: true, room: String(U(600_000)), apyAfter: 0.04 }], T);
  assert.deepEqual(needed.legs.map((l) => [l.venue, l.amount]), [["a", U(600_000)], ["b", U(400_000)]]);
  const impossible = await bestSplit(s, [{ venue: "a", partialOk: true, room: String(U(300_000)), apyAfter: 0.08 }, { venue: "b", partialOk: true, room: String(U(300_000)), apyAfter: 0.04 }], T);
  assert.equal(impossible, null, "no mix places the full amount → no plan");
});

test("interpolation over a sampled curve", () => {
  const pts = [[0n, 0.05], [100n, 0.03], [200n, 0.02]];
  close(interpolate(pts, 50n), 0.04);
  close(interpolate(pts, 150n), 0.025);
  close(interpolate(pts, 999n), 0.02);
});

test("withdrawal plan: lowest-paying first, bounded by what can leave now (the real 100k case)", () => {
  const holdings = [
    { venue: "sharpbyte", apy: 0.0468, withdrawable: String(U(33_637.31)), assets: String(U(678_193.61)) },
    { venue: "avalon", apy: 0.0195, withdrawable: String(U(55_015.93)), assets: String(U(250_907.88)) },
  ];
  const p = planWithdrawal(holdings, U(100_000));
  assert.deepEqual(p.legs.map((l) => [l.venue, l.amount]), [["avalon", U(55_015.93)], ["sharpbyte", U(33_637.31)]]);
  assert.equal(p.covered, U(88_653.24));
  assert.equal(planWithdrawal(holdings, U(10_000)).legs[0].full, false);
  const whole = planWithdrawal([{ venue: "x", apy: 0.05, withdrawable: "100", assets: "100" }], 100n);
  assert.equal(whole.legs[0].full, true, "a whole position is redeemed, not withdrawn, so no dust is left");
  assert.equal(planWithdrawal([{ venue: "x", apy: 0.05, withdrawable: "0", assets: "100" }], 50n).covered, 0n, "a locked position releases nothing");
});

// ───────── verification ─────────
const EV = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)"]);
const log = (address, name, args, data) => ({ address, topics: encodeEventTopics({ abi: EV, eventName: name, args }), data });
const vault = VENUES[0];
const amount = U(10_000);
const receipts = (assets) => [
  { status: "success", logs: [] },
  { status: "success", logs: [log(USDC.address, "Transfer", { from: W, to: vault.address }, encodeAbiParameters([{ type: "uint256" }], [assets])), log(vault.address, "Deposit", { sender: W, owner: W }, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [assets, 9_900n * 10n ** 18n]))] },
];
const report = { kind: "deposit", user: W, plan: [{ venue: vault.id, amount: amount.toString() }] };

test("verify: the plan that happened is a success", () => {
  const v = verifyPlan({ report, receipts: receipts(amount), usdcBefore: U(70_000), usdcAfter: U(60_000), venues: VENUES });
  assert.equal(v.outcome, "success", JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test("verify: a different amount, a failed tx or a wrong balance change is a failure, with the reason", () => {
  const wrong = verifyPlan({ report, receipts: receipts(amount - 1n), usdcBefore: U(70_000), usdcAfter: U(60_000) + 1n, venues: VENUES });
  assert.equal(wrong.outcome, "failure");
  assert.deepEqual(wrong.checks.filter((c) => !c.ok).map((c) => c.label), ["RockawayX USDC: deposit event", "RockawayX USDC: USDC moved from the wallet", "wallet USDC change"]);
  const reverted = verifyPlan({ report, receipts: [{ status: "reverted", logs: [] }], usdcBefore: 1n, usdcAfter: 1n, venues: VENUES });
  assert.equal(reverted.outcome, "failure");
});
