// The public page: one self-contained HTML file from the shadow log. Pure, no
// I/O. Every string from the chain or the model is escaped: a vault's name()
// is whatever its deployer wrote, script tags included.
import { passes, type Health } from "./health";
import { RISK_LEVELS } from "./judge";

export interface SiteLog {
  snapshots: { label: string; timestamp: number }[];
  judgments: {
    at: number;
    state: { label: string; vault_name: string; chain?: string; tvl_assets: number; price_per_share: number; liquidity_ratio_now: number | null };
    judgment: { risk: { score: number }; stress: number; action: { choice: string } };
  }[];
  proposals: { at: number; plan: { ranking?: { label: string }[]; escalations: string[] } }[];
}

export interface SiteOptions {
  labels: string[];
  allocated: string[];
  /** Seconds. */
  now: number;
  health: Health;
}

const PLAN_WINDOW_S = 15 * 60;

/** First scheduled pass with measured liquidity (#17) and the current rubric (#18). Move it when either changes. */
export const CUTOFF = Date.parse("2026-09-27T12:12:00Z") / 1000;

const W = 90, H = 22, PAD = 5;

/**
 * Risk over passes on a fixed 0-3 scale, higher drawn higher, so lines compare
 * across vaults. The line is muted and the latest point is in ink, a 2px line
 * and an 8px dot. The title is the hover layer; the page runs no script.
 */
