#!/bin/zsh
# Off-GitHub watchdog for the shadow log. The shadow workflow and its GitHub
# watchdog share one scheduler, and GitHub disables every schedule of a public
# repository after 60 days without activity, silently. This runs from a scheduler on
# a machine that is not GitHub and checks two things:
#   1. both scheduled workflows are still enabled (state "active");
#   2. the newest pass on the shadow-log branch is recent (`health --age`).
# On failure: a macOS notification and a line in the log. Exit 1.
#
#   curator/scripts/watch-shadow.sh                          # by hand
#   SHADOW_MAX_GAP_HOURS=0.01 curator/scripts/watch-shadow.sh  # force a failure to test the alert
#
# Schedulers such as launchd and cron run with a bare PATH, so tools are found by absolute path or overridden.
set -u
GH=${GH:-/opt/homebrew/bin/gh}
GIT=${GIT:-/opt/homebrew/bin/git}
BUN=${BUN:-$HOME/.bun/bin/bun}
REPO=yodablocks/leanvault
LOG=${WATCH_LOG:-$HOME/Library/Logs/leanvault-shadow-watch.log}
CURATOR=${0:A:h:h}

stamp() { date -u +%Y-%m-%dT%H:%MZ; }
fail() {
  print -r -- "$(stamp) FAIL $1" >> "$LOG"
  /usr/bin/osascript -e "display notification \"$1\" with title \"leanvault shadow log\" sound name \"Basso\"" 2>/dev/null
  print -r -- "FAIL $1"
  exit 1
}

for wf in shadow.yml shadow-health.yml; do
  state=$("$GH" api "repos/$REPO/actions/workflows/$wf" -q .state 2>&1) || fail "cannot read $wf state from GitHub: $state"
  [[ $state == active ]] || fail "$wf is $state, not active: re-enable it in the Actions tab"
done

"$GIT" -C "$CURATOR" fetch -q origin shadow-log 2>/dev/null || fail "cannot fetch the shadow-log branch"
dir=$(mktemp -d)
for f in snapshots judgments proposals; do
  "$GIT" -C "$CURATOR" show "origin/shadow-log:$f.jsonl" > "$dir/$f.jsonl" 2>/dev/null || fail "shadow-log has no $f.jsonl"
done

out=$(cd "$CURATOR" && CURATOR_DATA_DIR="$dir" "$BUN" run src/cli.ts health --age 2>&1)
code=$?
if (( code != 0 )); then
  fail "$(print -r -- "$out" | grep '^problem:' | head -1 | sed 's/^problem: //')"
fi
print -r -- "$(stamp) ok $(print -r -- "$out" | grep '^newest pass')" >> "$LOG"
print -r -- "$out"
