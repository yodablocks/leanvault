# leancurator

**Shadow-mode curator for `LeanAllocatorVault`: it watches real ERC4626 strategies, asks Jev for typed risk judgments, and logs the rebalances it would propose. It holds no funds and no keys.**

Zero dependencies. Bun runs the TypeScript directly; the chain is read through plain JSON-RPC and the model through the [TypeSafe HTTP API](https://docs.typesafe.ai/api).

## How it works

1. **Observe.** For each configured strategy, read `name`, `asset`, `totalAssets`, `convertToAssets(1e18)`, `maxWithdraw` and `fee` and append a snapshot to `data/snapshots.jsonl`. From the history: realized APY, TVL change, worst single-step price move.
2. **Judge.** Show Jev one strategy's numbers as named fields and ask three narrow questions: is the vault under stress (a probability), how healthy is it on four described levels (a score), and which of hold, reduce, exit fits (a choice). Answers come back as probabilities with confidence; nothing is prose.
3. **Allocate.** Deterministic code turns judgments into weights, clips targets by the caps, and lists the moves the allocator would submit within the 24-hour limit. Exit signals, high stress and low confidence are escalated to a person instead of executed.
4. **Log.** Everything is appended under `data/`. In shadow mode nothing is ever sent to a chain.

## Run

```sh
cd curator
cp .env.example .env            # add TYPESAFE_API_KEY
bun run observe                 # snapshots only, no key needed
bun run judge                   # snapshots plus judgments
bun run shadow                  # judgments plus the plan it would execute
bun test
```

The GitHub workflow runs a pass every six hours and appends to the `shadow-log` branch. Realized APY needs at least an hour of history, and the model is told how long it has been watching, so the first day of judgments is made on thin state by design.

## Configuration

`src/config.ts` lists the strategies, 23 USDC vaults on Ethereum and Base, each with a chain, an address, the cap the allocator vault would enforce, and whether it is part of the simulated allocation or watch-only. Watch-only vaults are judged and ranked, never allocated. Then the per-window rebalance limit and three thresholds: the stress probability that forces an exit, the minimum confidence below which a judgment is escalated rather than acted on, and the dead band under which a target delta is ignored. Addresses are verified at startup against `name()` and `asset()`.

Two of the 23 reported implausible numbers upstream and are on the list on purpose, unlabeled. With the share price in the state, the model puts both at the bottom with an exit signal; without it, it ranked one of them third. What the model is shown decides what it can catch.

## What this is not

It does not predict yields, it does not see anything outside the fields it is shown, and it has no authority. The point of shadow mode is a log of proposals against real markets that can be compared with what a human curator would have done. Only that record decides whether the agent ever gets the allocator key, and even then the on-chain caps and window limit bound what it can do.
