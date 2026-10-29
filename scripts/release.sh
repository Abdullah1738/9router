#!/bin/zsh
# Build and publish a release to the zero-downtime supervisor.
#   release.sh                       build (NEXT_DIST_DIR=.next-new), copy to .releases/<id>, stop: not switched
#   release.sh --approved            the same, then switch current to <id>, reload, canary, watch
#   release.sh --no-build --approved publish the existing .next-new/standalone and switch to it
#   release.sh --rollback            point current back at the previous release and reload (no approval needed)
#   release.sh --dry-run ...         print every command that would change something; run nothing that changes
#   release.sh --help
# Home: scripts/release.sh in the 9router repo (tmp/scripts/release.sh is retired).
# A switch needs --approved. After the reload the script waits for the supervisor to report
# "serving" (or "reload failed"), sends a real model call (scripts/release-canary.mjs), then
# watches the router log for 5 min (WATCH_MINUTES) for a burst of the same upstream error
# (scripts/release-watch.mjs). A failed canary or burst rolls back by itself and sends a Telegram alert.
# The supervisor (com.abdullah.9router-fork) reloads on SIGHUP: new worker first,
# old worker drains its in-flight streams, so running sessions are not cut.
set -euo pipefail
SELF=$0

usage() {
  sed -n '2,11p' "$SELF" | sed 's/^# \{0,1\}//'
}

approved=0 dry=0 nobuild=0 mode=switch
for a in "$@"; do
  case $a in
    --approved) approved=1 ;;
    --dry-run) dry=1 ;;
    --no-build) nobuild=1 ;;
    --rollback) mode=rollback ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $a"; usage; exit 2 ;;
  esac
done

ROOT=~/tmp/9router
REL=$ROOT/.releases
LABEL=com.abdullah.9router-fork
LOG=~/.9router/logs/fork-server.log
BUN=/Users/ardud/.bun/bin/bun
TG=/Users/ardud/.local/share/telegram-bridge/src/cli.ts

# act: run a state-changing command, or print it under --dry-run.
act() {
  if (( dry )); then echo "DRY: $*"; else "$@"; fi
}

hup() {
  act launchctl kill SIGHUP gui/$(id -u)/$LABEL
  (( dry )) || echo "SIGHUP sent; watch: tail -f $LOG | grep 9r-"
}

log_size() { stat -f %z "$LOG" 2>/dev/null || echo 0; }

# wait_serving <release-dir> <log-offset>: 0 once the supervisor logs serving for that release.
# 1 on "reload failed" or after 150 s with no answer.
wait_serving() {
  local rel=$1 off=$2 chunk deadline=$(( SECONDS + 150 ))
  if (( dry )); then echo "DRY: wait up to 150 s in $LOG from byte $off for 'serving; release $rel'"; return 0; fi
  while (( SECONDS < deadline )); do
    chunk=$(tail -c +$((off + 1)) "$LOG" 2>/dev/null || true)
    if grep -qF "serving; release $rel" <<< "$chunk"; then echo "supervisor: serving $rel"; return 0; fi
    if grep -qF "reload failed" <<< "$chunk"; then
      echo "supervisor: $(grep -F 'reload failed' <<< "$chunk" | tail -1)"
      return 1
    fi
    sleep 3
  done
  echo "supervisor: no answer after 150 s"
  return 1
}

# Alert must never block the rollback: failures are printed and ignored.
notify() {
  local text="9router $id rolled back: $1"
  if (( dry )); then
    echo "DRY: (unset BUN_INSPECT; $BUN $TG notify --source \"9router release\" --severity attention --text \"$text\" --key \"9router-release:$id\")"
    return 0
  fi
  (unset BUN_INSPECT; "$BUN" "$TG" notify --source "9router release" --severity attention \
    --text "$text" --key "9router-release:$id") || echo "alert failed; rollback stands"
}

if (( dry )); then echo "DRY-RUN: nothing will be changed"; fi

source ~/.nvm/nvm.sh >/dev/null; nvm use 26.2.0 >/dev/null
cd $ROOT
act mkdir -p $REL

