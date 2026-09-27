import { describe, expect, test } from "bun:test";
import { escapeHtml, renderSite, type SiteLog } from "../src/site";

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
