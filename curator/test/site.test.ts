import { describe, expect, test } from "bun:test";
import { CUTOFF, escapeHtml, renderSite, riskLine, type SiteLog } from "../src/site";

const T = 1_790_600_000;
const ok = { ok: true, problems: [], warnings: [], info: [] };
const opts = { labels: ["a", "b", "c"], allocated: ["a"], now: T + 600, health: ok };

function row(label: string, at: number, o: { name?: string; liq?: number | null; risk?: number; action?: string } = {}) {
  return {
    at,
    state: { label, vault_name: o.name ?? `Vault ${label}`, chain: "ethereum", tvl_assets: 1_000_000, price_per_share: 1.05, liquidity_ratio_now: o.liq === undefined ? 0.5 : o.liq },
    judgment: { risk: { score: o.risk ?? 0.4 }, stress: 0.1, action: { choice: o.action ?? "hold" } },
  };
}
function log(labels: string[], at: number, o: { ranking?: string[]; escalations?: string[]; noPlan?: boolean } = {}): SiteLog {
  return {
    snapshots: labels.map((label) => ({ label, timestamp: at })),
    judgments: labels.map((l) => row(l, at)),
    proposals: o.noPlan ? [] : [{ at: (at + 30) * 1000, plan: { ranking: (o.ranking ?? labels).map((label) => ({ label })), escalations: o.escalations ?? [] } }],
  };
}

describe("escapeHtml", () => {
  test("neutralises markup and quotes", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });
});

describe("renderSite", () => {
  test("rows follow the plan's ranking, with name, liquidity percent and level name", () => {
    const html = renderSite(log(["a", "b", "c"], T, { ranking: ["c", "a", "b"] }), opts);
    const order = ["Vault c", "Vault a", "Vault b"].map((n) => html.indexOf(n));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!))).toBe(true);
    expect(html).toContain("50%");
    expect(html).toContain("Healthy");
  });

  test("a hostile vault name and escalation text come out inert", () => {
    const l = log(["a"], T, { escalations: [`a: <img src=x onerror=alert(1)>`] });
    l.judgments[0]!.state.vault_name = `<script>alert("pwn")</script>`;
    const html = renderSite(l, { ...opts, labels: ["a"] });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("missing liquidity is n/a, not 0%", () => {
    const l = log(["a"], T);
    l.judgments[0]!.state.liquidity_ratio_now = null;
    const html = renderSite(l, { ...opts, labels: ["a"] });
    expect(html).toContain("n/a");
    expect(html).not.toContain(">0%<");
  });

  test("red health shows the first problem in the header", () => {
    const bad = { ok: false, problems: ["no judgment for b"], warnings: [], info: [] };
    expect(renderSite(log(["a"], T), { ...opts, labels: ["a"], health: bad })).toContain("no judgment for b");
  });

  test("an empty log says there is no data yet", () => {
    expect(renderSite({ snapshots: [], judgments: [], proposals: [] }, opts)).toContain("No passes yet");
  });

  test("the page carries the framing, a strict CSP and no scripts", () => {
    const html = renderSite(log(["a"], T), { ...opts, labels: ["a"] });
    expect(html).toMatch(/not advice/i);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
  });

  // Review Focus 1
  test("a snapshots-only pass still lists the vaults, by risk, and says no plan was written", () => {
    const l = log(["a", "b"], T, { noPlan: true });
    l.judgments[0]!.judgment.risk.score = 2.5;
    const html = renderSite(l, { ...opts, labels: ["a", "b"] });
    expect(html).toContain("No plan was written");
    expect(html.indexOf("Vault b")).toBeLessThan(html.indexOf("Vault a"));
  });

  // Review Focus 2
  test("a manual rerun merged into the pass gives one row per vault, from the latest judgment", () => {
    const l = log(["a"], T);
    l.snapshots.push({ label: "a", timestamp: T + 300 });
    l.judgments.push(row("a", T + 300, { name: "Vault a later" }));
    const html = renderSite(l, { ...opts, labels: ["a"] });
    expect(html).toContain("Vault a later");
    expect(html.split("<tr class=\"vault\"").length - 1).toBe(1);
  });

  // Review Focus 3
  test("a configured vault missing from the pass is listed as not judged", () => {
    expect(renderSite(log(["a", "b"], T), opts)).toContain("not judged this pass");
  });
});


