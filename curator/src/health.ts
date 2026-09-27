// Is the shadow log still being written, and is each pass whole? Runs after
// every pass (mode "pass") and once a day on its own (mode "age"). Only the
// current state fails the check; old gaps are reported, not failed, so one bad
// night does not turn every run red for a week.
//
// Units follow the log: snapshot and judgment times are block timestamps in
// seconds, proposal times are Date.now() in milliseconds.

export interface HealthLog {
  snapshots: { label: string; timestamp: number }[];
  judgments: { at: number; state: { label: string; observed_days: number; liquidity_ratio_now?: number | null; aggregator?: { listed: boolean } } }[];
  proposals: { at: number }[];
}

export interface Pass {
  start: number;
  end: number;
  labels: Set<string>;
}

export interface HealthOptions {
  /** Every label in the config; each must be snapshotted and judged in the newest pass. */
  labels: string[];
  /** Labels pinned to a DefiLlama pool; each must come back listed. */
  pooled: string[];
  /** A gap above this fails the check. Two slots missed on a six-hour schedule. */
  maxGapHours: number;
  /** A gap above this prints a warning. */
  warnGapHours: number;
  /** Seconds. */
  now: number;
  /** "pass": the pass just written, in full. "age": only how old the newest pass is. */
  mode: "pass" | "age";
}

export interface Health {
  ok: boolean;
  problems: string[];
  warnings: string[];
  info: string[];
}

/** Records more than this far apart belong to different passes. */
const PASS_GAP_S = 15 * 60;
/** The plan is written after every vault is judged, one Jev call at a time. */
const PLAN_WINDOW_S = 15 * 60;
const WINDOW_DAYS = 7;
const EXPECTED_PER_DAY = 4;

const hours = (s: number) => (s / 3600).toFixed(1) + "h";

export function passes(snapshots: HealthLog["snapshots"]): Pass[] {
  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const out: Pass[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.timestamp - last.end <= PASS_GAP_S) {
      last.end = s.timestamp;
      last.labels.add(s.label);
    } else {
      out.push({ start: s.timestamp, end: s.timestamp, labels: new Set([s.label]) });
    }
  }
  return out;
}

function judgedIn(log: HealthLog, p: Pass) {
  return log.judgments.filter((j) => j.at >= p.start && j.at <= p.end);
}

/** Longest observed window per label in a pass; a merged manual rerun counts once. */
function observedDays(log: HealthLog, p: Pass): Map<string, number> {
  const m = new Map<string, number>();
  for (const j of judgedIn(log, p)) m.set(j.state.label, Math.max(m.get(j.state.label) ?? -1, j.state.observed_days));
  return m;
}

export function checkHealth(log: HealthLog, o: HealthOptions): Health {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  const all = passes(log.snapshots);
  const newest = all[all.length - 1];
  if (!newest) return { ok: false, problems: ["no passes in the log"], warnings, info };
  const previous = all[all.length - 2];

  const age = o.now - newest.end;
  if (age > o.maxGapHours * 3600) problems.push(`newest pass is ${hours(age)} old, limit ${o.maxGapHours}h`);
  else if (age > o.warnGapHours * 3600) warnings.push(`newest pass is ${hours(age)} old`);

  const recent = all.filter((p) => p.start >= o.now - WINDOW_DAYS * 86_400);
  let longest = 0;
  for (let i = 1; i < recent.length; i++) longest = Math.max(longest, recent[i]!.start - recent[i - 1]!.end);
  const days = Math.max((o.now - (recent[0]?.start ?? o.now)) / 86_400, 1 / EXPECTED_PER_DAY);
  info.push(`${all.length} passes in the log, ${recent.length} in the last ${WINDOW_DAYS} days, ${(recent.length / days).toFixed(1)} a day against ${EXPECTED_PER_DAY} expected, longest gap ${hours(longest)}`);
  info.push(`newest pass ${new Date(newest.start * 1000).toISOString()}, ${newest.labels.size} vaults`);

  if (o.mode === "age") return { ok: problems.length === 0, problems, warnings, info };

  if (previous) {
    const gap = newest.start - previous.end;
    if (gap > o.maxGapHours * 3600) problems.push(`${hours(gap)} since the previous pass, limit ${o.maxGapHours}h`);
    else if (gap > o.warnGapHours * 3600) warnings.push(`${hours(gap)} since the previous pass`);
  }

  const missingSnap = o.labels.filter((l) => !newest.labels.has(l));
  if (missingSnap.length) problems.push(`no snapshot for ${missingSnap.join(", ")}`);

  const judged = judgedIn(log, newest);
  if (judged.length === 0) {
    problems.push("no judgments in the newest pass: snapshots only, is TYPESAFE_API_KEY set?");
  } else {
    const judgedLabels = new Set(judged.map((j) => j.state.label));
    const missingJudge = o.labels.filter((l) => !judgedLabels.has(l));
    if (missingJudge.length) problems.push(`no judgment for ${missingJudge.join(", ")}`);

    const planned = log.proposals.some((p) => p.at / 1000 >= newest.start && p.at / 1000 <= newest.end + PLAN_WINDOW_S);
    if (!planned) problems.push("no plan written for the newest pass");

    if (judged.every((j) => j.state.liquidity_ratio_now == null)) {
      problems.push("liquidity unmeasured for every vault: the probe failed, or the endpoint lacks eth_createAccessList or state overrides");
    }

    if (judged.every((j) => j.state.aggregator === undefined)) {
      problems.push("no DefiLlama data in the newest pass: the index was unreachable");
    } else {
      const delisted = judged.filter((j) => o.pooled.includes(j.state.label) && j.state.aggregator && !j.state.aggregator.listed);
      const names = [...new Set(delisted.map((j) => j.state.label))];
      if (names.length) problems.push(`pinned DefiLlama pool not found for ${names.join(", ")}`);
    }
  }

  if (previous) {
    const now = observedDays(log, newest);
    const before = observedDays(log, previous);
    const stale = [...now].filter(([l, d]) => before.has(l) && d <= before.get(l)!).map(([l]) => l);
    if (stale.length) problems.push(`observed window did not grow for ${stale.join(", ")}: history was not restored`);
  }

  return { ok: problems.length === 0, problems, warnings, info };
}
