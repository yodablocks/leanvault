import { describe, expect, test } from "bun:test";
import { aggregatorFor, fetchLlamaPools, type LlamaPool } from "../src/llama";
import { buildState } from "../src/judge";
import { signals, type Snapshot } from "../src/observe";

const pool: LlamaPool = { pool: "p1", chain: "Ethereum", project: "morpho-blue", tvlUsd: 66e6, apy: 4.33, apyMean30d: 4.10, sigma: 0.035, outlier: false, apyPct30D: 0.31 };

function snap(): Snapshot {
  return { label: "a", chain: "ethereum", address: "0x1", name: "Vault A", assetSymbol: "USDC", assetDecimals: 6, block: 1, timestamp: 0, totalAssets: 66e6, pricePerShare: 1.14, liquidityRatio: null, fee: 0.05 };
}

describe("aggregatorFor", () => {
  const pools = new Map([[pool.pool, pool]]);
  test("listed pool carries the index's history", () => {
    const a = aggregatorFor(pools, "p1")!;
    expect(a.listed).toBe(true);
    expect(a.apyMean30dPct).toBe(4.10);
    expect(a.flaggedOutlier).toBe(false);
  });
  test("unknown id or no id means not listed, which is a fact worth showing", () => {
    expect(aggregatorFor(pools, "nope")!.listed).toBe(false);
    expect(aggregatorFor(pools, undefined)!.listed).toBe(false);
  });
  test("a failed fetch says nothing rather than claiming not listed", () => {
    expect(aggregatorFor(null, "p1")).toBeNull();
  });
});

describe("buildState with aggregator", () => {
  test("adds the aggregator block only when there is one", () => {
    const sig = signals([snap()]);
    const withAgg = buildState(snap(), sig, aggregatorFor(new Map([[pool.pool, pool]]), "p1"));
    expect(withAgg.aggregator?.apy_mean_30d_pct).toBe(4.1);
    expect(buildState(snap(), sig, null).aggregator).toBeUndefined();
  });
});

describe("fetchLlamaPools", () => {
  test("indexes the response by pool id", async () => {
    const fake = (async () => new Response(JSON.stringify({ data: [pool] }), { status: 200 })) as unknown as typeof fetch;
    const pools = await fetchLlamaPools(fake);
    expect(pools.get("p1")?.tvlUsd).toBe(66e6);
  });
});
