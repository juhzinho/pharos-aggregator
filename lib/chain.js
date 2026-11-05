import { createPublicClient, http } from "viem";
import { PACIFIC_RPC } from "./contracts.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const SECONDS_PER_YEAR = 365 * 86400;

/**
 * A Pacific client. Each venue gets its own, so a fault in one venue's reads (real or injected) never reaches
 * the others. `fault`: "down" → every call fails like an unreachable endpoint; "slow" → calls hang past the
 * venue timeout. Injected faults exist only for demos and tests and are always labelled in the report.
 */
export function makeClient({ rpc = process.env.PHAROS_RPC_URL ?? PACIFIC_RPC, fault } = {}) {
  const gate = gateFor(rpc);
  // JSON-RPC batching (many calls in one HTTP request) + the in-flight limit applied to HTTP requests themselves.
  const base = http(rpc, { timeout: 15_000, retryCount: 3, retryDelay: 500, batch: { batchSize: 40, wait: 12 }, fetchFn: (url, init) => gate(() => fetch(url, init)) });
  const transport = (opts) => {
    const t = base(opts);
    return {
      ...t,
      async request(args) {
        if (fault === "down") throw new Error("fetch failed: connect ECONNREFUSED (injected outage)");
        if (fault === "slow") await sleep(60_000);
        return t.request(args);
      },
    };
  };
  return createPublicClient({ transport, batch: { multicall: { wait: 16, batchSize: 4096 } } });
}

// The public Pacific RPC sits behind a gateway that stalls bursts of parallel requests (20 at once → ~10 s each,
// then errors), while a few at a time answer in well under a second. So every client of one endpoint shares a
// small in-flight limit. Multicall batching keeps the number of requests low in the first place.
const MAX_IN_FLIGHT = Number(process.env.PHAROS_RPC_CONCURRENCY ?? 2);
const gates = new Map();
function gateFor(rpc) {
  if (gates.has(rpc)) return gates.get(rpc);
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= MAX_IN_FLIGHT || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  const gate = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
  gates.set(rpc, gate);
  return gate;
}

/** Runs `fn` with a deadline; the venue is reported down instead of blocking the others. */
export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${label}: no answer within ${ms / 1000} s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The block all reads are pinned to (so every venue is compared on the same state), and the blocks ~1 and ~7 days
 * earlier for realised rates. Past blocks are found from timestamps, not assumed block times.
 * Head itself: Pharos blocks are final once produced (no reorgs to wait out), and a lagged block would miss a
 * pause or a transaction that just landed.
 */
export async function pinBlocks(client, { lag = 0n } = {}) {
  const head = (await client.getBlockNumber()) - lag;
  const now = await client.getBlock({ blockNumber: head });
  const probe = await client.getBlock({ blockNumber: head - 100_000n });
  const secPerBlock = Number(now.timestamp - probe.timestamp) / 100_000;
  // never outside [1, head]: irregular block times (or a fork that jumped in time) must not point past the chain
  const clamp = (n) => (n > head ? head : n < 1n ? 1n : n);
  const at = async (secondsAgo) => {
    let n = clamp(head - BigInt(Math.round(secondsAgo / secPerBlock)));
    let b = await client.getBlock({ blockNumber: n });
    // one correction step with the real local block time
    const miss = Number(now.timestamp - b.timestamp) - secondsAgo;
    n = clamp(n + BigInt(Math.round(miss / secPerBlock)));
    b = await client.getBlock({ blockNumber: n });
    return { number: b.number, timestamp: Number(b.timestamp) };
  };
  const [d1, d7] = await Promise.all([at(86_400), at(7 * 86_400)]);
  return { number: now.number, timestamp: Number(now.timestamp), d1, d7 };
}

/** Realised annual yield from an index (share price / normalised income) between two blocks, compounded. */
export function realisedApy(indexNow, indexThen, seconds) {
  if (!indexThen || indexThen <= 0n || seconds <= 0) return null;
  const ratio = Number((indexNow * 10n ** 18n) / indexThen) / 1e18;
  return Math.pow(ratio, SECONDS_PER_YEAR / seconds) - 1;
}

// 2 decimals, except below 1 USDC where every base unit matters (0.000001 must not print as 0)
export const fmtUsdc = (raw) => (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: Math.abs(Number(raw)) < 1e6 ? 6 : 2 });
export const pct = (x, d = 2) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
