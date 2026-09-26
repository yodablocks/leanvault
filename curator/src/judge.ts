// Typed judgments from a System One model over one strategy's observed state.
// The model never sees prose about what to do; it answers three narrow questions
// and code decides. See https://docs.typesafe.ai/api
import type { Signals, Snapshot } from "./observe";

export interface JudgeClient {
  systemOne(body: unknown): Promise<any>;
}

export function makeTypeSafeClient(apiKey: string, fetchImpl: typeof fetch = fetch): JudgeClient {
  return {
    async systemOne(body) {
      const res = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`typesafe: http ${res.status} ${await res.text()}`);
      return res.json();
    },
  };
}

/** What the model is shown. Named fields, numbers rounded, no free text. */
export interface StrategyState {
  label: string;
  vault_name: string;
  asset: string;
  observed_days: number;
  tvl_assets: number;
  tvl_change_over_window: number | null;
  realized_apy_over_window: number | null;
  worst_single_step_price_change: number | null;
  /** null means the vault does not expose it, not that it is zero. */
  liquidity_ratio_now: number | null;
  vault_fee_fraction: number | null;
  is_price_per_share_below_one: boolean;
}

export function buildState(snap: Snapshot, sig: Signals): StrategyState {
  const r = (x: number | null, d = 6) => (x === null ? null : Number(x.toFixed(d)));
  return {
    label: snap.label,
    vault_name: snap.name,
    asset: snap.assetSymbol,
    observed_days: Number(sig.observedDays.toFixed(3)),
    tvl_assets: Math.round(snap.totalAssets),
    tvl_change_over_window: r(sig.tvlChange),
    realized_apy_over_window: r(sig.realizedApy),
    worst_single_step_price_change: r(sig.worstPriceStep, 8),
    liquidity_ratio_now: r(snap.liquidityRatio, 4),
    vault_fee_fraction: r(snap.fee, 4),
    is_price_per_share_below_one: snap.pricePerShare > 0 && snap.pricePerShare < 1,
  };
}

export const RISK_LEVELS = [
  "Healthy: yield steady and positive, deposits stable or growing, no price drops, liquidity ample.",
  "Watch: something moved but nothing broke, such as a noticeable outflow of deposits, yield well below the norm for this kind of vault, or thin liquidity that would delay a large withdrawal.",
  "Impaired: the share price fell in a single step, or liquidity is so thin that most depositors could not exit, or yield turned negative over the window.",
  "Exit now: the vault has lost a material part of its assets, or withdrawals are effectively frozen, or the observed state is inconsistent with a functioning vault.",
] as const;

export const questions = {
  stress: {
    type: "noul",
    instructions:
      "Does this ERC4626 vault show signs of stress that a prudent allocator would react to within the next day? Judge from the observed numbers only: deposit outflows, a falling or negative yield, a drop in share price, thin liquidity, or a fee out of line with a passive vault. A null field means the value is not observable, not that it is zero. A short observation window alone is not stress.",
  },
  risk: {
    type: "score",
    instructions: "How healthy is this vault right now, judged from its observed state?",
    criteria: RISK_LEVELS,
  },
  action: {
    type: "choice",
    instructions:
      "For an allocator holding a position in this vault, which single action fits the observed state? Hold keeps the position. Reduce moves part of it elsewhere. Exit moves all of it elsewhere. Prefer hold when the numbers are unremarkable.",
    criteria: {
      hold: "Keep the current position.",
      reduce: "Move part of the position to other strategies.",
      exit: "Move the entire position out of this vault.",
    },
  },
} as const;

export interface Judgment {
  label: string;
  stress: number;
  risk: { score: number; probabilities: Record<string, number>; confidence: number };
  action: { choice: "hold" | "reduce" | "exit"; probabilities: Record<string, number>; confidence: number };
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export async function judge(client: JudgeClient, state: StrategyState): Promise<Judgment> {
  const res = await client.systemOne({ state, model: "jev-latest", questions });
  const a = res.answers;
  return {
    label: state.label,
    stress: a.stress.noul,
    risk: { score: a.risk.score, probabilities: a.risk.probabilities, confidence: a.risk.confidence },
    action: { choice: a.action.choice, probabilities: a.action.probabilities, confidence: a.action.confidence },
    model: res.model,
    usage: res.usage,
  };
}
