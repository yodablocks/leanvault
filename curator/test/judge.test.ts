import { describe, expect, test } from "bun:test";
import { buildState, judge, questions } from "../src/judge";
import { signals, type Snapshot } from "../src/observe";

function snap(o: Partial<Snapshot>): Snapshot {
  return {
    label: "a", address: "0x1", name: "Vault A", assetSymbol: "USDC", assetDecimals: 6,
    block: 1, timestamp: 0, totalAssets: 1_000_000, pricePerShare: 1.01, liquidityRatio: 0.9, fee: 0.1, ...o,
  };
}

describe("signals", () => {
  test("annualizes price-per-share growth and reports the worst step", () => {
    const day = 86_400;
    const h = [snap({ timestamp: 0, pricePerShare: 1.0 }), snap({ timestamp: day, pricePerShare: 1.0002 }), snap({ timestamp: 2 * day, pricePerShare: 1.0001, totalAssets: 900_000 })];
    const s = signals(h);
    expect(s.observedDays).toBeCloseTo(2, 6);
    expect(s.realizedApy).toBeGreaterThan(0);
    expect(s.worstPriceStep).toBeCloseTo(1.0001 / 1.0002 - 1, 9);
    expect(s.tvlChange).toBeCloseTo(-0.1, 9);
  });
  test("no apy under an hour of observation", () => {
    expect(signals([snap({ timestamp: 0 }), snap({ timestamp: 60 })]).realizedApy).toBeNull();
  });
});

describe("judge", () => {
  test("sends named state and three typed questions, parses the documented answer shape", async () => {
    let sent: any;
    const fake = {
      async systemOne(body: unknown) {
        sent = body;
        return {
          model: "jev-1.13.0",
          answers: {
            stress: { type: "noul", noul: 0.12 },
            risk: { type: "score", score: 0.4, legend: {}, probabilities: { 0: 0.6, 1: 0.4 }, confidence: 0.6 },
            action: { type: "choice", choice: "hold", probabilities: { hold: 0.85, reduce: 0.1, exit: 0.05 }, confidence: 0.85 },
          },
          usage: { input_tokens: 300, output_tokens: 30 },
        };
      },
    };
    const state = buildState(snap({}), signals([snap({ timestamp: 0 }), snap({ timestamp: 86_400 })]));
    const j = await judge(fake, state);
    expect(sent.model).toBe("jev-latest");
    expect(Object.keys(sent.questions)).toEqual(["stress", "risk", "action"]);
    expect(sent.questions.risk.criteria.length).toBe(questions.risk.criteria.length);
    expect(sent.state.asset).toBe("USDC");
    expect(j.stress).toBe(0.12);
    expect(j.risk.score).toBe(0.4);
    expect(j.action.choice).toBe("hold");
  });
});
