# leanvault

**The cheapest ERC4626 accounting shell we could write in plain Solidity. A floor to build yield vaults on.**

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

Not in it: `permit` on the share token, any yield logic, any fee. Those are the roadmap.

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

## Quick start

```sh
git clone https://github.com/yodablocks/leanvault && cd leanvault
forge build
forge test        # a16z's 26 ERC4626 properties, zero tolerance
```

## Roadmap

1. **A yield strategy.** A single-market lender that recognizes gains through an explicit, owner-gated function. The packed accounting makes that safe by construction, since balance changes never move the price on their own.
2. **`permit`** on the share token, then re-measure deployment.
3. **ERC-7540** request-based deposits and redemptions for anything with lockups.
4. **An external audit**, before any real funds. Nothing in this repository is a substitute for one.

## License

[MIT](LICENSE). Solady and forge-std are vendored under their own licenses. The a16z property suite under `lib/erc4626-tests` is AGPL-3.0 and test-only.
