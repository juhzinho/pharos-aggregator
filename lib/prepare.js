import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, getAbiItem, getAddress, keccak256, pad, parseAbi, toFunctionSignature, toHex } from "viem";
import { ABI, CHAIN_ID, PACIFIC_RPC, USDC, USDC_SLOTS } from "./contracts.js";

// Everything that moves funds is prepared, never signed. Each transaction is simulated first (eth_call at the
// pinned block); when a step depends on an earlier one in the same plan (deposit after approve), the earlier
// step's effect is applied as an eth_call state override, and the report says so.

/** A neutral address for "where would N USDC go?" questions asked without a wallet. */
export const PROBE = getAddress("0x00000000000000000000000000000000000a9901");

const mapSlot = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (owner, spender, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapSlot(owner, slot)]));

/** eth_call state override for USDC: set `owner`'s balance and/or allowance to `spender`. */
export function usdcOverride({ owner, spender, balance, allowance }) {
  const stateDiff = [];
  if (balance != null) stateDiff.push({ slot: mapSlot(owner, USDC_SLOTS.balances), value: pad(toHex(balance)) });
  if (allowance != null) stateDiff.push({ slot: nestedSlot(owner, spender, USDC_SLOTS.allowed), value: pad(toHex(allowance)) });
  return stateDiff.length ? [{ address: USDC.address, stateDiff }] : undefined;
}

const KNOWN_ERRORS = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  // Morpho Vault V2
  "error AbsoluteCapExceeded()",
  "error RelativeCapExceeded()",
  "error CannotReceiveShares()",
  "error CannotSendShares()",
  "error CannotReceiveAssets()",
  "error CannotSendAssets()",
  // FiatToken / ERC-20
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

// Aave V3 Errors.sol codes that matter for a USDC supplier.
const AAVE_CODES = { 26: "invalid amount", 27: "reserve is not active", 28: "reserve is frozen", 29: "reserve is paused", 32: "not enough available balance", 51: "supply cap exceeded" };

/** A short, readable reason for a reverted call. */
export function revertReason(error) {
  const data = error?.walk?.((e) => typeof e?.data === "string" && e.data.startsWith("0x"))?.data;
  if (data && data !== "0x") {
    try {
      const d = decodeErrorResult({ abi: KNOWN_ERRORS, data });
      if (d.errorName === "Error") {
        const msg = String(d.args[0]);
        return AAVE_CODES[Number(msg)] ? `Avalon: ${AAVE_CODES[Number(msg)]} (error ${msg})` : msg;
      }
      if (d.errorName === "Panic") return Number(d.args[0]) === 0x11 ? "arithmetic underflow: not enough free liquidity for this amount" : `panic 0x${Number(d.args[0]).toString(16)}`;
      return d.errorName;
    } catch {
      return `reverted (${data.slice(0, 10)})`;
    }
  }
  const short = error?.shortMessage ?? error?.message ?? String(error);
  if (/underflow|overflow/i.test(short)) return "arithmetic underflow: not enough free liquidity for this amount";
  return short.split("\n")[0].slice(0, 160);
}

/** Simulates one call at the pinned block, then estimates its gas with the same state. */
export async function simulate(client, block, { from, call, stateOverride, gas: estimate = true }) {
  const data = encodeFunctionData(call);
  try {
    await client.call({ account: from, to: call.to, data, blockNumber: block, stateOverride });
    if (!estimate) return { ok: true, gas: null };
    const gas = await client.estimateGas({ account: from, to: call.to, data, blockNumber: block, stateOverride });
    return { ok: true, gas };
  } catch (error) {
    return { ok: false, reason: revertReason(error) };
  }
}

export const approveCall = (spender, amount) => ({ to: USDC.address, abi: ABI.erc20, functionName: "approve", args: [spender, amount] });

const fmtArg = (a) => (typeof a === "bigint" ? a.toString() : a);

/** An unsigned EIP-1559 transaction plus what it does in words and the Foundry `cast send` equivalent. */
export function unsignedTx({ from, call, gas, nonce, fees, label }) {
  const item = getAbiItem({ abi: call.abi, name: call.functionName, args: call.args });
  const signature = toFunctionSignature(item);
  return {
    label,
    call: `${call.functionName}(${call.args.map(fmtArg).join(", ")})`,
    tx: {
      chainId: CHAIN_ID,
      from,
      to: call.to,
      data: encodeFunctionData(call),
      value: "0x0",
      gas: toHex((gas * 12n) / 10n), // +20% headroom over the estimate
      maxFeePerGas: toHex(fees.maxFeePerGas),
      maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
      nonce: nonce == null ? undefined : toHex(nonce),
      type: "0x2",
    },
    cast: `cast send ${call.to} "${signature}" ${call.args.map(fmtArg).join(" ")} --rpc-url ${PACIFIC_RPC}`,
  };
}

/** EIP-1559 fees from the pinned block: 2× base fee as the cap, the network's suggested tip. */
export async function feesAt(client, blockNumber) {
  const b = await client.getBlock({ blockNumber });
  const tip = await client.estimateMaxPriorityFeePerGas().catch(() => 0n);
  return { baseFee: b.baseFeePerGas ?? 0n, maxPriorityFeePerGas: tip, maxFeePerGas: (b.baseFeePerGas ?? 0n) * 2n + tip };
}
