import { SEL, decodeAddress, decodeString, decodeUint, encodeAddress, encodeUint } from "./abi";
import type { Rpc } from "./rpc";
import type { StrategyConfig } from "./config";

/** One reading of one strategy. Everything the judgments see comes from here. */
export interface Snapshot {
  label: string;
  address: string;
  name: string;
  assetSymbol: string;
  assetDecimals: number;
  block: number;
  timestamp: number;
  /** Whole asset units. */
  totalAssets: number;
  /** Assets per 1e18 shares, in whole asset units. */
  pricePerShare: number;
  /** Fraction of totalAssets withdrawable right now by a hypothetical holder of everything. */
  liquidityRatio: number | null;
  /** Fee in WAD if the vault exposes fee(), else null. */
  fee: number | null;
}

async function callUint(rpc: Rpc, to: string, data: string): Promise<bigint | null> {
  try {
    return decodeUint(await rpc.call(to, data));
  } catch {
    return null;
  }
}

export async function observe(rpc: Rpc, s: StrategyConfig): Promise<Snapshot> {
  const [block, nameHex, assetHex] = await Promise.all([
    rpc.latestBlock(),
    rpc.call(s.address, SEL.name),
    rpc.call(s.address, SEL.asset),
  ]);
  const asset = decodeAddress(assetHex);
  const [symHex, decRaw, totalAssets, totalSupply, pps, fee] = await Promise.all([
    rpc.call(asset, SEL.symbol),
    callUint(rpc, asset, SEL.decimals),
    callUint(rpc, s.address, SEL.totalAssets),
    callUint(rpc, s.address, SEL.totalSupply),
    callUint(rpc, s.address, SEL.convertToAssets + encodeUint(10n ** 18n)),
    callUint(rpc, s.address, SEL.fee),
  ]);
  const decimals = Number(decRaw ?? 18n);
  const unit = 10 ** decimals;
  // Liquidity: vaults answer maxWithdraw per owner, and there is no universal
  // view for "how much could leave right now". Asking about the vault's own
  // address gives a real number only for implementations that clamp by global
  // liquidity before balance. A zero answer therefore means unknown, not
  // frozen, and is reported as null so the model is not told a falsehood.
  const maxW = await callUint(rpc, s.address, SEL.maxWithdraw + encodeAddress(s.address));
  const ta = Number(totalAssets ?? 0n) / unit;
  return {
    label: s.label,
    address: s.address,
    name: decodeString(nameHex),
    assetSymbol: decodeString(symHex),
    assetDecimals: decimals,
    block: Number(block.number),
    timestamp: block.timestamp,
    totalAssets: ta,
    pricePerShare: Number(pps ?? 0n) / unit,
    liquidityRatio: maxW === null || maxW === 0n || ta === 0 ? null : Math.min(1, Number(maxW) / unit / ta),
    fee: fee === null ? null : Number(fee) / 1e18,
  };
}

/** Derived signals from the history of snapshots for one strategy. */
export interface Signals {
  label: string;
  observedDays: number;
  /** Annualized from price-per-share change over the whole window, null if under 1 hour. */
  realizedApy: number | null;
  /** Fractional TVL change over the window. */
  tvlChange: number | null;
  /** Largest single-step drop in price per share, as a fraction. Negative means a loss. */
  worstPriceStep: number | null;
}

export function signals(history: Snapshot[]): Signals {
  const s = [...history].sort((a, b) => a.timestamp - b.timestamp);
  const first = s[0];
  const last = s[s.length - 1];
  if (!first || !last) return { label: "?", observedDays: 0, realizedApy: null, tvlChange: null, worstPriceStep: null };
  const seconds = last.timestamp - first.timestamp;
  const days = seconds / 86_400;
  let realizedApy: number | null = null;
  if (seconds >= 3_600 && first.pricePerShare > 0) {
    const growth = last.pricePerShare / first.pricePerShare;
    realizedApy = Math.pow(growth, 365 / days) - 1;
  }
  let worst: number | null = null;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!, b = s[i]!;
    if (a.pricePerShare > 0) {
      const step = b.pricePerShare / a.pricePerShare - 1;
      worst = worst === null ? step : Math.min(worst, step);
    }
  }
  return {
    label: last.label,
    observedDays: days,
    realizedApy,
    tvlChange: first.totalAssets > 0 ? last.totalAssets / first.totalAssets - 1 : null,
    worstPriceStep: worst,
  };
}