export function riskLine(points: number[]): string {
  if (points.length === 0) return "";
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (v: number) => H - PAD - (Math.min(3, Math.max(0, v)) / 3) * (H - 2 * PAD);
  const last = points[points.length - 1]!;
  const line = points.length > 1
    ? `<polyline fill="none" stroke="var(--mute)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`
    : "";
  const dot = `<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="currentColor"/>`;
  const title = `<title>risk per pass: ${points.map((v) => v.toFixed(2)).join(", ")}</title>`;
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="risk over ${points.length} passes, latest ${last.toFixed(2)}">${title}${line}${dot}</svg>`;
}
const LEVELS = ["Healthy", "Watch", "Impaired", "Exit now"];

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
const money = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
const level = (score: number) => LEVELS[Math.min(3, Math.max(0, Math.round(score)))]!;
const ago = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);

type Row = SiteLog["judgments"][number];

/** Escalations start with the internal label ("fluid-usdc: ..."); show the vault's name and chain instead. */
function plainEscalation(e: string, latest: Map<string, Row>): string {
  const i = e.indexOf(": ");
  const j = i > 0 ? latest.get(e.slice(0, i)) : undefined;
  return j ? `${j.state.vault_name} (${j.state.chain ?? "ethereum"})${e.slice(i)}` : e;
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>leanvault shadow curator</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}

export function renderSite(log: SiteLog, o: SiteOptions): string {
  const all = passes(log.snapshots);
  const newest = all[all.length - 1];
  const intro = `<h1>leanvault shadow curator</h1>
<p class="frame">An experimental AI curator's opinions of real USDC vaults. Not advice, no funds involved, not affiliated with any vault.</p>`;
  if (!newest) return page(`${intro}<p>No passes yet.</p>`);

  // Latest judgment per vault inside the newest pass.
  const latest = new Map<string, Row>();
  for (const j of log.judgments) {
    if (j.at < newest.start || j.at > newest.end) continue;
    const prev = latest.get(j.state.label);
    if (!prev || j.at >= prev.at) latest.set(j.state.label, j);
  }
  const plan = [...log.proposals].reverse().find((p) => p.at / 1000 >= newest.start && p.at / 1000 <= newest.end + PLAN_WINDOW_S)?.plan;
  const order = plan?.ranking?.map((r) => r.label).filter((l) => latest.has(l))
    ?? [...latest.values()].sort((a, b) => a.judgment.risk.score - b.judgment.risk.score).map((j) => j.state.label);
  const missing = o.labels.filter((l) => !latest.has(l));

  const history = new Map<string, number[]>();
  for (const p of all.filter((p) => p.start >= CUTOFF)) {
    const inPass = new Map<string, Row>();
    for (const j of log.judgments) if (j.at >= p.start && j.at <= p.end) inPass.set(j.state.label, j);
    for (const [l, j] of inPass) history.set(l, [...(history.get(l) ?? []), j.judgment.risk.score]);
  }
  const since = new Date(CUTOFF * 1000).toISOString().slice(0, 10);

  const status = o.health.ok
    ? `<p class="ok">Newest pass complete.</p>`
    : `<p class="bad">Newest pass incomplete: ${escapeHtml(o.health.problems[0] ?? "unknown problem")}</p>`;
  const when = `<p>Newest pass ${new Date(newest.start * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, ${ago(o.now - newest.end)}.</p>`;

  const rows = order.map((label, i) => {
    const j = latest.get(label)!;
    const s = j.state;
    const alloc = o.allocated.includes(label) ? ` <span class="tag">simulated allocation</span>` : "";
    return `<tr class="vault"><td>${i + 1}</td><th scope="row">${escapeHtml(s.vault_name)}${alloc}</th><td>${escapeHtml(s.chain ?? "ethereum")}</td>
<td class="n">${money(s.tvl_assets)}</td><td class="n">${s.price_per_share.toFixed(4)}</td><td class="n">${pct(s.liquidity_ratio_now)}</td>
<td class="n">${j.judgment.risk.score.toFixed(2)} <span class="lvl l${Math.round(j.judgment.risk.score)}">${level(j.judgment.risk.score)}</span></td>
<td class="n">${pct(j.judgment.stress)}</td><td>${escapeHtml(j.judgment.action.choice)}</td><td>${riskLine(history.get(label) ?? [])}</td></tr>`;
  });
  const gone = missing.map((l) => `<tr><td></td><th scope="row">${escapeHtml(l)}</th><td colspan="8">not judged this pass</td></tr>`);

  const table = `<table><thead><tr><th>#</th><th>Vault</th><th>Chain</th><th>TVL</th><th>Share price</th><th>Liquidity</th><th>Risk (0-3)</th><th>Stress</th><th>Action</th><th>Risk since ${since}</th></tr></thead>
<tbody>${rows.join("")}${gone.join("")}</tbody></table>`;

  const esc = plan
    ? plan.escalations.length
      ? `<ul>${plan.escalations.map((e) => `<li>${escapeHtml(plainEscalation(e, latest))}</li>`).join("")}</ul>`
      : `<p>Nothing this pass.</p>`
    : `<p>No plan was written for this pass.</p>`;

  const read = `<h2>How to read this</h2><dl>
<dt>Liquidity</dt><dd>How much of the vault a holder of every share could withdraw right now, found by simulating the withdrawal.</dd>
<dt>Risk</dt><dd>The model's score on four described levels:</dd>${RISK_LEVELS.map((l) => `<dd>${escapeHtml(l)}</dd>`).join("")}
<dt>Stress</dt><dd>The model's probability that a prudent allocator would react within a day.</dd>
<dt>Risk since ${since}</dt><dd>The risk score at each pass from the first pass with measured liquidity and the current rubric. Earlier passes used different inputs and are not comparable, so they are not drawn.</dd>
<dt>Would escalate to a person</dt><dd>The policy's reasons to hand a decision to a human instead of acting: the model is not confident enough (confidence below 0.6), it chose exit, or its stress probability is above 0.7.</dd>
<dt>Action</dt><dd>What the model would do with a position: hold, reduce or exit. Nothing is ever executed.</dd></dl>
<p>Raw record: the <a href="https://github.com/yodablocks/leanvault/tree/shadow-log">shadow-log branch</a>. Code: <a href="https://github.com/yodablocks/leanvault">yodablocks/leanvault</a>.</p>`;

  return page(`${intro}${status}${when}<h2>Ranking</h2>${table}<h2>Would escalate to a person</h2>${esc}${read}`);
}

const CSS = `:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--mute:#666;--line:#ddd;--ok:#1a7f37;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#111;--mute:#999;--line:#333;--ok:#3fb950;--bad:#f85149}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:1rem}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:.35rem .5rem;border-bottom:1px solid var(--line);text-align:left}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.frame,.tag,dd{color:var(--mute)}.tag{font-size:12px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.lvl{font-size:12px}.l2,.l3{color:var(--bad);font-weight:600}.spark{display:block;color:var(--fg)}
@media (max-width:700px){table{display:block;overflow-x:auto}}`;
