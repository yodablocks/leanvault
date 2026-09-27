# leancurator

**Shadow-mode curator for `LeanAllocatorVault`: it watches real ERC4626 strategies, asks Jev for typed risk judgments, and logs the rebalances it would propose. It holds no funds and no keys.**

Zero dependencies. Bun runs the TypeScript directly; the chain is read through plain JSON-RPC and the model through the [TypeSafe HTTP API](https://docs.typesafe.ai/api).

## How it works

1. **Observe.** For each configured strategy, read `name`, `asset`, `totalAssets`, `convertToAssets` and `fee`, measure liquidity, and append a snapshot to `data/snapshots.jsonl`. From the history: realized APY, TVL change, worst single-step price move.
2. **Judge.** Show Jev one strategy's numbers as named fields and ask three narrow questions: is the vault under stress (a probability), how healthy is it on four described levels (a score), and which of hold, reduce, exit fits (a choice). Answers come back as probabilities with confidence; nothing is prose.
3. **Allocate.** Deterministic code turns judgments into weights, clips targets by the caps, and lists the moves the allocator would submit within the 24-hour limit. Exit signals, high stress and low confidence are escalated to a person instead of executed.
4. **Enrich.** [DefiLlama's yields index](https://yields.llama.fi/pools) supplies what the curator lacks on day one: each vault's current and 30-day mean yield, its yield volatility, its outlier flag, and whether the index lists the vault at all. Pools are matched once by chain, project and TVL and pinned by their stable pool id in `src/config.ts`. A vault that a major aggregator does not list is shown to the model as exactly that. If the index is unreachable the fields are omitted, not reported as "not listed".
5. **Measure liquidity.** ERC4626 has no view for how much could leave right now, and `maxWithdraw` answers per owner. So for one `eth_call` a probe address owns every share: `eth_createAccessList` shows which storage slot `balanceOf(probe)` reads, and a state override sets it to `totalSupply`. `maxWithdraw(probe)` is taken when a withdrawal of that much succeeds and one of 1% of TVL more reverts; otherwise the largest withdrawal that does not revert is found by bisection. Zero needs both `maxWithdraw` at zero and a one-dollar withdrawal reverting; anything unmeasurable is null. All of it is simulated at the snapshot's block, nothing is sent.
6. **Log.** Everything is appended under `data/`. In shadow mode nothing is ever sent to a chain.

## Run

```sh
cd curator
cp .env.example .env            # add TYPESAFE_API_KEY
bun run observe                 # snapshots only, no key needed
bun run judge                   # snapshots plus judgments
bun run shadow                  # judgments plus the plan it would execute
bun run health                  # is the newest pass whole? --age: is it recent?
bun test
```

The GitHub workflow runs a pass every six hours and appends to the `shadow-log` branch. Realized APY needs at least an hour of history, and the model is told how long it has been watching, so the first day of judgments is made on thin state by design.

GitHub starts scheduled runs late, three to five hours so far, so every pass ends with `health`, and it turns the run red if the pass is incomplete: a vault without a snapshot or a judgment, no plan, DefiLlama unreachable or a pinned pool gone, the history not restored (a vault's observed window did not grow), or snapshots taken alone because the key is missing. A gap of more than 18 hours since the previous pass fails it, more than 9 warns. Liquidity null for every vault in a pass also fails it, since that means the probe broke, not the vaults. A second workflow, `shadow-health`, reads the `shadow-log` branch once a day and fails if the newest pass is more than 18 hours old, which catches passes that never started. Both run on GitHub's scheduler, so neither notices if GitHub disables schedules for the repository, which it does to public repositories after 60 days without activity. `scripts/watch-shadow.sh` covers that from outside: run daily by a scheduler on the maintainer's machine (launchd, cron, anything that is not GitHub), it asks the GitHub API whether both scheduled workflows are still active and runs `health --age` on a fresh fetch of `shadow-log`, and on failure posts a macOS notification and a line to `~/Library/Logs/leanvault-shadow-watch.log`. It runs the curator code of whatever branch that clone has checked out. To check a copy of the log, point `CURATOR_DATA_DIR` at it:

```sh
git show origin/shadow-log:snapshots.jsonl > /tmp/log/snapshots.jsonl   # and judgments, proposals
CURATOR_DATA_DIR=/tmp/log bun run health
```

**Liquidity before 2026-09-27 is not a measurement.** Until then the probe asked what the vault's own address could withdraw, which is null for 21 of the 22 and the vault's own dust balance for the last. From the first pass after this change it is the measured fraction. Read the log's liquidity from that date on, and expect judgments to shift at it: in a controlled comparison on the same states, risk scores rose for the thinnest vaults (Hyperithm Apex at 22% liquid from 0.26 to 0.76 out of 3) and fell for the fully liquid ones, and no action changed.

**The rubric changed on the same day.** A share price below 1 is now named as impaired however liquid the vault is, in the risk levels and in the stress question. Before, only a single-step fall counted, and Gauntlet USDC Core, at 0.83 per share since before the curator started watching, was rated safer once its 83% liquidity was measured. On the same states, its risk went from 0.65 to 1.88 out of 3 and its stress from 0.20 to 0.48; the other 21 moved 0.05 on average (run-to-run noise is 0.03), and no action changed. A version that also required a price at or above 1 for "healthy" moved the others twice as much, mostly down, and was dropped.

## Configuration

`src/config.ts` lists the strategies, 22 USDC vaults on Ethereum and Base, each with a chain, an address, the cap the allocator vault would enforce, and whether it is part of the simulated allocation or watch-only. Watch-only vaults are judged and ranked, never allocated. Then the per-window rebalance limit and three thresholds: the stress probability that forces an exit, the minimum confidence below which a judgment is escalated rather than acted on, and the dead band under which a target delta is ignored. Addresses are verified at startup against `name()` and `asset()`.

Two of the 22 reported implausible numbers upstream and are on the list on purpose, unlabeled. With the share price in the state, the model puts both at the bottom with an exit signal; without it, it ranked one of them third. What the model is shown decides what it can catch.

## What this is not

It does not predict yields, it does not see anything outside the fields it is shown, and it has no authority. The point of shadow mode is a log of proposals against real markets that can be compared with what a human curator would have done. Only that record decides whether the agent ever gets the allocator key, and even then the on-chain caps and window limit bound what it can do.
