import { maxUint256, parseAbi } from "viem";
import { ABI, USDC } from "../contracts.js";
import { realisedApy, SECONDS_PER_YEAR } from "../chain.js";

// Avalon USDC: an Aave V3 market. The rate after a deposit comes from the reserve's own interest rate strategy
// (calculateInterestRates with liquidityAdded = amount), so it is the number the pool would set, not an estimate.

const RAY = 10n ** 27n;
const bits = (cfg, from, n) => (cfg >> BigInt(from)) & ((1n << BigInt(n)) - 1n);

/** Aave V3 ReserveConfiguration bit layout. */
export function decodeConfig(cfg) {
  return {
    decimals: Number(bits(cfg, 48, 8)),
    active: bits(cfg, 56, 1) === 1n,
    frozen: bits(cfg, 57, 1) === 1n,
    paused: bits(cfg, 60, 1) === 1n,
    reserveFactor: bits(cfg, 64, 16),
    supplyCap: bits(cfg, 116, 36), // whole tokens, 0 = no cap
  };
}

/** Aave shows supply APY as the liquidity rate (APR, ray) compounded per second. */
export const aprRayToApy = (rateRay) => Math.pow(1 + Number(rateRay) / 1e27 / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;

const STABLE = parseAbi(["function getAverageStableRate() view returns (uint256)"]);

export function avalonMarket(cfg) {
  const read = (client, block, address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block });

  async function snapshot({ client, block, past }) {
    const p = (fn, args, b = block.number) => read(client, b, cfg.address, ABI.aavePool, fn, args);
    const rd = await p("getReserveData", [USDC.address]);
    if (rd.aTokenAddress !== cfg.aToken) throw new Error(`aToken is ${rd.aTokenAddress}, expected ${cfg.aToken}`);
    const conf = decodeConfig(rd.configuration);
    const [cash, aSupply, variableDebt, stableDebt, avgStable, incomeNow, income1, income7] = await Promise.all([
      read(client, block.number, USDC.address, ABI.erc20, "balanceOf", [rd.aTokenAddress]),
      read(client, block.number, rd.aTokenAddress, ABI.erc20, "totalSupply"),
      read(client, block.number, rd.variableDebtTokenAddress, ABI.erc20, "totalSupply"),
      read(client, block.number, rd.stableDebtTokenAddress, ABI.erc20, "totalSupply"),
      read(client, block.number, rd.stableDebtTokenAddress, STABLE, "getAverageStableRate").catch(() => 0n),
      p("getReserveNormalizedIncome", [USDC.address]),
      p("getReserveNormalizedIncome", [USDC.address], past.d1.number).catch(() => null),
      p("getReserveNormalizedIncome", [USDC.address], past.d7.number).catch(() => null),
    ]);
    const params = { unbacked: rd.unbacked, liquidityAdded: 0n, liquidityTaken: 0n, totalStableDebt: stableDebt, totalVariableDebt: variableDebt, averageStableBorrowRate: avgStable, reserveFactor: conf.reserveFactor, reserve: USDC.address, aToken: rd.aTokenAddress };
    const [modelRate] = await read(client, block.number, rd.interestRateStrategyAddress, ABI.aaveStrategy, "calculateInterestRates", [params]);

    const supplied = aSupply + (BigInt(rd.accruedToTreasury) * incomeNow) / RAY;
    const cap = conf.supplyCap * 10n ** BigInt(conf.decimals);
    const depositRoom = conf.supplyCap === 0n ? null : cap > supplied ? cap - supplied : 0n;
    const chainApy = aprRayToApy(rd.currentLiquidityRate);
    const modelApy = aprRayToApy(modelRate);
    // Model ↔ chain: the strategy, fed today's state, must reproduce the rate the pool stored at its last update.
    const check = { ok: Math.abs(modelApy - chainApy) <= Math.max(0.0005, chainApy * 0.02), model: modelApy, chain: chainApy, note: "calculateInterestRates(today's state) vs the pool's current liquidity rate" };

    const notes = [];
    if (conf.frozen) notes.push("reserve is frozen: no new deposits; withdrawals still work");
    if (conf.paused) notes.push("reserve is paused: no deposits or withdrawals");
    if (!conf.active) notes.push("reserve is not active");
    notes.push(`reserve factor ${(Number(conf.reserveFactor) / 100).toFixed(0)}%: that share of borrow interest goes to the treasury, not suppliers`);

    return {
      venue: cfg.id,
      protocol: cfg.protocol,
      name: cfg.name,
      address: cfg.address,
      kind: cfg.kind,
      block: Number(block.number),
      tvl: supplied.toString(),
      idle: cash.toString(),
      // the strategy's rate for today's state (the pool's stored rate dates from its last update); the same function
      // gives the rate after a deposit, so "now → after" is always compared like for like
      apy: modelApy,
      realised1d: income1 ? realisedApy(incomeNow, income1, block.timestamp - past.d1.timestamp) : null,
      realised7d: income7 ? realisedApy(incomeNow, income7, block.timestamp - past.d7.timestamp) : null,
      borrowApy: aprRayToApy(rd.currentVariableBorrowRate),
      utilization: Number(variableDebt + stableDebt) / Number(cash + variableDebt + stableDebt || 1n),
      exitLiquidity: cash.toString(),
      depositRoom: depositRoom?.toString() ?? null,
      depositsTo: "Avalon USDC reserve (lent to Avalon borrowers)",
      state: { active: conf.active, frozen: conf.frozen, paused: conf.paused },
      accepts: { deposit: conf.active && !conf.frozen && !conf.paused, withdraw: conf.active && !conf.paused },
      lookThrough: [{ market: "USDC reserve", collateral: "Avalon collateral (WETH and others)", utilization: Number(variableDebt + stableDebt) / Number(cash + variableDebt + stableDebt || 1n), supplyApy: modelApy, assets: supplied.toString(), share: 1, liquidity: cash.toString(), receivesDeposits: true }],
      check,
      notes,
      _model: { params, strategy: rd.interestRateStrategyAddress },
    };
  }

  async function apyAfter({ client, block }, snap, amount) {
    const { params, strategy } = snap._model;
    const [rate] = await read(client, block.number, strategy, ABI.aaveStrategy, "calculateInterestRates", [{ ...params, liquidityAdded: amount }]);
    return aprRayToApy(rate);
  }

  async function position({ client, block }, user) {
    const assets = await read(client, block.number, cfg.aToken, ABI.erc20, "balanceOf", [user]);
    return { shares: assets.toString(), assets: assets.toString() };
  }

  return {
    ...cfg,
    snapshot,
    apyAfter,
    position,
    spender: cfg.address,
    depositCall: (amount, user) => ({ to: cfg.address, abi: ABI.aavePool, functionName: "supply", args: [USDC.address, amount, user, 0] }),
    // Withdrawing everything uses type(uint256).max, Aave's "all of it", so accrued interest leaves no dust.
    withdrawCall: (amount, user, pos) => ({ to: cfg.address, abi: ABI.aavePool, functionName: "withdraw", args: [USDC.address, pos && amount >= BigInt(pos.assets) ? maxUint256 : amount, user] }),
  };
}
