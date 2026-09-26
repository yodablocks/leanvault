// Deterministic policy over the judgments. All the arithmetic lives here, and
// none of it is inside the model. Changing a weight never re-runs inference.
import type { Judgment } from "./judge";
import type { CuratorConfig } from "./config";
import { RISK_LEVELS } from "./judge";

export interface Proposal {
  label: string;
  current: number;
  target: number;
  /** Positive means add, negative means remove, whole asset units. */
  delta: number;
  weight: number;
  escalate: string[];
}

export interface Ranked {
  label: string;
  weight: number;
  stress: number;
  risk: number;
  action: string;
}

export interface Plan {
  /** Every judged strategy, best first, whether or not it is allocatable. */
  ranking: Ranked[];
  proposals: Proposal[];
  /** Moves the allocator would submit now, bounded by the window limit. */
  moves: { from: string; to: string; assets: number }[];
  escalations: string[];
  /** True when any escalation exists: the moves are a recommendation for a person, not an action. */
  needsApproval: boolean;
}

const TOP = RISK_LEVELS.length - 1;

/** Raw attractiveness in [0, 1]: yield-weighted, risk-weighted. Zero on an exit signal. `apy` is the realized yield when known, else the aggregator's 30-day mean. */
export function weightOf(j: Judgment, apy: number | null, thresholds: CuratorConfig["thresholds"]): number {
  if (j.action.choice === "exit" || j.stress >= thresholds.stressExit) return 0;
  const risk = j.risk.score / TOP; // 0 healthy, 1 exit
  const yieldFactor = apy === null ? 0.5 : Math.max(0, Math.min(1, 0.5 + apy * 10)); // 0% -> 0.5, 5% -> 1
  const base = yieldFactor * (1 - risk) * (1 - j.stress);
  return j.action.choice === "reduce" ? base * 0.5 : base;
}

export function plan(
  cfg: CuratorConfig,
  judgments: Judgment[],
  apys: Record<string, number | null>,
): Plan {
  const escalations: string[] = [];
  const weights: Record<string, number> = {};
  for (const j of judgments) {
    const w = weightOf(j, apys[j.label] ?? null, cfg.thresholds);
    weights[j.label] = w;
    if (j.action.choice === "exit") escalations.push(`${j.label}: model chose exit (p=${j.action.probabilities.exit?.toFixed(2)})`);
    if (j.stress >= cfg.thresholds.stressExit) escalations.push(`${j.label}: stress ${j.stress.toFixed(2)} above ${cfg.thresholds.stressExit}`);
    if (j.risk.confidence < cfg.thresholds.minConfidence) escalations.push(`${j.label}: risk confidence ${j.risk.confidence.toFixed(2)} below ${cfg.thresholds.minConfidence}`);
    if (j.action.confidence < cfg.thresholds.minConfidence) escalations.push(`${j.label}: action confidence ${j.action.confidence.toFixed(2)} below ${cfg.thresholds.minConfidence}`);
  }
  const total = Object.values(cfg.currentAllocation).reduce((a, b) => a + b, 0);
  const sumW = cfg.strategies.filter((s) => s.allocate).reduce((a, s) => a + (weights[s.label] ?? 0), 0);

  // Targets proportional to weight, then clipped by caps; anything clipped is
  // left where it is rather than forced into a worse strategy.
  const allocatable = new Set(cfg.strategies.filter((s) => s.allocate).map((s) => s.label));
  const proposals: Proposal[] = judgments.filter((j) => allocatable.has(j.label)).map((j) => {
    const cap = cfg.strategies.find((s) => s.label === j.label)?.cap ?? 0;
    const current = cfg.currentAllocation[j.label] ?? 0;
    const raw = sumW === 0 ? current : (total * (weights[j.label] ?? 0)) / sumW;
    const target = Math.min(cap, Math.round(raw));
    const esc = escalations.filter((e) => e.startsWith(j.label + ":"));
    return { label: j.label, current, target, delta: target - current, weight: weights[j.label] ?? 0, escalate: esc };
  });

  // Dead band: small differences between low-precision judgments are noise,
  // and every move costs gas and leaks intent. Below the band, stay put.
  const band = total * cfg.thresholds.minMoveFraction;
  for (const p of proposals) {
    if (Math.abs(p.delta) < band) {
      p.target = p.current;
      p.delta = 0;
    }
  }

  // Turn deltas into moves from over-allocated to under-allocated, within the window limit.
  let budget = cfg.rebalanceLimit;
  const moves: Plan["moves"] = [];
  const sources = proposals.filter((p) => p.delta < 0).map((p) => ({ label: p.label, left: -p.delta }));
  const sinks = proposals.filter((p) => p.delta > 0).map((p) => ({ label: p.label, left: p.delta }));
  for (const src of sources) {
    for (const dst of sinks) {
      if (budget <= 0) break;
      const amount = Math.min(src.left, dst.left, budget);
      if (amount <= 0) continue;
      moves.push({ from: src.label, to: dst.label, assets: amount });
      src.left -= amount; dst.left -= amount; budget -= amount;
    }
  }
  const ranking: Ranked[] = judgments
    .map((j) => ({ label: j.label, weight: weights[j.label] ?? 0, stress: j.stress, risk: j.risk.score, action: j.action.choice }))
    .sort((a, b) => b.weight - a.weight || a.stress - b.stress);
  return { ranking, proposals, moves, escalations, needsApproval: escalations.length > 0 };
}
