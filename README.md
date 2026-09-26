# leanvault

**The cheapest ERC4626 accounting shell we could write in plain Solidity, a yield vault built on it, and a multi-strategy allocator whose curator can be wrong without being able to drain it.**

leanvault keeps the two totals and the pause flag in one storage slot, puts the reentrancy guard in transient storage, writes the share supply once, and replaces the first-deposit burn with a virtual share in the price formula. No assembly anywhere. Per transaction it sits within 0.2% of Solady's ERC4626 on every repeated call while carrying a pause switch and a reentrancy guard that the baseline lacks, its views cost a third as much, and on EraVM it is the cheapest of the five vaults in [erc4626-bench](https://github.com/yodablocks/erc4626-bench) on every row.

![Solidity](https://img.shields.io/badge/Solidity-0.8.37-363636?logo=solidity&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-unaudited-orange)

---

## Why

Every yield vault needs an accounting layer before the interesting part starts, and the accounting layer is paid on every deposit. Most of them inherit one that reads two or three storage slots per call and keeps a storage-based reentrancy guard. This one was designed backwards from the gas: what is the least a correct ERC4626 shell with a pause and a guard can cost? The answer turned out to be three declarations and one arithmetic trick, and the story of how it was measured is in the [YulSafe write-up](https://github.com/yodablocks/yulsafe/blob/main/docs/the-compiler-was-fine.md).

## What is in it

| | |
|---|---|
| **One slot** | `totalAssets` (96 bits), `totalSupply` (96 bits) and the pause flag (8 bits) share a word. Every path reads one slot and writes one slot. |
| **Transient guard** | Solady's `ReentrancyGuardTransient`, two TSTOREs per call instead of a cold SLOAD and two SSTOREs. Requires cancun. |
| **Supply written once** | The share token is minimal and reads its supply from the packed word, so a deposit updates supply in the same write as the totals. |
| **Virtual share** | One virtual share and one virtual asset in the price formula, the way Solady defends against inflation. No storage write on the first deposit. Donations never move the price anyway, since the vault never reads its own balance. |
| **Owner** | One slot, one transfer function, no handover machinery, no payable functions. |
| **Rounding** | Deposit and redeem round down what the user gets, mint and withdraw round up what the user pays. Previews equal the real calls. |

Not in it: `permit` on the share token, any fee. Those are the roadmap.

## Gas

From [erc4626-bench](https://github.com/yodablocks/erc4626-bench), per transaction, solc 0.8.37, optimizer at 10,000,000 runs:

| Call | leanvault | Solady ERC4626 |
|---|---|---|
| `deposit()` first, cold vault | 106,096 | 106,009 |
| `deposit()` subsequent | 54,796 | 54,709 |
| `mint()` | 54,843 | 54,735 |
| `withdraw()` | 53,264 | 54,576 |
| `redeem()` | 53,126 | 53,284 |
| `totalAssets()` | 2,321 | 5,621 |
| `convertToShares()` | 3,002 | 8,072 |
| Deployment gas | 1,764,437 | 1,185,598 |

Solady deploys for a third less because it does less. Everything a user repeats costs the same or less here, with more protection.

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

### An automated curator

The allocator role is where an off-chain agent would sit. The vault does not care who holds the key, which is the point: the guardrails above are what make it safe to hand the key to software. The intended loop, not yet built:

1. Code gathers structured state per strategy from on-chain reads: utilization, rate history, TVL flow, oracle status, age, audits.
2. A System One model such as [TypeSafe's Jev](https://docs.typesafe.ai) returns typed judgments over that state, not prose: the probability that a strategy shows signs of stress, a risk level on described tiers, and a bounded action per strategy among hold, reduce and exit. Every judgment is a logged, testable value with a calibrated probability.
3. Deterministic code turns judgments into target weights, clips them by the caps, and proposes rebalances within the window limit. Low-confidence judgments and any exit signal go to a person first.
4. The agent runs in shadow mode, logging what it would do against real state, before it is given the allocator key. It earns the key with a track record.

The same risk judgments can face users as well: matched against a stated horizon and tolerance, they become a recommendation of which vault fits, published as a signed statement anyone can verify.

## Quick start

```sh
git clone https://github.com/yodablocks/leanvault && cd leanvault
forge build
forge test        # 26 properties on each of the three vaults, plus the stream, guardrail and gas tests
```

## Roadmap

1. ~~A yield strategy.~~ Done: `LeanYieldVault`, permissionless harvest with streamed gains.
2. ~~Multiple strategies with bounded curator authority.~~ Done: `LeanAllocatorVault`.
3. **The curator agent in shadow mode**: the off-chain loop above, logging proposals against real strategies before it holds a key.
4. **Real strategies on a testnet**, with the allocator deployed against them and harvested for a week.
5. **`permit`** on the share token, then re-measure deployment.
6. **ERC-7540** request-based deposits and redemptions for anything with lockups.
7. **An external audit**, before any real funds. Nothing in this repository is a substitute for one.

## License

[MIT](LICENSE). Solady and forge-std are vendored under their own licenses. The a16z property suite under `lib/erc4626-tests` is AGPL-3.0 and test-only.
