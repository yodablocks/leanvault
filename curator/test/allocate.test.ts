import { describe, expect, test } from "bun:test";
import { plan, stableCall, weightOf } from "../src/allocate";
import type { Judgment } from "../src/judge";
import type { CuratorConfig } from "../src/config";

const cfg: CuratorConfig = {
  rpc: { ethereum: "", base: "" }, concurrency: 1, assetSymbol: "USDC",
  strategies: [{ label: "a", chain: "ethereum", address: "0x1", cap: 800, allocate: true }, { label: "b", chain: "ethereum", address: "0x2", cap: 800, allocate: true }],
  currentAllocation: { a: 500, b: 500 },
  rebalanceLimit: 150,
  thresholds: { stressExit: 0.7, minConfidence: 0.6, minMoveFraction: 0.05, callWindow: 3, callMargin: 0.05 },
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
    const tight: CuratorConfig = { ...cfg, strategies: [{ label: "a", chain: "ethereum", address: "0x1", cap: 300, allocate: true }, { label: "b", chain: "ethereum", address: "0x2", cap: 300, allocate: true }] };
    const p = plan(tight, [j("a"), j("b")], { a: 0.05, b: 0.05 });
    expect(p.proposals.map((x) => x.target)).toEqual([300, 300]);
  });

  test("watch-only strategies are ranked but never allocated", () => {
    const watch: CuratorConfig = { ...cfg, strategies: [...cfg.strategies, { label: "c", chain: "base", address: "0x3", cap: 0 }] };
    const p = plan(watch, [j("a"), j("b"), j("c", { risk: 0 })], { a: 0.05, b: 0.05, c: 0.09 });
    expect(p.ranking[0]!.label).toBe("c");
    expect(p.proposals.map((x) => x.label)).toEqual(["a", "b"]);
    expect(p.moves).toEqual([]);
  });
});

// An action judgment with the given probabilities; the choice is the most likely.
function act(hold: number, reduce: number, exit = 0): Judgment["action"] {
  const probabilities = { hold, reduce, exit };
  const choice = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]) as "hold" | "reduce" | "exit";
  return { choice, probabilities, confidence: 0.5 };
}

describe("stableCall", () => {
  test("no history means hold", () => expect(stableCall([], 3, 0.05)).toBe("hold"));
  test("one noisy flip between close choices does not change the call", () => {
    expect(stableCall([act(0.6, 0.4), act(0.6, 0.4), act(0.45, 0.55)], 3, 0.05)).toBe("hold");
  });
  test("a shift that persists is followed", () => {
    expect(stableCall([act(0.6, 0.4), act(0.4, 0.6), act(0.4, 0.6)], 3, 0.05)).toBe("reduce");
  });
  test("a lead below the margin keeps the current call", () => {
    // call reduce; averaged over three passes hold leads 0.517 to 0.483, under the margin
    expect(stableCall([act(0.4, 0.6), act(0.55, 0.45), act(0.6, 0.4)], 3, 0.05)).toBe("reduce");
    // call hold; averaged over three passes reduce leads 0.51 to 0.49, under the margin
    expect(stableCall([act(0.6, 0.4), act(0.45, 0.55), act(0.42, 0.58)], 3, 0.05)).toBe("hold");
  });
  test("an exit on the current pass stands at once, whatever came before", () => {
    expect(stableCall([act(0.9, 0.1), act(0.9, 0.1), act(0.1, 0.1, 0.8)], 3, 0.05)).toBe("exit");
  });
  test("the first pass sets the call", () => expect(stableCall([act(0.3, 0.7)], 3, 0.05)).toBe("reduce"));
});

describe("plan with stabilized calls", () => {
  test("the policy weighs the call, not the noisy choice, and the ranking shows both", () => {
    const noisy = j("a", { action: "reduce" });
    const p = plan(cfg, [noisy, j("b")], { a: 0.05, b: 0.05 }, { a: "hold" });
    const a = p.ranking.find((r) => r.label === "a")!;
    expect(a.action).toBe("hold");
    expect(a.modelAction).toBe("reduce");
    expect(a.weight).toBe(weightOf(noisy, 0.05, cfg.thresholds, "hold"));
    expect(p.moves).toEqual([]);
    expect(p.ranking.find((r) => r.label === "b")!.modelAction).toBeUndefined();
  });
});

