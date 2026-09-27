import { config } from "./config";
import { makeRpc } from "./rpc";
import { mapLimit, observe, signals } from "./observe";
import { buildState, judge, makeTypeSafeClient } from "./judge";
import { plan } from "./allocate";
import { append, history, readAll } from "./store";
import { aggregatorFor, fetchLlamaPools } from "./llama";
import { checkHealth, type HealthLog } from "./health";
import { renderSite } from "./site";
import { mkdir, writeFile } from "node:fs/promises";

const cmd = process.argv[2] ?? "shadow";

async function takeSnapshots() {
  const rpcs = Object.fromEntries(Object.entries(config.rpc).map(([c, url]) => [c, makeRpc(url)]));
  const started = Date.now();
  const snaps = await mapLimit(config.strategies, config.concurrency, async (s) => {
    const snap = await observe(rpcs[s.chain]!, s);
    if (snap.assetSymbol !== config.assetSymbol) {
      throw new Error(`${s.label} at ${s.address} on ${s.chain} is over ${snap.assetSymbol}, expected ${config.assetSymbol}`);
    }
    return snap;
  });
  for (const snap of snaps) await append("snapshots.jsonl", snap);
  console.error(`observed ${snaps.length} vaults in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return snaps;
}

function money(n: number) { return n.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function pct(x: number | null) { return x === null ? "n/a" : (x * 100).toFixed(3) + "%"; }

if (cmd === "observe") {
  const snaps = await takeSnapshots();
  for (const s of snaps) {
    const sig = signals(await history(s.label));
    console.log(`${s.label.padEnd(28)} ${s.chain.padEnd(9)} ${s.name.padEnd(28)} tvl ${money(s.totalAssets).padStart(14)} ${s.assetSymbol}  pps ${s.pricePerShare.toFixed(9)}  apy ${pct(sig.realizedApy)}  window ${sig.observedDays.toFixed(2)}d`);
  }
} else if (cmd === "judge" || cmd === "shadow") {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set; `observe` works without it");
  const client = makeTypeSafeClient(key);
  const [snaps, pools] = await Promise.all([
    takeSnapshots(),
    fetchLlamaPools().catch((e) => { console.error(`defillama unavailable: ${e}`); return null; }),
  ]);
  const judgments = [];
  const apys: Record<string, number | null> = {};
  for (const s of snaps) {
    const sig = signals(await history(s.label));
    const agg = aggregatorFor(pools, config.strategies.find((c) => c.label === s.label)?.llamaPool);
    // Realized yield needs history; until then the aggregator's 30-day mean stands in.
    apys[s.label] = sig.realizedApy ?? (agg?.apyMean30dPct != null ? agg.apyMean30dPct / 100 : null);
    const state = buildState(s, sig, agg);
    const j = await judge(client, state);
    await append("judgments.jsonl", { at: s.timestamp, state, judgment: j });
    judgments.push(j);
    console.log(`${j.label.padEnd(22)} stress ${j.stress.toFixed(2)}  risk ${j.risk.score.toFixed(2)}/3 (conf ${j.risk.confidence.toFixed(2)})  action ${j.action.choice} (conf ${j.action.confidence.toFixed(2)})  ${j.model}`);
  }
  if (cmd === "shadow") {
    const p = plan(config, judgments, apys);
    await append("proposals.jsonl", { at: Date.now(), plan: p });
    console.log("\nranking, best first:");
    for (const r of p.ranking) console.log(`  ${r.label.padEnd(24)} w ${r.weight.toFixed(3)}  stress ${r.stress.toFixed(2)}  risk ${r.risk.toFixed(2)}  ${r.action}`);
    console.log("\nproposed allocation:");
    for (const q of p.proposals) console.log(`  ${q.label.padEnd(22)} ${money(q.current).padStart(10)} -> ${money(q.target).padStart(10)}  (w ${q.weight.toFixed(3)})`);
    console.log(p.moves.length ? (p.needsApproval ? "moves this window (held for approval):" : "moves this window:") : "moves this window: none");
    for (const m of p.moves) console.log(`  ${m.from} -> ${m.to}: ${money(m.assets)}`);
    if (p.escalations.length) { console.log("escalate to a person:"); for (const e of p.escalations) console.log("  " + e); }
  }
} else if (cmd === "health") {
  // `health` checks the pass just written; `health --age` only asks whether a pass ran recently.
  const log: HealthLog = {
    snapshots: await readAll("snapshots.jsonl"),
    judgments: await readAll("judgments.jsonl"),
    proposals: await readAll("proposals.jsonl"),
  };
  const h = checkHealth(log, {
    labels: config.strategies.map((s) => s.label),
    pooled: config.strategies.filter((s) => s.llamaPool).map((s) => s.label),
    maxGapHours: Number(process.env.SHADOW_MAX_GAP_HOURS ?? 18),
    warnGapHours: Number(process.env.SHADOW_WARN_GAP_HOURS ?? 9),
    now: Math.floor(Date.now() / 1000),
    mode: process.argv.includes("--age") ? "age" : "pass",
  });
  for (const l of h.info) console.log(l);
  for (const l of h.warnings) console.log("warning: " + l);
  for (const l of h.problems) console.log("problem: " + l);
  console.log(h.ok ? "healthy" : "unhealthy");
  if (!h.ok) process.exit(1);
} else if (cmd === "site") {
  // The public page, from the log alone: no chain or model calls.
  const log = {
    snapshots: await readAll<any>("snapshots.jsonl"),
    judgments: await readAll<any>("judgments.jsonl"),
    proposals: await readAll<any>("proposals.jsonl"),
  };
  const now = Math.floor(Date.now() / 1000);
  const labels = config.strategies.map((s) => s.label);
  const health = checkHealth(log, {
    labels,
    pooled: config.strategies.filter((s) => s.llamaPool).map((s) => s.label),
    maxGapHours: 18,
    warnGapHours: 9,
    now,
    mode: "pass",
  });
  const out = (process.argv[3] ?? new URL("../site/", import.meta.url).pathname).replace(/\/?$/, "/");
  await mkdir(out, { recursive: true });
  const allocated = config.strategies.filter((s) => s.allocate).map((s) => s.label);
  await writeFile(out + "index.html", renderSite(log, { labels, allocated, now, health }));
  console.log(`wrote ${out}index.html`);
} else {
  console.error("usage: bun run src/cli.ts observe|judge|shadow|health [--age]|site [outDir]");
  process.exit(2);
}
