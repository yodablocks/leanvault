// The strategies shadow mode watches. Read-only mainnet ERC4626 vaults; the
// curator holds no funds and no keys. Addresses are verified at startup by
// reading name() and asset(); a mismatch stops the run.
export interface StrategyConfig {
  /** Short label used in logs and judgments. */
  label: string;
  address: string;
  /** Cap in whole asset units, as the allocator vault would enforce. */
  cap: number;
}

export interface CuratorConfig {
  rpcUrl: string;
  /** All strategies must share this asset symbol; verified at startup. */
  assetSymbol: string;
  strategies: StrategyConfig[];
  /** Simulated current allocation in whole asset units, for proposals. */
  currentAllocation: Record<string, number>;
  /** Assets the allocator may move per 24-hour window, whole units. */
  rebalanceLimit: number;
  /** Judgment thresholds; see allocate.ts. */
  thresholds: {
    stressExit: number;
    minConfidence: number;
    /** Ignore target deltas smaller than this fraction of total allocation. */
    minMoveFraction: number;
  };
}

export const config: CuratorConfig = {
  rpcUrl: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  assetSymbol: "USDC",
  strategies: [
    { label: "steakhouse-usdc", address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", cap: 600_000 },
    { label: "gauntlet-usdc-prime", address: "0xdd0f28e19C1780eb6396170735D45153D261490d", cap: 600_000 },
  ],
  currentAllocation: { "steakhouse-usdc": 500_000, "gauntlet-usdc-prime": 500_000 },
  rebalanceLimit: 200_000,
  thresholds: { stressExit: 0.7, minConfidence: 0.6, minMoveFraction: 0.05 },
};
