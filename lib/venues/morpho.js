import { decodeAbiParameters, encodeAbiParameters, keccak256 } from "viem";
import { ABI, MORPHO_BLUE, USDC } from "../contracts.js";
import { realisedApy, SECONDS_PER_YEAR } from "../chain.js";

// Morpho Vault V2 (ERC-4626) over Morpho Blue markets, read through its MorphoMarketV1 adapters.
// The rate is not a headline number: it is rebuilt from each market the vault lends into, with the market's own
// interest rate model (IRM.borrowRateView), weighted by what the vault actually holds there, minus the vault fees.

const WAD = 10n ** 18n;
const VIRTUAL_SHARES = 10n ** 6n; // Morpho Blue SharesMathLib
const VIRTUAL_ASSETS = 1n;
const SHARE_PROBE = 10n ** 24n; // 1e6 vault shares (18 decimals) → share price with 12 significant digits
const MARKET_PARAMS = [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }];

const toAssetsDown = (shares, totalAssets, totalShares) => (shares * (totalAssets + VIRTUAL_ASSETS)) / (totalShares + VIRTUAL_SHARES);
export const marketId = (p) => keccak256(encodeAbiParameters(MARKET_PARAMS, [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));

/** Supply APY of a Morpho Blue market (Morpho's own formula): borrow APY × utilisation × (1 − market fee). */
export function supplyApy(borrowRatePerSecond, m) {
  if (m.totalSupplyAssets === 0n) return 0;
  const borrowApy = Math.expm1((Number(borrowRatePerSecond) / 1e18) * SECONDS_PER_YEAR);
  const util = Number(m.totalBorrowAssets) / Number(m.totalSupplyAssets);
  return borrowApy * util * (1 - Number(m.fee) / 1e18);
}

/** Net vault APY from its allocations: Σ allocation × market supply APY / total, minus performance & management fee. */
export function vaultNetApy({ allocations, idle, performanceFee, managementFee, maxRate }) {
  const total = allocations.reduce((s, a) => s + a.assets, 0n) + idle;
  if (total === 0n) return { gross: 0, net: 0 };
  const earned = allocations.reduce((s, a) => s + Number(a.assets) * a.supplyApy, 0);
  let gross = earned / Number(total);
  const cap = (Number(maxRate) / 1e18) * SECONDS_PER_YEAR; // Vault V2 caps how fast totalAssets may grow
  if (maxRate > 0n && gross > cap) gross = cap;
  const net = gross * (1 - Number(performanceFee) / 1e18) - (Number(managementFee) / 1e18) * SECONDS_PER_YEAR;
  return { gross, net };
}

export function morphoVault(cfg) {
  const read = (client, block, address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block });

  async function snapshot({ client, block, past }) {
    const v = (fn, args, b = block.number) => read(client, b, cfg.address, ABI.vaultV2, fn, args);
    const [asset, totalAssets, totalSupply, performanceFee, managementFee, maxRate, liquidityAdapter, liquidityData, adaptersLength, idle, gates, curator] = await Promise.all([
      v("asset"), v("totalAssets"), v("totalSupply"), v("performanceFee"), v("managementFee"), v("maxRate"), v("liquidityAdapter"), v("liquidityData"), v("adaptersLength"),
      read(client, block.number, USDC.address, ABI.erc20, "balanceOf", [cfg.address]),
      Promise.all(["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "sendAssetsGate"].map((g) => v(g))),
      v("curator"),
    ]);
    if (asset !== USDC.address) throw new Error(`asset() is ${asset}, not USDC`);

    const notes = [];
    const adapters = await Promise.all(Array.from({ length: Number(adaptersLength) }, (_, i) => v("adapters", [BigInt(i)])));
    const allocations = [];
    let unmodelled = 0n;
    for (const adapter of adapters) {
      let n;
      try {
        n = await read(client, block.number, adapter, ABI.marketAdapter, "marketIdsLength");
      } catch {
        // An adapter type this agent does not model: its assets are counted as earning nothing, and flagged.
        const real = await read(client, block.number, adapter, ABI.marketAdapter, "realAssets").catch(() => 0n);
        unmodelled += real;
        notes.push(`adapter ${adapter} is not a Morpho market adapter; its ${real} assets are not modelled`);
        continue;
      }
      const ids = await Promise.all(Array.from({ length: Number(n) }, (_, i) => read(client, block.number, adapter, ABI.marketAdapter, "marketIds", [BigInt(i)])));
      const rows = await Promise.all(
        ids.map(async (id) => {
          const m = (fn, args) => read(client, block.number, MORPHO_BLUE, ABI.morpho, fn, args);
          const [p, mk, pos] = await Promise.all([m("idToMarketParams", [id]), m("market", [id]), m("position", [id, adapter])]);
          const params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
          const market = { totalSupplyAssets: mk[0], totalSupplyShares: mk[1], totalBorrowAssets: mk[2], totalBorrowShares: mk[3], lastUpdate: mk[4], fee: mk[5] };
          const assets = toAssetsDown(pos[0], market.totalSupplyAssets, market.totalSupplyShares);
          if (assets === 0n && market.totalSupplyAssets < 1_000_000n) return null; // empty market listed by the adapter
          const [rate, collateralSymbol] = await Promise.all([
            read(client, block.number, params.irm, ABI.irm, "borrowRateView", [params, market]),
            read(client, block.number, params.collateralToken, ABI.erc20, "symbol").catch(() => "?"),
          ]);
          return { id, adapter, params, market, assets, borrowRate: rate, supplyApy: supplyApy(rate, market), collateral: collateralSymbol, lltv: Number(params.lltv) / 1e18, utilization: market.totalSupplyAssets ? Number(market.totalBorrowAssets) / Number(market.totalSupplyAssets) : 0, liquidity: market.totalSupplyAssets - market.totalBorrowAssets };
        }),
      );
      allocations.push(...rows.filter(Boolean));
    }

    // Where a new deposit goes: the liquidity adapter's market, or nowhere (it stays idle until the curator allocates).
    let liquidityMarket = null;
    if (liquidityAdapter !== "0x0000000000000000000000000000000000000000" && liquidityData !== "0x") {
      const [lp] = decodeAbiParameters([{ type: "tuple", components: MARKET_PARAMS.map((t, i) => ({ ...t, name: ["loanToken", "collateralToken", "oracle", "irm", "lltv"][i] })) }], liquidityData);
      liquidityMarket = allocations.find((a) => a.id === marketId(lp) && a.adapter === liquidityAdapter)?.id ?? null;
      if (!liquidityMarket) notes.push("the liquidity adapter's market is not among the modelled allocations");
    }

    const fees = { performanceFee, managementFee, maxRate };
    const { gross, net } = vaultNetApy({ allocations, idle: idle + unmodelled, ...fees });

    // Exit liquidity: idle USDC, plus what can be pulled from the liquidity market (bounded by its free liquidity).
    const lm = allocations.find((a) => a.id === liquidityMarket);
    const exitLiquidity = idle + (lm ? (lm.assets < lm.liquidity ? lm.assets : lm.liquidity) : 0n);

    // Realised: change in share price, so it is already net of every fee.
    const price = (b) => v("convertToAssets", [SHARE_PROBE], b);
    const [pNow, p1, p7] = await Promise.all([price(block.number), price(past.d1.number).catch(() => null), price(past.d7.number).catch(() => null)]);
    const realised1d = p1 ? realisedApy(pNow, p1, block.timestamp - past.d1.timestamp) : null;
    const realised7d = p7 ? realisedApy(pNow, p7, block.timestamp - past.d7.timestamp) : null;

    // Model ↔ chain: the rebuilt rate must agree with what the vault actually paid over the last day.
    const check = realised1d == null ? { ok: false, note: "no 1-day share price history" } : { ok: Math.abs(net - realised1d) <= Math.max(0.006, Math.abs(realised1d) * 0.15), model: net, chain: realised1d, note: "model net APY vs share-price growth over the last day" };

    if (gates.some((g) => g !== "0x0000000000000000000000000000000000000000")) notes.push("the vault has deposit/withdraw gates set; a gated wallet may be refused");
    if (!liquidityMarket) notes.push("no liquidity adapter: new deposits stay idle until the curator allocates them, and withdrawals come only from idle USDC");

    return {
      venue: cfg.id,
      protocol: cfg.protocol,
      name: cfg.name,
      address: cfg.address,
      kind: cfg.kind,
      curator,
      block: Number(block.number),
      tvl: totalAssets.toString(),
      totalSupply: totalSupply.toString(),
      idle: idle.toString(),
      apy: net,
      grossApy: gross,
      realised1d,
      realised7d,
      fees: { performance: Number(performanceFee) / 1e18, management: (Number(managementFee) / 1e18) * SECONDS_PER_YEAR },
      exitLiquidity: exitLiquidity.toString(),
      depositRoom: null, // Vault V2 caps live per id; the deposit simulation is the authority
      depositsTo: lm ? `Morpho Blue ${lm.collateral}/USDC market` : "idle in the vault",
      accepts: { deposit: true, withdraw: true }, // Vault V2 has no pause; caps and gates show up in the simulation
      liquidityMarket,
      lookThrough: allocations.map((a) => ({ market: a.id, collateral: a.collateral, lltv: a.lltv, utilization: a.utilization, supplyApy: a.supplyApy, assets: a.assets.toString(), share: Number(a.assets) / Number(totalAssets || 1n), liquidity: a.liquidity.toString(), receivesDeposits: a.id === liquidityMarket })),
      check,
      notes,
      _model: { allocations, idle: idle + unmodelled, fees, liquidityMarket },
    };
  }

  /** Net APY the vault would pay after `amount` more USDC arrives (the IRM recomputes the market it lands in). */
  async function apyAfter({ client, block }, snap, amount) {
    const { allocations, idle, fees, liquidityMarket } = snap._model;
    if (!liquidityMarket) return vaultNetApy({ allocations, idle: idle + amount, ...fees }).net;
    const next = await Promise.all(
      allocations.map(async (a) => {
        if (a.id !== liquidityMarket) return a;
        const m = { ...a.market, totalSupplyAssets: a.market.totalSupplyAssets + amount, totalSupplyShares: a.market.totalSupplyShares + (a.market.totalSupplyAssets ? (amount * a.market.totalSupplyShares) / a.market.totalSupplyAssets : amount * VIRTUAL_SHARES) };
        const rate = await read(client, block.number, a.params.irm, ABI.irm, "borrowRateView", [a.params, m]);
        return { ...a, market: m, assets: a.assets + amount, supplyApy: supplyApy(rate, m) };
      }),
    );
    return vaultNetApy({ allocations: next, idle, ...fees }).net;
  }

  async function position({ client, block }, user) {
    const shares = await read(client, block.number, cfg.address, ABI.vaultV2, "balanceOf", [user]);
    const assets = shares ? await read(client, block.number, cfg.address, ABI.vaultV2, "previewRedeem", [shares]) : 0n;
    return { shares: shares.toString(), assets: assets.toString() };
  }

  return {
    ...cfg,
    snapshot,
    apyAfter,
    position,
    spender: cfg.address,
    depositCall: (amount, user) => ({ to: cfg.address, abi: ABI.vaultV2, functionName: "deposit", args: [amount, user] }),
    // Withdrawing everything redeems all shares, so no dust is left behind.
    withdrawCall: (amount, user, pos) => (pos && amount >= BigInt(pos.assets) ? { to: cfg.address, abi: ABI.vaultV2, functionName: "redeem", args: [BigInt(pos.shares), user, user] } : { to: cfg.address, abi: ABI.vaultV2, functionName: "withdraw", args: [amount, user, user] }),
  };
}
