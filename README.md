# Pharos Multi-Protocol Aggregator

One interface over **Morpho** (two Vault V2 USDC vaults) and **Avalon** (Aave V3) on Pharos Pacific. Ask for rates,
positions, a deposit or a withdrawal: it picks the best venue for *that* request, says why, prepares the transactions
for you to sign, and keeps working when a venue is down.

**Live demo:** https://pharos-aggregator.vercel.app · **Architecture:** [ARCHITECTURE.md](ARCHITECTURE.md)

```
1 READ      every venue at one block, from the protocols' own contracts (model checked against the chain)
2 RATE      the APY each venue would pay AFTER your amount (Morpho IRM · Aave rate strategy)
3 ROUTE     best venue + the reason · split if it pays · exits from the lowest-paying position first
4 PREPARE   unsigned EIP-1559 transactions, simulated (eth_call + state overrides) — never signed
```

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | ≥ 2 protocols or vaults behind one interface | **2 protocols, 3 venues**: Morpho Vault V2 RockawayX USDC, Morpho Vault V2 SharpByte USDC, Avalon USDC (Aave V3). Each is one adapter with the same five members (`snapshot`, `apyAfter`, `position`, `depositCall`, `withdrawCall`); `ask()` is the single entry point (CLI, API, site). |
| 02 | Queries (positions, rates) and actions (deposit / withdraw prepared for signature) | Queries: rates (net APY, realised 1d/7d, TVL, free liquidity, room, look-through to the markets and collateral underneath) and positions of any wallet. Actions: deposit and withdraw as **unsigned EIP-1559 transactions** (approve only when the allowance is short; `redeem`/`max` for whole positions), each simulated, plus a `cast send` equivalent. |
| 03 | Routes each request to the best venue and explains why | Deposits: ranked by the **rate after the deposit**, computed with each protocol's own rate function; caps found by simulation; split across venues when it earns ≥ 0.05 pp and ≥ $5/yr more, or when no single venue can take it. Withdrawals: lowest-paying position first, bounded by what can leave now. Every report lists the reasons, including why the other venues were not used. |
| 04 | Handles one protocol being unavailable without breaking the others | Each venue has its own client and deadline. **Down / hung** (injected for demos), **paused** (read on chain), **degraded** (model disagrees with chain) venues are reported and left out; positions there are "unknown" or "locked", never zero. Proven live (`--down`, `--slow`, the site's toggles) and with a **real pause by Avalon's own pool admin** on a fork. |
| 05 | Architecture write-up and demo video | [ARCHITECTURE.md](ARCHITECTURE.md) (diagram, venue interface, decisions, failure table). Video: walkthrough of the demo. |

## Real numbers (Pacific mainnet, recorded in `public/runs/`)

- RockawayX **5.21 %** net · SharpByte **4.68 %** · Avalon **1.96 %** — rebuilt from the contracts and checked against what each venue actually paid over the last day: 4.89 %, 4.64 % and 1.95 % (Avalon's stored rate).
- **Deposit 10,000 USDC** → RockawayX (5.21 % after), approve + deposit simulated.
- **Deposit 10,000,000 USDC** → RockawayX refuses the full amount (`AbsoluteCapExceeded`); by simulation it takes at most ~9.18M now. Split 8.7M RockawayX + 1.3M SharpByte = **3.37 %**, vs 0.86 % in one venue (~$251k/yr more). Avalon is left out (1M supply cap, 498k room).
- **Withdraw 100,000 USDC** from a real wallet holding 678k in SharpByte and 251k in Avalon → only **88,653 USDC** can leave now (SharpByte has 33.6k idle and no liquidity adapter; Avalon has 55k cash). Plan: Avalon first (lowest rate), then SharpByte.
- **Fork loop**: the prepared deposit and withdrawal were sent by that wallet and verified to the base unit; then Avalon's pool admin paused the USDC reserve and the agent kept routing, showing the Avalon position as locked.

## Run it

Node.js 20.12+.

```bash
npm install
npm test                          # 16 unit tests (maths, routing, split, parsing, verification)
npm run test:e2e                  # 9 live mainnet cases (read-only), ~3 min
npm run test:e2e -- --fork        # + the Anvil fork loop

npm run agg -- "What are the best rates?"
npm run agg -- "Deposit 10,000 USDC"                                   # optional: "for 0x…"
npm run agg -- "Where should I put 10m USDC?"
npm run agg -- "Positions of 0xD27Cb53f5920D484261CC14d32094d3f043265C9"
npm run agg -- "Withdraw 100,000 USDC from 0xD27Cb53f5920D484261CC14d32094d3f043265C9"
npm run agg -- "Deposit 10,000 USDC" --down rockawayx                  # a venue down (also --slow)
npm run agg -- "Depositar 5.000 USDC"                                  # Portuguese: 5.000 = five thousand
node scripts/fork-loop.js                                              # prepare → send → verify, then a real pause
npm run web                                                            # the demo at http://localhost:3100
```

## Layout

```
tasks/agg/agg.js       CLI
lib/ask.js             the one interface: request → routed, explained, prepared answer
lib/agent.js           survey · rates · positions · deposit · withdraw · split search · cap discovery
lib/venues/morpho.js   Morpho Vault V2 adapter (look-through to Morpho Blue, IRM rates)
lib/venues/avalon.js   Avalon (Aave V3) adapter (config bits, rate strategy)
lib/prepare.js         unsigned txs, simulation with state overrides, decoded reverts
lib/verify.js          receipts + balance delta vs the plan
lib/intent.js          request parser (EN/PT)
lib/chain.js           viem client: batching, in-flight limit, per-venue faults, one pinned block
api/ask.js             live endpoint for the demo
scripts/record.js      records the demo runs on mainnet · scripts/fork-loop.js the fork proof
```

## Notes

- The agent never signs. The fork loop stands in for your wallet: Anvil impersonates a real Pacific wallet to send
  exactly the prepared transactions.
- `--down` / `--slow` and the site's "take a venue offline" buttons inject an outage into that venue's reads only;
  reports label it as injected. The pause in the fork loop is real protocol state.
- Agent explanations are in English; the site's interface is in English and Portuguese.
