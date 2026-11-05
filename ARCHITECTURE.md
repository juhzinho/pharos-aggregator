# Architecture

A Harbor-style aggregator: one interface over several yield venues on Pharos Pacific. Every answer is rebuilt from the
protocols' own contracts at one block, routed with a stated reason, and anything that moves funds is prepared (never
signed) and simulated first.

```
            "Deposit 10m USDC" · "Positions of 0x…" · "Withdraw 100k from 0x…" · "Best rate?"
                                              │
                                   lib/intent.js  (EN + PT; refuses anything ambiguous)
                                              │
                                     lib/ask.js  — the one interface
                                              │
        ┌───────────────────────── lib/agent.js ──────────────────────────┐
        │ survey()  pin one block; read every venue in parallel, each with │
        │           its own client + deadline → ok · degraded · paused · down│
        │ rates() · positions() · deposit() · withdraw()                    │
        │ router:   rate AFTER this deposit · split search · cap discovery  │
        │           exits: lowest-paying first, bounded by free liquidity   │
        └───────┬───────────────────────────┬───────────────────────────────┘
                │ one adapter per protocol  │
   lib/venues/morpho.js              lib/venues/avalon.js
   Morpho Vault V2 (ERC-4626)        Aave V3 pool (Avalon)
   → adapters → Morpho Blue markets  → reserve data, config bits,
   → IRM.borrowRateView              → strategy.calculateInterestRates
                │                           │
                └──────── lib/chain.js ─────┘  viem; JSON-RPC batching + multicall; shared in-flight limit
                              │
                       rpc.pharos.xyz (chain 1672)
                              │
        lib/prepare.js  unsigned EIP-1559 txs · eth_call + estimateGas with state overrides · decoded reverts
        lib/verify.js   after signing: receipts' events + exact wallet balance delta vs the plan
```

## The venue interface

Every adapter returns the same shape, so the router never knows which protocol it is talking to:

| method | returns |
|---|---|
| `snapshot(ctx)` | net APY now, realised 1d / 7d, TVL, free exit liquidity, deposit room, where a deposit lands, look-through to the markets/collateral underneath, a model ↔ chain check, on-chain state (paused/frozen) |
| `apyAfter(ctx, snap, amount)` | the net APY the venue would pay after `amount` more arrives, computed with the protocol's own rate function |
| `position(ctx, user)` | shares and their USDC value |
| `depositCall` / `withdrawCall` | the exact contract call (whole-position exits use `redeem` / `type(uint256).max`, so no dust) |

Adding a venue = one adapter with these five members.

## Venues (Pacific mainnet, all verified on chain)

| venue | contract | how the rate is computed |
|---|---|---|
| RockawayX USDC — Morpho Vault V2 | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` | Σ (assets in each Morpho Blue market × that market's supply APY from `IRM.borrowRateView`) / total, − 15 % performance fee. Deposits go to its liquidity market (wsrUSD/USDC). |
| SharpByte USDC Pharos Ecosystem — Morpho Vault V2 | `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` | same; it has **no liquidity adapter**, so a deposit stays idle (dilutes the rate) and exits come only from idle USDC. |
| Avalon USDC — Aave V3 | pool `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` | the reserve's own `calculateInterestRates` on today's state (checked against the stored `currentLiquidityRate`), and with `liquidityAdded = amount` after a deposit — so "now → after" uses one function; APR compounded per second. 45 % reserve factor, 1,000,000 USDC supply cap. |

Morpho Blue core: `0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb`. USDC (token registry): `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`.

## Decisions

- **Rate after your deposit, not the headline.** A large deposit lowers the rate it lands in (utilisation falls, idle
  cash dilutes). The router ranks venues by the rate *after* the requested amount, using each protocol's own view
  functions on a hypothetical state.
- **Trust, but check.** Before a model is used for routing it must reproduce the chain: Avalon's strategy fed today's
  state must give the stored liquidity rate; a vault's rebuilt net APY must agree with its share-price growth over the
  last day. A venue that fails this is `degraded` and excluded from deposits.
- **One block.** All venues are read at the same pinned block (Pharos blocks are final), so comparisons are fair and
  every number in a report can be re-checked.
- **Isolation.** Each venue has its own client and a deadline. Down, hung, paused or degraded venues are reported with
  the reason; a position in an unreadable venue is "unknown", never zero; a paused venue's position is "locked".
- **Caps by simulation.** Morpho Vault V2 has no usable `maxDeposit` (it returns 0) and caps live per id. When a
  deposit simulation reverts with `AbsoluteCapExceeded`/`RelativeCapExceeded`, the agent bisects the simulation to find
  what the vault accepts now, and the split search can still use that room.
- **Split only when it pays.** The split search samples each venue's rate curve (10 points up to what it accepts),
  searches allocations in 1 % steps plus each exact cap, then recomputes the chosen legs exactly. It is proposed only
  if it beats the best single venue by ≥ 0.05 pp and ≥ $5/yr — or if no single venue can take the amount.
- **Exits give up the least yield.** Withdrawals take from the lowest-paying position first, each bounded by the free
  liquidity that can leave right now (idle + liquidity market for a vault, reserve cash for Aave). If liquidity is
  short, the plan says how much can leave now and why.
- **Never signs.** Transactions are unsigned EIP-1559 with nonces in order. When a step depends on an earlier one in
  the same plan (deposit after approve), the simulation applies that effect as an `eth_call` state override, and the
  report says so. If any prepared transaction fails its simulation, the plan is blocked.
- **The RPC's limits are respected.** The public gateway stalls bursts of new connections; the client batches JSON-RPC
  calls, multicalls reads, and keeps two HTTP requests in flight per endpoint.

## Failure modes, and what the agent does

| what happens | where it is seen | behaviour |
|---|---|---|
| venue RPC unreachable / hangs | `survey()` deadline | venue `down`; routed among the others; positions there "unknown" |
| protocol paused (e.g. Aave `setReservePause`) | config bits at the pinned block | venue `paused`; no deposits or withdrawals routed there; positions "locked" |
| reserve frozen | config bits | no deposits; withdrawals still routed |
| model disagrees with chain | `check` | venue `degraded`; excluded from deposit routing |
| supply / vault cap | config / simulation | partial room found; used in a split or excluded with the reason |
| not enough free liquidity | exit liquidity | partial withdrawal plan, with the reason per venue |
| wallet short of USDC or PROS gas | wallet read | plan shown, but `blocked` with the reason |
| ambiguous request | intent parser | refused, never guessed |

## Proof

- `public/runs/*.json` — real mainnet runs (rates, deposit 10k, deposit 10M with cap discovery + split, positions,
  partial withdrawal, a venue down).
- `public/runs/fork-loop.json` — on an Anvil fork of Pacific: the prepared deposit and withdrawal sent by a real wallet
  and verified from receipts; then Avalon's real pool admin pauses the reserve and the agent adapts.