if [[ $mode == rollback ]]; then
  prev=$(readlink $REL/previous 2>/dev/null) || { echo "no previous release"; exit 1; }
  cur=$(readlink $REL/current)
  off=$(log_size)
  act ln -sfn $prev $REL/current
  act ln -sfn $cur $REL/previous
  echo "current -> $prev"
  hup
  wait_serving "$REL/$prev" "$off" || echo "rollback reload did not confirm serving; check $LOG"
  exit 0
fi

if (( nobuild == 0 )); then
  if (( dry )); then
    echo "DRY: skipped build: rm -rf .next-new; NEXT_DIST_DIR=.next-new npm run build"
  else
    rm -rf .next-new
    NEXT_DIST_DIR=.next-new npm run build
  fi
fi
if (( dry )); then
  [[ -f .next-new/standalone/custom-server.js ]] || echo "DRY: would stop: no standalone build"
else
  [[ -f .next-new/standalone/custom-server.js ]] || { echo "no standalone build"; exit 1; }
fi

id=$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!tmp' || echo -dirty)
act cp -c -R .next-new/standalone $REL/$id

if (( approved == 0 )); then
  echo "Built $id. Not switched: ask Abdullah, then run scripts/release.sh --no-build --approved"
  exit 0
fi

prev_cur=$(readlink $REL/current 2>/dev/null || true)
prev_prev=$(readlink $REL/previous 2>/dev/null || true)
off=$(log_size)

if [[ -L $REL/current ]]; then act ln -sfn $prev_cur $REL/previous; fi
act ln -sfn $id $REL/current
echo "current -> $id"
hup

# Reloading failed or never answered: point back at the old release. The old worker kept serving.
restore_pointers() {
  if [[ -n $prev_cur ]]; then act ln -sfn $prev_cur $REL/current; fi
  if [[ -n $prev_prev ]]; then act ln -sfn $prev_prev $REL/previous; else act rm -f $REL/previous; fi
}

if ! wait_serving "$REL/$id" "$off"; then
  restore_pointers
  echo "Switch to $id failed; kept the previous release."
  exit 1
fi

# Rollback: swap back to the previous release and reload. Alert, then exit 1.
roll_back() {
  local reason=$1
  echo "Rolling back $id: $reason"
  if [[ -z $prev_cur ]]; then
    echo "No previous release to roll back to; current left at $id."
  else
    local roff=$(log_size)
    act ln -sfn $prev_cur $REL/current
    act ln -sfn $id $REL/previous
    echo "current -> $prev_cur"
    hup
    wait_serving "$REL/$prev_cur" "$roff" || echo "rollback reload did not confirm serving; check $LOG"
  fi
  notify "$reason"
  exit 1
}

if (( dry )); then
  echo "DRY: skipped canary: node scripts/release-canary.mjs"
  echo "DRY: skipped watch: node scripts/release-watch.mjs --log $LOG --offset $off --minutes ${WATCH_MINUTES:-5}"
else
  node scripts/release-canary.mjs || roll_back "canary failed (real model call)"

  watch_rc=0
  watch_out=$(node scripts/release-watch.mjs --log "$LOG" --offset "$off" --minutes "${WATCH_MINUTES:-5}" 2>&1) || watch_rc=$?
  echo "$watch_out"
  if (( watch_rc == 3 )); then roll_back "error burst: $watch_out"; fi
  if (( watch_rc != 0 )); then roll_back "watch exited $watch_rc"; fi
fi

# Keep the five newest releases plus the live pair.
keep=($id $prev_cur $prev_prev)
for d in $(ls -1t $REL | grep -v -e '^current$' -e '^previous$' | tail -n +6); do
  (( ${keep[(Ie)$d]} )) || act rm -rf $REL/$d
done

if (( dry )); then
  echo "DRY-RUN complete for $id: nothing changed."
else
  echo "Release $id is live; watched ${WATCH_MINUTES:-5} min, no error burst."
fi
