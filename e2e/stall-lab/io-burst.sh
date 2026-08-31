#!/bin/zsh
# IO pressure for stall-hunting: spotlight/backup-shaped waves — big
# sequential reads plus small-file stat storms against the fixture tree.
# macOS load averages count uninterruptible IO wait, so "ambient load" on a
# dev machine is often disk contention, not CPU.
#
# The trap matters twice over: the tar/find/xargs waves spawn their own
# children, and iteration drivers kill this shell by pid — without the trap
# the waves outlive their parent, accumulate across iterations, and take the
# machine to load ~300 (the #171 lane lost a batch this way — see NOTES.md).
# Usage: io-burst.sh <minutes>
MIN=${1:-8}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WT=$ROOT/e2e/fixture
PIDS=()
cleanup() {
  for p in $PIDS; do
    pkill -P $p 2>/dev/null   # wave children (tar/find pipes, xargs stats)
    kill $p 2>/dev/null
  done
}
trap cleanup EXIT INT TERM
END=$(( $(date +%s) + MIN * 60 ))
while [ $(date +%s) -lt $END ]; do
  n=$((RANDOM % 3 + 2))
  for i in $(seq $n); do
    case $((RANDOM % 2)) in
      0) (cd $WT && tar cf /dev/null node_modules 2>/dev/null) & PIDS+=($!) ;;
      1) find $WT/node_modules -maxdepth 6 -type f 2>/dev/null | head -40000 | xargs stat -f z >/dev/null 2>&1 & PIDS+=($!) ;;
    esac
  done
  sleep $((RANDOM % 4 + 2))
done
wait
