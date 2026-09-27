import { describe, expect, test } from "bun:test";
import { checkHealth, passes, type HealthLog } from "../src/health";

const H = 3600;
const T0 = 1_790_433_395; // a real pass start, seconds
const labels = ["eth-a", "eth-b", "base-c"];
const pooled = ["eth-a", "base-c"];

// One pass shaped like the real log: snapshot and judgment times are block
// timestamps in seconds, base about ten seconds after ethereum; the proposal
// time is Date.now() in milliseconds, a few seconds after the last judgment.
function pass(start: number, observedDays: number, o: { drop?: string[]; noJudge?: boolean; noPlan?: boolean; noLlama?: boolean; delisted?: string[]; noLiquidity?: boolean } = {}): HealthLog {
  const log: HealthLog = { snapshots: [], judgments: [], proposals: [] };
  for (const label of labels) {
    const ts = label.startsWith("base") ? start + 10 : start;
    log.snapshots.push({ label, timestamp: ts });
    if (o.noJudge || o.drop?.includes(label)) continue;
    const aggregator = o.noLlama ? undefined : { listed: pooled.includes(label) && !o.delisted?.includes(label) };
    const liquidity_ratio_now = o.noLiquidity ? null : 0.7;
    log.judgments.push({ at: ts, state: { label, observed_days: observedDays, liquidity_ratio_now, ...(aggregator ? { aggregator } : {}) } });
  }
  if (!o.noPlan && !o.noJudge) log.proposals.push({ at: (start + 40) * 1000 });
  return log;
}

function join(...logs: HealthLog[]): HealthLog {
  return {
    snapshots: logs.flatMap((l) => l.snapshots),
    judgments: logs.flatMap((l) => l.judgments),
    proposals: logs.flatMap((l) => l.proposals),
  };
}

const opts = { labels, pooled, maxGapHours: 18, warnGapHours: 9 };

describe("passes", () => {
  test("clusters records minutes apart into one pass and hours apart into two", () => {
    const p = passes(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35)).snapshots);
    expect(p.length).toBe(2);
    expect(p[0]!.labels).toEqual(new Set(labels));
    expect(p[1]!.start).toBe(T0 + 6 * H);
  });
});

describe("checkHealth after a pass", () => {
  test("a complete pass six hours after the last one is healthy", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35)), { ...opts, now: T0 + 6 * H + 60, mode: "pass" });
    expect(h.problems).toEqual([]);
    expect(h.ok).toBe(true);
  });

  test("a vault without a judgment is named", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { drop: ["eth-b"] })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.ok).toBe(false);
    expect(h.problems.join("\n")).toContain("eth-b");
  });

  test("a vault missing from the snapshots is named", () => {
    const log = join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35));
    log.snapshots = log.snapshots.filter((s) => !(s.label === "base-c" && s.timestamp > T0 + H));
    const h = checkHealth(log, { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.some((p) => p.includes("snapshot") && p.includes("base-c"))).toBe(true);
  });

  test("a snapshots-only pass, the missing-key fallback, is a problem", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { noJudge: true })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.ok).toBe(false);
    expect(h.problems.join("\n")).toMatch(/no judgments/);
  });

  test("a pass without a plan is a problem", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { noPlan: true })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.join("\n")).toMatch(/no plan/);
  });

  test("DefiLlama missing from the whole pass is a problem", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { noLlama: true })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.join("\n")).toMatch(/DefiLlama/);
  });

  test("a pinned pool that DefiLlama no longer lists is named", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { delisted: ["base-c"] })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.some((p) => p.includes("base-c") && p.includes("pool"))).toBe(true);
  });

  test("liquidity unmeasured for every vault means the probe is broken, not the vaults", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35, { noLiquidity: true })), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.join("\n")).toMatch(/liquidity/);
  });

  test("a vault whose observed window did not grow means the history was not restored", () => {
    const h = checkHealth(join(pass(T0, 0.35), pass(T0 + 6 * H, 0)), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems.join("\n")).toMatch(/history/);
  });

  test("a vault new in this pass may start from zero", () => {
    const first = pass(T0, 0.1);
    first.snapshots = first.snapshots.filter((s) => s.label !== "base-c");
    first.judgments = first.judgments.filter((j) => j.state.label !== "base-c");
    const second = pass(T0 + 6 * H, 0.35);
    second.judgments.find((j) => j.state.label === "base-c")!.state.observed_days = 0;
    const h = checkHealth(join(first, second), { ...opts, now: T0 + 6 * H, mode: "pass" });
    expect(h.problems).toEqual([]);
  });

  test("a manual run minutes after a scheduled one merges into the same pass without false alarms", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 6 * H, 0.35), pass(T0 + 6 * H + 300, 0.36)), { ...opts, now: T0 + 6 * H + 400, mode: "pass" });
    expect(h.problems).toEqual([]);
  });

  test("a gap between the last two passes over the limit is a problem, over the warning line a warning", () => {
    const late = checkHealth(join(pass(T0, 0.1), pass(T0 + 11 * H, 0.55)), { ...opts, now: T0 + 11 * H, mode: "pass" });
    expect(late.ok).toBe(true);
    expect(late.warnings.join("\n")).toMatch(/11\.0h/);
    const broken = checkHealth(join(pass(T0, 0.1), pass(T0 + 20 * H, 0.9)), { ...opts, now: T0 + 20 * H, mode: "pass" });
    expect(broken.ok).toBe(false);
    expect(broken.problems.join("\n")).toMatch(/20\.0h/);
  });

  test("an old gap earlier in the log is reported but does not fail the current pass", () => {
    const h = checkHealth(join(pass(T0, 0.1), pass(T0 + 30 * H, 1.3), pass(T0 + 36 * H, 1.5)), { ...opts, now: T0 + 36 * H, mode: "pass" });
    expect(h.ok).toBe(true);
    expect(h.info.join("\n")).toMatch(/longest gap 30\.0h/);
  });

  test("an empty log is a problem", () => {
    expect(checkHealth({ snapshots: [], judgments: [], proposals: [] }, { ...opts, now: T0, mode: "pass" }).ok).toBe(false);
  });
});

describe("checkHealth as a watchdog", () => {
  test("only the age of the newest pass counts, so a config change cannot fail it", () => {
    const log = pass(T0, 0.1, { drop: ["eth-b"], noLlama: true });
    expect(checkHealth(log, { ...opts, labels: [...labels, "added-later"], now: T0 + 10 * H, mode: "age" }).ok).toBe(true);
  });

  test("a newest pass older than the limit fails it", () => {
    const h = checkHealth(pass(T0, 0.1), { ...opts, now: T0 + 19 * H, mode: "age" });
    expect(h.ok).toBe(false);
    expect(h.problems.join("\n")).toMatch(/19\.0h/);
  });
});
