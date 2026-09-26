// DefiLlama's yields index: https://yields.llama.fi/pools. Third-party history
// the curator lacks on day one: 30-day mean yield, its volatility, an outlier
// flag, and whether the vault is listed at all.
export interface LlamaPool {
  pool: string;
  chain: string;
  project: string;
  tvlUsd: number;
  apy: number | null;
  apyMean30d: number | null;
  sigma: number | null;
  outlier: boolean;
  apyPct30D: number | null;
}

export interface Aggregator {
  listed: boolean;
  apyNowPct: number | null;
  apyMean30dPct: number | null;
  apyVolatility30d: number | null;
  apyChange30dPct: number | null;
  flaggedOutlier: boolean | null;
  tvlUsd: number | null;
}

export async function fetchLlamaPools(fetchImpl: typeof fetch = fetch): Promise<Map<string, LlamaPool>> {
  const res = await fetchImpl("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`defillama: http ${res.status}`);
  const json = (await res.json()) as { data: LlamaPool[] };
  return new Map(json.data.map((p) => [p.pool, p]));
}

export function aggregatorFor(pools: Map<string, LlamaPool> | null, poolId: string | undefined): Aggregator | null {
  if (!pools) return null; // fetch failed: say nothing rather than "not listed"
  const p = poolId ? pools.get(poolId) : undefined;
  if (!p) return { listed: false, apyNowPct: null, apyMean30dPct: null, apyVolatility30d: null, apyChange30dPct: null, flaggedOutlier: null, tvlUsd: null };
  return {
    listed: true,
    apyNowPct: p.apy,
    apyMean30dPct: p.apyMean30d,
    apyVolatility30d: p.sigma,
    apyChange30dPct: p.apyPct30D,
    flaggedOutlier: p.outlier,
    tvlUsd: p.tvlUsd,
  };
}
