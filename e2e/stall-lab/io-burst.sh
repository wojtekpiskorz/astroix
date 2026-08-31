#!/bin/zsh
# IO pressure for stall-hunting: spotlight/backup-shaped waves — big
# sequential reads plus small-file stat storms against the fixture tree.
# macOS load averages count uninterruptible IO wait, so "ambient load" on a
# dev machine is often disk contention, not CPU. Usage: io-burst.sh <minutes>
MIN=${1:-8}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WT=$ROOT/e2e/fixture
END=$(( $(date +%s) + MIN * 60 ))
while [ $(date +%s) -lt $END ]; do
  n=$((RANDOM % 3 + 2))
  for i in $(seq $n); do
    case $((RANDOM % 2)) in
      0) (cd $WT && tar cf /dev/null node_modules 2>/dev/null) & ;;
      1) find $WT/node_modules -maxdepth 6 -type f 2>/dev/null | head -40000 | xargs stat -f z >/dev/null 2>&1 &
    esac
  done
  sleep $((RANDOM % 4 + 2))
done
wait
