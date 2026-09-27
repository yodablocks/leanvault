import { SEL, decodeAddress, decodeString, decodeUint, encodeAddress, encodeUint } from "./abi";
import { RevertError, type CallOptions, type Rpc } from "./rpc";
import type { StrategyConfig } from "./config";

/** One reading of one strategy. Everything the judgments see comes from here. */
export interface Snapshot {
  label: string;
  chain: string;
  address: string;
  name: string;
  assetSymbol: string;
  assetDecimals: number;
  block: number;
  timestamp: number;
  /** Whole asset units. */
  totalAssets: number;
  /** Assets per one whole share, in whole asset units. */
  pricePerShare: number;
  /** Fraction of totalAssets a holder of every share could withdraw at this block; null if it could not be measured. */
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
  const [symHex, decRaw, shareDecRaw, totalAssets, totalSupply, fee] = await Promise.all([
    rpc.call(asset, SEL.symbol),
    callUint(rpc, asset, SEL.decimals),
    callUint(rpc, s.address, SEL.decimals),
    callUint(rpc, s.address, SEL.totalAssets),
    callUint(rpc, s.address, SEL.totalSupply),
    callUint(rpc, s.address, SEL.fee),
  ]);
  const decimals = Number(decRaw ?? 18n);
  const unit = 10 ** decimals;
  // Share decimals differ between vaults (6 for some, 18 for others), so price
  // per share is read for exactly one share, not for 1e18 raw units.
  const shareDecimals = Number(shareDecRaw ?? 18n);
  // Ask for a million shares and divide, so a 6-decimal asset still yields
  // twelve significant decimals of price: hourly growth at 5% a year is about
  // 6e-6, which a single share's 6 decimals would barely resolve.
  const ppsMillion = await callUint(rpc, s.address, SEL.convertToAssets + encodeUint(10n ** BigInt(shareDecimals + 6)));
  const liquidityRatio =
    totalAssets && totalSupply
      ? await probeLiquidity(rpc, s.address, { totalSupply, totalAssets, unit: 10n ** BigInt(decimals), block: block.number })
      : null;
  const ta = Number(totalAssets ?? 0n) / unit;
  return {
    label: s.label,
    chain: s.chain,
    address: s.address,
    name: decodeString(nameHex),
    assetSymbol: decodeString(symHex),
    assetDecimals: decimals,
    block: Number(block.number),
    timestamp: block.timestamp,
    totalAssets: ta,
    pricePerShare: Number(ppsMillion ?? 0n) / unit / 1e6,
    liquidityRatio,
    fee: fee === null ? null : Number(fee) / 1e18,
  };
}

// A holder that does not exist, given every share for the length of one eth_call.
const PROBE = "0x00000000000000000000000000000000c0ffee00";

/**
 * How much of the vault could leave right now. ERC4626 has no view for that,
 * and maxWithdraw is per owner, so the probe becomes the owner of every share:
 * eth_createAccessList shows which storage slot balanceOf(probe) reads, and a
 * state override sets it to totalSupply. Then:
 * - maxWithdraw is taken when a withdrawal of that much succeeds and one of 1%
 *   of TVL more reverts, or when it covers everything;
 * - otherwise, the largest withdrawal that does not revert is found by
 *   bisection, to a millionth of TVL;
 * - zero only when maxWithdraw says zero and one whole unit cannot leave;
 * - null when the slot cannot be found, the sources disagree, or anything
 *   fails. Never throws, so one vault cannot sink a pass.
 * Every call is pinned to the snapshot's block.
 */
export async function probeLiquidity(
  rpc: Rpc,
  vault: string,
  o: { totalSupply: bigint; totalAssets: bigint; unit: bigint; block: bigint },
): Promise<number | null> {
  try {
    const ta = o.totalAssets;
    const at: CallOptions = { from: PROBE, block: o.block };
    const balanceOf = SEL.balanceOf + encodeAddress(PROBE);
    const lists = await rpc.accessList(vault, balanceOf, at);
    const keys = lists.filter((e) => e.address.toLowerCase() === vault.toLowerCase()).flatMap((e) => e.storageKeys);
    let opts: CallOptions | null = null;
    for (const key of keys) {
      const override = { [vault]: { stateDiff: { [key]: "0x" + encodeUint(o.totalSupply) } } };
      const bal = await rpc.call(vault, balanceOf, { ...at, override }).then(decodeUint, () => null);
      if (bal === o.totalSupply) { opts = { ...at, override }; break; }
    }
    if (!opts) return null;
    const pinned = opts;
    const canWithdraw = async (assets: bigint) => {
      try {
        await rpc.call(vault, SEL.withdraw + encodeUint(assets) + encodeAddress(PROBE) + encodeAddress(PROBE), pinned);
        return true;
      } catch (e) {
        if (e instanceof RevertError) return false;
        throw e;
      }
    };
    const ratio = (assets: bigint) => Math.min(1, Number(assets) / Number(ta));
    const maxW = decodeUint(await rpc.call(vault, SEL.maxWithdraw + encodeAddress(PROBE), pinned));
    if (maxW > 0n && (await canWithdraw(maxW))) {
      if (maxW >= ta || !(await canWithdraw(maxW + ta / 100n))) return ratio(maxW);
    }
    if (!(await canWithdraw(o.unit))) return maxW === 0n ? 0 : null;
    if (await canWithdraw(ta)) return 1;
    let lo = o.unit, hi = ta;
    const precision = ta / 1_000_000n + 1n;
    while (hi - lo > precision) {
      const mid = (lo + hi) / 2n;
      if (await canWithdraw(mid)) lo = mid;
      else hi = mid;
    }
    return ratio(lo);
  } catch {
    return null;
  }
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

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
