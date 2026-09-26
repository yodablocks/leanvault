// The strategies shadow mode watches. Read-only mainnet ERC4626 vaults; the
// curator holds no funds and no keys. Addresses are verified at startup by
// reading name() and asset(); a mismatch stops the run.
export type Chain = "ethereum" | "base";

export interface StrategyConfig {
  /** Short label used in logs and judgments. */
  label: string;
  chain: Chain;
  address: string;
  /** Cap in whole asset units, as the allocator vault would enforce. */
  cap: number;
  /** Part of the simulated allocation. Watch-only strategies are judged and ranked, never allocated. */
  allocate?: boolean;
}

export interface CuratorConfig {
  /** JSON-RPC endpoint per chain. Alchemy or any provider; public endpoints throttle at this call volume. */
  rpc: Record<Chain, string>;
  /** Vaults observed in parallel; each vault is several calls. */
  concurrency: number;
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
  rpc: {
    ethereum: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    base: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  },
  concurrency: Number(process.env.CURATOR_CONCURRENCY ?? 2),
  assetSymbol: "USDC",
  // Twenty-three USDC vaults on Ethereum and Base. The first two are the simulated allocation;
  // the rest are watched and ranked. Sourced from Morpho's public API and
  // direct on-chain reads; every address is re-verified at startup. Two
  // entries near the end reported implausible numbers upstream and are here
  // on purpose, unlabeled, to see whether the judgments catch them.
  strategies: [
    { label: "steakhouse-usdc", chain: "ethereum", address: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB", cap: 600_000, allocate: true },
    { label: "steakhouse-prime-usdc", chain: "ethereum", address: "0xbeef088055857739C12CD3765F20b7679Def0f51", cap: 0 },
    { label: "steakhouse-usdc-base", chain: "base", address: "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183", cap: 0 },
    { label: "steakhouse-prime-usdc-base", chain: "base", address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", cap: 0 },
    { label: "gauntlet-usdc-prime", chain: "ethereum", address: "0xdd0f28e19C1780eb6396170735D45153D261490d", cap: 600_000, allocate: true },
    { label: "hakutora-usdc", chain: "ethereum", address: "0x974c8FBf4fd795F66B85B73ebC988A51F1A040a9", cap: 0 },
    { label: "smokehouse-usdc", chain: "ethereum", address: "0xBEeFFF209270748ddd194831b3fa287a5386f5bC", cap: 0 },
    { label: "vault-bridge-usdc", chain: "ethereum", address: "0xBEefb9f61CC44895d8AEc381373555a64191A9c4", cap: 0 },
    { label: "gauntlet-usdc-rwa", chain: "ethereum", address: "0xA8875aaeBc4f830524e35d57F9772FfAcbdD6C45", cap: 0 },
    { label: "yearn-og-usdc", chain: "ethereum", address: "0xF9bdDd4A9b3A45f980e11fDDE96e16364dDBEc49", cap: 0 },
    { label: "spark-blue-chip-usdc", chain: "ethereum", address: "0x56A76b428244a50513ec81e225a293d128fd581D", cap: 0 },
    { label: "swissborg-morpho-usdc", chain: "ethereum", address: "0x4Ff4186188f8406917293A9e01A1ca16d3cf9E59", cap: 0 },
    { label: "yearn-usdc-morpho", chain: "ethereum", address: "0x68Aea7b82Df6CcdF76235D46445Ed83f85F845A3", cap: 0 },
    { label: "gauntlet-usdc-core", chain: "ethereum", address: "0x8eB67A509616cd6A7c1B3c8C21D48FF57df3d458", cap: 0 },
    { label: "usual-boosted-usdc", chain: "ethereum", address: "0xd63070114470f685b75B74D60EEc7c1113d33a3D", cap: 0 },
    { label: "safe-steakhouse-usdc", chain: "ethereum", address: "0xbEeFCe6c76C7D7A8066562Fe9FF0e343a52dD92F", cap: 0 },
    { label: "hyperithm-usdc-apex", chain: "ethereum", address: "0x777791C4d6DC2CE140D00D2828a7C93503c67777", cap: 0 },
    { label: "clearstar-usdc-reactor", chain: "ethereum", address: "0x62fE596d59fB077c2Df736dF212E0AFfb522dC78", cap: 0 },
    { label: "fluid-usdc", chain: "ethereum", address: "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", cap: 0 },
    { label: "aave-static-usdc", chain: "ethereum", address: "0x73edDFa87C71ADdC275c2b9890f5c3a8480bC9E6", cap: 0 },
    { label: "yearn-usdc-1", chain: "ethereum", address: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204", cap: 0 },
    { label: "adpend-usdc", chain: "ethereum", address: "0x55555815a5595991C3A0Ff119B59AEF6C8B55555", cap: 0 },
    { label: "1337-usdc", chain: "ethereum", address: "0x94643e86aa5E38DDAc6c7791C1297f4E40cD96c1", cap: 0 },
  ],
  currentAllocation: { "steakhouse-usdc": 500_000, "gauntlet-usdc-prime": 500_000 },
  rebalanceLimit: 200_000,
  thresholds: { stressExit: 0.7, minConfidence: 0.6, minMoveFraction: 0.05 },
};
