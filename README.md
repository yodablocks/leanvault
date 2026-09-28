# leanvault

**Three ERC4626 vaults on one lean accounting core, and an AI curator on probation: it judges 22 real USDC vaults every six hours, in public, and the contract bounds what it could ever do with the allocator key.**

The core keeps both totals and the pause flag in one storage slot, guards reentrancy in transient storage, and has no assembly. It costs at most 0.3% more than Solady's ERC4626 on a deposit and less on withdraw and redeem, while carrying a pause and a guard that Solady lacks. On top of it sit a yield vault that streams gains, and an allocator whose curator is held on-chain by a timelocked allowlist, caps and a 24-hour rebalance limit. The curator is a shadow agent built on TypeSafe's Jev. It logs what it would do and moves nothing, and its latest judgments are **live at [yodablocks.github.io/leanvault](https://yodablocks.github.io/leanvault/)**.

[![CI](https://github.com/yodablocks/leanvault/actions/workflows/test.yml/badge.svg)](https://github.com/yodablocks/leanvault/actions/workflows/test.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.37-363636?logo=solidity&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-unaudited-orange)

---

## Why

Every yield vault needs an accounting layer before the interesting part starts, and the accounting layer is paid on every deposit. Most of them inherit one that reads two or three storage slots per call and keeps a storage-based reentrancy guard. This one was designed backwards from the gas: what is the least a correct ERC4626 shell with a pause and a guard can cost? The answer turned out to be three declarations and one arithmetic trick, and the story of how it was measured is in the [YulSafe write-up](https://github.com/yodablocks/yulsafe/blob/main/docs/the-compiler-was-fine.md).

The allocator exists because the interesting question is not the accounting. It is whether software can be trusted to move depositors' money between strategies. leanvault's answer is to make that trust unnecessary on-chain, since the curator can be wrong without being able to drain anything, and then to earn it off-chain: weeks of public judgments, compared with what a human curator would have done, before the agent ever gets the key.

## What is in it

| | |
|---|---|
| **One slot** | `totalAssets` (96 bits), `totalSupply` (96 bits) and the pause flag (8 bits) share a word. Every path reads one slot and writes one slot. |
| **Transient guard** | Solady's `ReentrancyGuardTransient`, two TSTOREs per call instead of a cold SLOAD and two SSTOREs. Requires cancun. |
| **Supply written once** | The share token is minimal and reads its supply from the packed word, so a deposit updates supply in the same write as the totals. |
| **Virtual share** | One virtual share and one virtual asset in the price formula, the way Solady defends against inflation. No storage write on the first deposit. Donations never move the price anyway, since the vault never reads its own balance. |
| **Owner** | One slot, one transfer function, no handover machinery, no payable functions. |
| **Permit** | EIP-2612 on the share token, so a holder can approve a router or a zap with a signature instead of a transaction. The EIP-712 domain is cached at deployment and recomputed if the chain id changes, so a signature made before a fork is void after it. Plain `ecrecover` with the EIP-2 low-s bound, so each approval has one valid signature, no assembly. |
| **Rounding** | Deposit and redeem round down what the user gets, mint and withdraw round up what the user pays. Previews equal the real calls. |

Not in it: any fee. That is the roadmap.

## Gas

From [erc4626-bench](https://github.com/yodablocks/erc4626-bench), column Lean3, which is this repository's `LeanVault` copied as shipped. Per transaction, solc 0.8.37, optimizer at 10,000,000 runs:

| Call | leanvault | Solady ERC4626 |
|---|---|---|
| `deposit()` first, cold vault | 106,096 | 106,009 |
| `deposit()` subsequent | 54,796 | 54,709 |
| `mint()` | 54,877 | 54,735 |
| `withdraw()` | 53,303 | 54,576 |
| `redeem()` | 53,160 | 53,284 |
| `totalAssets()` | 2,321 | 5,621 |
| `convertToShares()` | 3,002 | 8,072 |
| `convertToAssets()` | 3,104 | 8,108 |
| `permit()` | 73,903 | 76,296 |
| Deployment gas | 2,028,691 | 1,185,598 |

On EraVM, from receipts on `anvil-zksync`, the same vault costs 171,152 on a first deposit against Solady's 173,466, and 161,122 on a withdraw against 167,356. The benchmark's other columns show what each design choice costs; its Lean2 is this vault before the hooks and `permit`.

Both columns now carry `permit`, so the gap in deployment is not a missing feature. Solady writes its ERC20 and ERC4626 in inline assembly; this vault is plain Solidity and also carries a pause switch, an owner and a reentrancy guard. That is the trade: about 70% more to deploy, once, for code a reviewer can read line by line. On what a user repeats, deposits and mint cost 87 to 142 gas more than Solady, withdraw and redeem cost 124 to 1,273 less, and views a third as much. A signed `permit` runs 2,393 gas cheaper than Solady's, most of its cost two cold storage writes (the nonce and the allowance).

## The yield vault

`LeanYieldVault` is the shell with three hooks filled in: every deposit goes into another ERC4626 vault, the strategy, and every withdrawal is paid straight out of it. The accounting follows what Yearn V3 and Euler Earn settled on:

| | |
|---|---|
| **Permissionless harvest** | Anyone can call `harvest()`. It compares the strategy's valuation with the vault's own total. No keeper, no yield stalled by an absent owner. |
| **Gains stream** | A gain is never credited at once. It is locked and released linearly over `unlockPeriod`, one hour to thirty days, set by the owner. The share price rises as a stream, so a deposit timed just before a harvest captures nothing. `testFuzz_depositBeforeHarvestCapturesNothing` proves it. |
| **Losses land at once** | A loss is recognized immediately and eats locked profit first, so a loss during a stream lowers future gains before it lowers the price. |
| **Price is never read live** | Deposits and withdrawals price against the last harvest plus the stream. A strategy whose valuation can be moved within a block cannot move this vault's price without a harvest, and even then only through the stream. |
| **Limits follow the strategy** | `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` are capped by what the strategy will accept or pay, so `withdraw(maxWithdraw(owner))` never reverts. |

The strategy can be any ERC4626 over the same asset: sDAI, a Morpho vault, an Aave wrapper. It passes the same 26 properties through a Solady ERC4626 as the strategy, and 13 targeted tests cover the stream, the losses, the sandwich, permissions and limits.

Per transaction, the strategy's own cost added on top of the shell:

| Call | Idle shell | Yield vault |
|---|---|---|
| `deposit()` first, cold vault | 106,096 | 168,547 |
| `deposit()` subsequent | 54,796 | 83,047 |
| `withdraw()` | 53,291 | 76,089 |
| `redeem()` | 53,148 | 75,962 |
| `convertToShares()` | 3,002 | 5,380 |
| `harvest()` | | 48,484 |

The difference on writes is the strategy's own deposit or withdrawal, which any vault of vaults pays. The difference on views is one extra slot for the stream. No fee in v1.

## The allocator vault

`LeanAllocatorVault` is the yield vault over several strategies, built for a curator that may be a person, a firm, or an automated agent. The point of the design is that the curator's authority is bounded on-chain, so being wrong costs yield, not principal:

| | |
|---|---|
| **Timelocked allowlist** | The owner proposes a strategy with a cap; it becomes usable only after `timelock` (one hour to thirty days). Depositors can see a new strategy coming and leave first. Removal requires the strategy to be empty. |
| **Caps** | Every strategy has a cap in assets. Neither deposits nor rebalances can push a strategy over it. |
| **Allocator role** | An address the owner sets may move funds between allowlisted strategies, at most `rebalanceLimit` assets per 24-hour window. The owner can rebalance too. |
| **One deposit target** | Deposits go to the strategy the owner designates; `maxDeposit` reflects its cap and its own limit. |
| **Withdrawal queue** | Withdrawals drain strategies in list order until the amount is paid; `maxWithdraw` is capped by what all strategies can pay right now. |
| **Price never reacts to a rebalance** | Deposits and withdrawals price against the last harvest plus the stream, as in the single-strategy vault. A rebalance moves funds, not the share price. `test_rebalanceDoesNotMoveThePrice` proves it. |

The three vaults share `LeanYieldBase`, which owns the harvest and the stream, and `LeanVaultBase`, which owns the accounting. Per transaction, with two allowlisted strategies:

| Call | Idle shell | One strategy | Allocator, two strategies |
|---|---|---|---|
| `deposit()` first, cold vault | 106,096 | 168,564 | 175,824 |
| `deposit()` subsequent | 54,796 | 83,064 | 90,324 |
| `withdraw()` | 53,291 | 76,089 | 82,939 |
| `redeem()` | 53,148 | 75,962 | 82,854 |
| `convertToShares()` | 3,002 | 5,380 | 5,403 |
| `harvest()` | | 48,512 | 66,850 |

The allocator's extra cost per write is the cap check, which reads the target strategy's valuation. Harvest grows with the number of strategies.

### The curator, with Jev

The allocator role is where software sits, and `curator/` is that software: a shadow-mode curator that watches real strategies, asks a model for typed judgments, and logs the rebalances it would propose. It holds no funds and no keys, and it sends nothing to any chain. Zero dependencies: Bun runs the TypeScript, the chain is read through plain JSON-RPC, and the model is [TypeSafe's Jev](https://docs.typesafe.ai) through its HTTP API.

**Why a System One model and not a chat model.** Jev does not write prose or reason out loud. It takes structured state and returns typed answers with calibrated probabilities: a yes-or-no probability, a score on described levels, a choice among named options. That is what a control loop wants. Every judgment is a logged, testable value, it is cheap enough to run every hour, and it is honest about uncertainty, which is the property that matters before anything moves money.

**The loop, as it runs today.**

| Step | What happens |
|---|---|
| Observe | Read `name`, `asset`, `totalAssets`, `convertToAssets`, `maxWithdraw` and `fee` for each strategy, verify the asset, append a snapshot. From the history: realized APY, TVL change, worst single-step price move. |
| Judge | Show Jev one strategy's numbers as named fields and ask three narrow questions. *Stress*: does this vault show signs a prudent allocator would react to within a day, as a probability. *Health*: a score on four described levels from healthy to exit now. *Action*: hold, reduce or exit. |
| Allocate | Deterministic code turns the answers into weights, clips targets by the caps, drops differences under a dead band, and lists the moves the allocator would submit within the 24-hour limit. Exit signals, high stress and low confidence are escalated to a person and the plan is flagged as needing approval. |
| Log | Snapshots, judgments and plans are appended under `curator/data/`. That record is what decides whether the agent ever gets the allocator key. |

**What the first live pass looked like.** Two mainnet USDC vaults, Steakhouse USDC and Gauntlet USDC Prime, about 89 million between them, on a ten-minute window:

| Vault | Stress | Health (0 to 3) | Confidence | Action |
|---|---|---|---|---|
| Steakhouse USDC | 0.16 | 0.90 | 0.33 | hold, 0.89 |
| Gauntlet USDC Prime | 0.16 | 1.05 | 0.25 | hold, 0.85 |

The model called both "hold" with high confidence and rated their health with low confidence, spreading probability across "healthy" and "watch" and keeping 14 to 17% on "exit now", because on ten minutes of history it had no realized yield and no liquidity figure, and it was told so. It did not pretend to know. The policy escalated the low confidence and proposed no move. That first run also caught a flaw in the policy, which had proposed moving 18,519 USDC on a 0.15 difference between two low-confidence scores; the dead band exists because of it. About 775 input tokens per strategy per pass.

**Twenty-two vaults, and a lesson in state.** The watchlist grew to 22 USDC vaults on Ethereum and Base, the two allocation targets plus 20 that are only ranked. Two of the 20 report numbers upstream that no lending vault could produce, and they are on the list unlabeled. The first pass with the full list ranked one of them third: the model had been shown only a flag for "price below one", and a vault claiming each share is worth 822 dollars was invisible in that state. With the share price and a code-computed plausibility check added to what it sees, both went to the bottom with an exit signal, health 2.9 out of 3. Same model, same vaults. What the model is shown decides what it can catch, and a pass over the real list is how you find out what it cannot see.

**The vaults it tracks.** All USDC, all ERC4626, all verified at startup by reading their name and asset. TVL as observed on 2026-09-26. Two of the watch-only entries are the deliberately planted implausible vaults described above, left unlabeled here as well.

| Vault | Chain | Address | TVL (USDC) | Role |
|---|---|---|---|---|
| Steakhouse USDC | Ethereum | [`0xBEEF…64CB`](https://etherscan.io/address/0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB) | 66.3M | allocation target |
| Steakhouse Prime USDC | Ethereum | [`0xbeef…0f51`](https://etherscan.io/address/0xbeef088055857739C12CD3765F20b7679Def0f51) | 123.3M | watch |
| Steakhouse USDC | Base | [`0xbeeF…8183`](https://basescan.org/address/0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183) | 126.7M | watch |
| Steakhouse Prime USDC | Base | [`0xbeef…73C9`](https://basescan.org/address/0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9) | 444.1M | watch |
| Gauntlet USDC Prime | Ethereum | [`0xdd0f…490d`](https://etherscan.io/address/0xdd0f28e19C1780eb6396170735D45153D261490d) | 23.0M | allocation target |
| Hakutora USDC | Ethereum | [`0x974c…40a9`](https://etherscan.io/address/0x974c8FBf4fd795F66B85B73ebC988A51F1A040a9) | 15.9M | watch |
| Smokehouse USDC | Ethereum | [`0xBEeF…f5bC`](https://etherscan.io/address/0xBEeFFF209270748ddd194831b3fa287a5386f5bC) | 13.6M | watch |
| Vault Bridge USDC | Ethereum | [`0xBEef…A9c4`](https://etherscan.io/address/0xBEefb9f61CC44895d8AEc381373555a64191A9c4) | 12.5M | watch |
| Gauntlet USDC RWA | Ethereum | [`0xA887…6C45`](https://etherscan.io/address/0xA8875aaeBc4f830524e35d57F9772FfAcbdD6C45) | 11.0M | watch |
| Yearn OG USDC | Ethereum | [`0xF9bd…Ec49`](https://etherscan.io/address/0xF9bdDd4A9b3A45f980e11fDDE96e16364dDBEc49) | 10.6M | watch |
| Spark Blue Chip USDC Vault | Ethereum | [`0x56A7…581D`](https://etherscan.io/address/0x56A76b428244a50513ec81e225a293d128fd581D) | 10.3M | watch |
| SwissBorg Morpho USDC | Ethereum | [`0x4Ff4…9E59`](https://etherscan.io/address/0x4Ff4186188f8406917293A9e01A1ca16d3cf9E59) | 9.2M | watch |
| Yearn USDC | Ethereum | [`0x68Ae…45A3`](https://etherscan.io/address/0x68Aea7b82Df6CcdF76235D46445Ed83f85F845A3) | 6.2M | watch |
| Gauntlet USDC Core | Ethereum | [`0x8eB6…d458`](https://etherscan.io/address/0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458) | 3.8M | watch |
|  Usual Boosted USDC | Ethereum | [`0xd630…3a3D`](https://etherscan.io/address/0xd63070114470f685b75B74D60EEc7c1113d33a3D) | 2.0M | watch |
| Safe x Steakhouse USDC | Ethereum | [`0xbEeF…D92F`](https://etherscan.io/address/0xbEeFCe6c76C7D7A8066562Fe9FF0e343a52dD92F) | 1.8M | watch |
| Hyperithm USDC Apex | Ethereum | [`0x7777…7777`](https://etherscan.io/address/0x777791C4d6DC2CE140D00D2828a7C93503c67777) | 1.6M | watch |
| Clearstar USDC Reactor | Ethereum | [`0x62fE…dC78`](https://etherscan.io/address/0x62fE596d59fB077c2Df736dF212E0AFfb522dC78) | 1.3M | watch |
| Fluid USD Coin | Ethereum | [`0x9Fb7…1B33`](https://etherscan.io/address/0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33) | 130.0M | watch |
| USDC-1 yVault | Ethereum | [`0xBe53…6204`](https://etherscan.io/address/0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204) | 19.6M | watch |
| Adpend USDC | Ethereum | [`0x5555…5555`](https://etherscan.io/address/0x55555815a5595991C3A0Ff119B59AEF6C8B55555) | 368.5M | watch |
| 1337 USDC | Ethereum | [`0x9464…96c1`](https://etherscan.io/address/0x94643e86aa5E38DDAc6c7791C1297f4E40cD96c1) | 196.5M | watch |

**Then thirty days of history from DefiLlama.** The judgments on the first pass were made on minutes of on-chain data, and it showed: health scores hovered around "watch" with low confidence for every legitimate vault. DefiLlama's yields index lists 20 of the 22 with a 30-day mean yield, its volatility and an outlier flag, matched once by TVL and pinned by pool id. With that in the state, the legitimate vaults settled between healthy and watch, the two planted ones still exit, and the bottom of the real set became the two that deserve it: a vault trading at 0.83 per share and one whose yield volatility is ten times its peers'. The two vaults the index does not list are the planted ones, and the model is shown exactly that.

**Then liquidity, measured instead of guessed.** ERC4626 has no view for how much could leave right now, so the curator simulates it: for one `eth_call`, a probe owns every share, and the vault is asked how much it would pay out. Until 2026-09-27 the field was null for 21 of the 22 vaults and wrong for the last. Measured, it runs from 22% for Fluid and Hyperithm Apex to fully or all but fully liquid for seven vaults, and the two planted vaults pay out nothing at all. On the same states with and without it, the model moved risk up for the thin vaults and down for the liquid ones, and changed no action.

**What it is not.** It does not predict yields, it sees only the fields it is shown, and it has no authority. The intended path from here is a pass every six hours for weeks, a comparison of its log with what a human curator would have done, and only then the allocator key, inside the caps and the window limit the contract enforces regardless.

**The same judgments face users too.** Matched against a stated horizon and tolerance, the per-strategy health scores become a recommendation of which vault fits, publishable as a signed statement anyone can verify. Same engine, different consumer.

Run it:

```sh
cd curator
cp .env.example .env            # add TYPESAFE_API_KEY
bun run observe                 # snapshots only, no key needed
bun run shadow                  # judgments plus the plan it would execute
bun test
```

## Quick start

```sh
git clone https://github.com/yodablocks/leanvault && cd leanvault
forge build
forge test        # 26 properties on each of the three vaults, plus the stream, guardrail and gas tests
```

## Roadmap

Done, in the order it happened:

- The shell: `LeanVault`, the cheapest ERC4626 accounting layer we could write, measured against Solady in [erc4626-bench](https://github.com/yodablocks/erc4626-bench).
- One strategy: `LeanYieldVault`, permissionless harvest with gains streamed and losses taken at once.
- Many strategies: `LeanAllocatorVault`, with the curator's authority bounded on-chain by a timelocked allowlist, caps and a per-window rebalance limit.
- The curator: `curator/`, watching 22 USDC vaults on Ethereum and Base, judging with Jev, logging what it would do. Runs every six hours on GitHub and appends to the `shadow-log` branch.
- `permit` on the share token, and the gas table re-measured against the vault as shipped.
- A [live page](https://yodablocks.github.io/leanvault/) for the shadow log, rebuilt after every pass.
- A record worth trusting: every pass checked for completeness, liquidity measured by simulation instead of guessed, a share price below 1 named as impairment in the rubric, and two watchdogs on the schedule, one of them outside GitHub.

**Now.** The shadow curator runs every six hours on 22 real USDC vaults, and its latest judgments are live at [yodablocks.github.io/leanvault](https://yodablocks.github.io/leanvault/). Liquidity has been measured and the rubric set since 2026-09-27, so the record counts from that date.

**Next.**

1. **Real strategies on a testnet.** Deploy `LeanAllocatorVault` against strategies that exist there, harvest for a week, and let the curator watch a vault it could actually move.

**Later.**

1. **Compare the record with a human curator.** Weeks of the agent's proposals against what a human curator would have done. Only that record decides whether the agent gets the allocator key.
2. **ERC-7540** request-based deposits and redemptions for anything with lockups.
3. **An external audit**, before any real funds. Nothing in this repository is a substitute for one.

## License

[MIT](LICENSE). Solady and forge-std are vendored under their own licenses. The a16z property suite under `lib/erc4626-tests` is AGPL-3.0 and test-only.