describe("riskLine", () => {
  test("no points draws nothing", () => expect(riskLine([])).toBe(""));
  // Review Focus 4
  test("one point is a dot, not NaN", () => {
    const svg = riskLine([1.2]);
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
  });
  // Review Focus 5
  test("a flat series is a flat line, not NaN", () => {
    const svg = riskLine([0.4, 0.4, 0.4]);
    expect(svg).toContain("<polyline");
    expect(svg).not.toContain("NaN");
  });
  test("the scale is fixed 0 to 3, so lines are comparable across vaults", () => {
    expect(riskLine([0, 3])).toBe(riskLine([0, 3]));
    expect(riskLine([0, 3])).not.toBe(riskLine([1, 2]));
  });
});

describe("history in rows", () => {
  test("only passes at or after the cutoff are drawn", () => {
    const before = log(["a"], CUTOFF - 6 * 3600);
    const after = log(["a"], CUTOFF + 3600);
    before.judgments[0]!.judgment.risk.score = 2.9;
    const merged: SiteLog = {
      snapshots: [...before.snapshots, ...after.snapshots],
      judgments: [...before.judgments, ...after.judgments],
      proposals: [...before.proposals, ...after.proposals],
    };
    const html = renderSite(merged, { ...opts, labels: ["a"], now: CUTOFF + 4000 });
    expect(html).toContain("<circle"); // one post-cutoff point only
    expect(html).not.toContain("<polyline");
  });
});

describe("riskLine tooltip", () => {
  test("a title gives the values on hover, since the page runs no script", () => {
    expect(riskLine([0.4, 1.9])).toContain("<title>");
    expect(riskLine([0.4, 1.9])).toContain("1.90");
  });
});

describe("escalations in plain words", () => {
  test("the internal label is replaced by the vault's name and chain", () => {
    const html = renderSite(log(["a"], T, { escalations: ["a: risk confidence 0.40 below 0.6"] }), { ...opts, labels: ["a"] });
    expect(html).toContain("Vault a (ethereum): risk confidence 0.40 below 0.6");
    expect(html).not.toContain("<li>a: ");
  });
  test("how to read this explains what an escalation is", () => {
    expect(renderSite(log(["a"], T), { ...opts, labels: ["a"] })).toMatch(/<dt>Would escalate/);
  });
});

describe("final review fixes", () => {
  test("a judged vault the plan's ranking lacks still gets a row", () => {
    const l = log(["a", "b"], T, { ranking: ["a"] });
    const html = renderSite(l, { ...opts, labels: ["a", "b"] });
    expect(html).toContain("Vault b");
    expect(html.split('<tr class="vault"').length - 1).toBe(2);
  });

  test("a stale newest pass shows its warning, not a bare green", () => {
    const stale = { ok: true, problems: [], warnings: ["newest pass is 10.3h old"], info: [] };
    const html = renderSite(log(["a"], T), { ...opts, labels: ["a"], health: stale });
    expect(html).toContain("newest pass is 10.3h old");
    expect(html).not.toContain("Newest pass complete.");
  });

  test("the ranking order is explained, and the risk fallback says so", () => {
    expect(renderSite(log(["a"], T), { ...opts, labels: ["a"] })).toMatch(/<dt>Ranking<\/dt><dd>[^<]*weight/);
    expect(renderSite(log(["a"], T, { noPlan: true }), { ...opts, labels: ["a"] })).toContain("ordered by risk score");
  });

  test("escalation thresholds come from the config and say 'or more' for stress", () => {
    const html = renderSite(log(["a"], T), { ...opts, labels: ["a"], thresholds: { minConfidence: 0.55, stressExit: 0.75 } });
    expect(html).toContain("below 0.55");
    expect(html).toContain("0.75 or more");
  });

  test("the rubric source is linked", () => {
    expect(renderSite(log(["a"], T), { ...opts, labels: ["a"] })).toContain("curator/src/judge.ts");
  });
});

describe("static page, no clock", () => {
  // The page is built once per pass and runs no script, so a relative age
  // ("1 min ago") is only true at build time and false for hours afterwards.
  test("the newest pass is given as an absolute UTC time, never as an age", () => {
    const html = renderSite(log(["a"], T), { ...opts, labels: ["a"], now: T + 5 * 3600 });
    expect(html).not.toMatch(/ ago\b/);
    expect(html).toMatch(/Newest pass \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });
});
