import { describe, expect, test } from "bun:test";
import { plan, weightOf } from "../src/allocate";
import type { Judgment } from "../src/judge";
import type { CuratorConfig } from "../src/config";

const cfg: CuratorConfig = {
  rpcUrl: "", assetSymbol: "USDC",
  strategies: [{ label: "a", address: "0x1", cap: 800 }, { label: "b", address: "0x2", cap: 800 }],
  currentAllocation: { a: 500, b: 500 },
  rebalanceLimit: 150,
  thresholds: { stressExit: 0.7, minConfidence: 0.6, minMoveFraction: 0.05 },
};

function j(label: string, o: Partial<{ stress: number; risk: number; action: "hold" | "reduce" | "exit"; conf: number }> = {}): Judgment {
  const action = o.action ?? "hold";
  return {
    label, stress: o.stress ?? 0.05, model: "jev-test", usage: { input_tokens: 0, output_tokens: 0 },
    risk: { score: o.risk ?? 0.2, probabilities: {}, confidence: o.conf ?? 0.9 },
    action: { choice: action, probabilities: { [action]: 0.9 }, confidence: o.conf ?? 0.9 },
  };
}

describe("weightOf", () => {
  test("exit or high stress zeroes the weight", () => {
    expect(weightOf(j("a", { action: "exit" }), 0.05, cfg.thresholds)).toBe(0);
    expect(weightOf(j("a", { stress: 0.9 }), 0.05, cfg.thresholds)).toBe(0);
  });
  test("healthier and higher yield weighs more; reduce halves it", () => {
    const healthy = weightOf(j("a", { risk: 0 }), 0.05, cfg.thresholds);
    const shaky = weightOf(j("a", { risk: 2 }), 0.05, cfg.thresholds);
    const lowYield = weightOf(j("a", { risk: 0 }), 0.0, cfg.thresholds);
    const reduce = weightOf(j("a", { risk: 0, action: "reduce" }), 0.05, cfg.thresholds);
    expect(healthy).toBeGreaterThan(shaky);
    expect(healthy).toBeGreaterThan(lowYield);
    expect(reduce).toBeCloseTo(healthy / 2, 9);
  });
});

describe("plan", () => {
  test("equal judgments keep the allocation and propose no moves", () => {
    const p = plan(cfg, [j("a"), j("b")], { a: 0.05, b: 0.05 });
    expect(p.moves).toEqual([]);
    expect(p.escalations).toEqual([]);
    expect(p.proposals.map((x) => x.target)).toEqual([500, 500]);
  });
  test("an exit signal moves everything out, bounded by the window limit, and escalates", () => {
    const p = plan(cfg, [j("a", { action: "exit", stress: 0.95 }), j("b")], { a: 0.05, b: 0.05 });
    expect(p.proposals[0]!.target).toBe(0);
    expect(p.proposals[1]!.target).toBe(800); // capped, not 1000
    expect(p.moves).toEqual([{ from: "a", to: "b", assets: 150 }]);
    expect(p.escalations.length).toBeGreaterThan(0);
    expect(p.escalations.join()).toContain("a: model chose exit");
  });
  test("low confidence escalates and marks any moves as needing approval", () => {
    const p = plan(cfg, [j("a", { conf: 0.3 }), j("b")], { a: 0.05, b: 0.05 });
    expect(p.escalations.some((e) => e.includes("confidence"))).toBe(true);
    expect(p.needsApproval).toBe(true);
    expect(p.moves).toEqual([]);
  });
  test("differences inside the dead band produce no move", () => {
    // risk 0.2 vs 0.35 on a 3-level scale is a few percent of weight: noise
    const p = plan(cfg, [j("a", { risk: 0.2 }), j("b", { risk: 0.35 })], { a: 0.05, b: 0.05 });
    expect(p.moves).toEqual([]);
    expect(p.proposals.map((x) => x.target)).toEqual([500, 500]);
    expect(p.needsApproval).toBe(false);
  });
  test("a clear difference still moves, outside the dead band", () => {
    const p = plan(cfg, [j("a", { risk: 0 }), j("b", { risk: 2.4 })], { a: 0.05, b: 0.05 });
    expect(p.moves.length).toBe(1);
    expect(p.moves[0]!.from).toBe("b");
  });
  test("caps clip targets instead of forcing funds into the other strategy", () => {
    const tight: CuratorConfig = { ...cfg, strategies: [{ label: "a", address: "0x1", cap: 300 }, { label: "b", address: "0x2", cap: 300 }] };
    const p = plan(tight, [j("a"), j("b")], { a: 0.05, b: 0.05 });
    expect(p.proposals.map((x) => x.target)).toEqual([300, 300]);
  });
});
