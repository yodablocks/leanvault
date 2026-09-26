import { config } from "./config";
import { makeRpc } from "./rpc";
import { observe, signals } from "./observe";
import { buildState, judge, makeTypeSafeClient } from "./judge";
import { plan } from "./allocate";
import { append, history } from "./store";

const cmd = process.argv[2] ?? "shadow";

async function takeSnapshots() {
  const rpc = makeRpc(config.rpcUrl);
  const snaps = [];
  for (const s of config.strategies) {
    const snap = await observe(rpc, s);
    if (snap.assetSymbol !== config.assetSymbol) {
      throw new Error(`${s.label} at ${s.address} is over ${snap.assetSymbol}, expected ${config.assetSymbol}`);
    }
    await append("snapshots.jsonl", snap);
    snaps.push(snap);
  }
  return snaps;
}

function money(n: number) { return n.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
function pct(x: number | null) { return x === null ? "n/a" : (x * 100).toFixed(3) + "%"; }

if (cmd === "observe") {
  const snaps = await takeSnapshots();
  for (const s of snaps) {
    const sig = signals(await history(s.label));
    console.log(`${s.label.padEnd(22)} ${s.name.padEnd(28)} tvl ${money(s.totalAssets).padStart(14)} ${s.assetSymbol}  pps ${s.pricePerShare.toFixed(6)}  liq ${pct(s.liquidityRatio)}  apy ${pct(sig.realizedApy)}  window ${sig.observedDays.toFixed(2)}d`);
  }
} else if (cmd === "judge" || cmd === "shadow") {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set; `observe` works without it");
  const client = makeTypeSafeClient(key);
  const snaps = await takeSnapshots();
  const judgments = [];
  const apys: Record<string, number | null> = {};
  for (const s of snaps) {
    const sig = signals(await history(s.label));
    apys[s.label] = sig.realizedApy;
    const state = buildState(s, sig);
    const j = await judge(client, state);
    await append("judgments.jsonl", { at: s.timestamp, state, judgment: j });
    judgments.push(j);
    console.log(`${j.label.padEnd(22)} stress ${j.stress.toFixed(2)}  risk ${j.risk.score.toFixed(2)}/3 (conf ${j.risk.confidence.toFixed(2)})  action ${j.action.choice} (conf ${j.action.confidence.toFixed(2)})  ${j.model}`);
  }
  if (cmd === "shadow") {
    const p = plan(config, judgments, apys);
    await append("proposals.jsonl", { at: Date.now(), plan: p });
    console.log("\nproposed allocation:");
    for (const q of p.proposals) console.log(`  ${q.label.padEnd(22)} ${money(q.current).padStart(10)} -> ${money(q.target).padStart(10)}  (w ${q.weight.toFixed(3)})`);
    console.log(p.moves.length ? "moves this window:" : "moves this window: none");
    for (const m of p.moves) console.log(`  ${m.from} -> ${m.to}: ${money(m.assets)}`);
    if (p.escalations.length) { console.log("escalate to a person:"); for (const e of p.escalations) console.log("  " + e); }
  }
} else {
  console.error("usage: bun run src/cli.ts observe|judge|shadow");
  process.exit(2);
}
