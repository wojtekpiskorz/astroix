#!/bin/zsh
# Stall sidecar: watches a playwright iteration log and, when the boot goes
# quiet (doc request started, no log growth 20s) or a chrome-module request
# stays open 15s+, captures evidence: process-CPU snapshot, vite-state eval,
# CPU profile — and pause sampling ONLY when SIDECAR_PAUSE=1.
#
# OBSERVER EFFECT (paid for in-lane, see NOTES.md): `Debugger.pause` sampling
# freezes the dev server while it runs; a false-positive trigger plus pause
# sampling manufactured a 2.6m red out of a healthy run. Default captures are
# safe; opt into pause sampling only against a run you can sacrifice.
#
# The triggers grep for `doc-req-start` / `virtual-req-start` trace lines,
# which require temporary request-path tracing patched into the plugin (the
# #171 lane used env-gated stderr traces, since reverted). Adapt the trigger
# patterns to whatever instrumentation your run carries.
#
# Usage: sidecar.sh <log> <tag>   (inspector port via SIDECAR_INSP, default 9373)
LOG=$1
TAG=$2
INSP=${SIDECAR_INSP:-9373}
LAB="$(cd "$(dirname "$0")" && pwd)"
OUT=${OUT_DIR:-/tmp/astroix-stall-lab}
mkdir -p $OUT
capture() {
  date -u +"%Y-%m-%dT%H:%M:%SZ SIDECAR STALL $TAG ($1)" >> $OUT/stalls.log
  ps -Ao pcpu,pid,comm | sort -rn | head -14 > $OUT/sidecar-cpu-$TAG.txt
  node $LAB/probe/inspect-pending.mjs $INSP > $OUT/sidecar-state-$TAG.txt 2>&1
  node $LAB/probe/inspector-probe.mjs $INSP profile 6 > $OUT/sidecar-profile-$TAG.txt 2>&1
  if [ "${SIDECAR_PAUSE:-0}" = "1" ]; then
    node $LAB/probe/inspector-probe.mjs $INSP pause 18 > $OUT/sidecar-pause-$TAG.txt 2>&1
  fi
  sleep 8
  ps -Ao pcpu,pid,comm | sort -rn | head -14 > $OUT/sidecar-cpu2-$TAG.txt
  node $LAB/probe/inspect-pending.mjs $INSP > $OUT/sidecar-state2-$TAG.txt 2>&1
  cp $LOG $OUT/sidecar-log-at-stall-$TAG.log
}
FIRED=0
while true; do
  if [ $FIRED = 0 ]; then
    starts=$(grep -ac "virtual-req-start" $LOG 2>/dev/null); starts=${starts:-0}
    finishes=$(grep -ac "virtual-req-finish" $LOG 2>/dev/null); finishes=${finishes:-0}
    if [ "$starts" -gt "$finishes" ]; then
      ok=0
      for i in $(seq 15); do
        sleep 1
        f2=$(grep -ac "virtual-req-finish" $LOG 2>/dev/null); f2=${f2:-0}
        [ "$f2" -ge "$starts" ] && ok=1 && break
      done
      [ $ok = 0 ] && capture "open chrome-module request 15s+" && FIRED=1
    elif grep -aq "doc-req-start" $LOG 2>/dev/null; then
      lines=$(grep -ac "" $LOG 2>/dev/null); lines=${lines:-0}
      quiet=0
      for i in $(seq 20); do
        sleep 1
        now=$(grep -ac "" $LOG 2>/dev/null); now=${now:-0}
        [ "$now" -gt "$lines" ] && quiet=0 && break
        quiet=1
      done
      [ $quiet = 1 ] && capture "boot silent 20s" && FIRED=1
    fi
  fi
  sleep 1
done
