#!/bin/zsh
# CPU pressure for stall-hunting: waves of 2-8s hash loops, 3-6 at a time,
# random gaps — bursty like compiler/desktop churn, unlike steady busy loops.
# The trap matters: iteration drivers kill this shell by pid, and without it
# the hash loops outlive their parent and accumulate across iterations (the
# #171 lane lost a batch this way — see NOTES.md). Usage: burst.sh <minutes>
MIN=${1:-8}
trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM
END=$(( $(date +%s) + MIN * 60 ))
while [ $(date +%s) -lt $END ]; do
  n=$((RANDOM % 4 + 3))
  for i in $(seq $n); do
    d=$((RANDOM % 6000 + 2000))
    node -e "const e=Date.now()+$d;const c=require('crypto');while(Date.now()<e)c.createHash('sha256').update('x').digest()" &
  done
  sleep $((RANDOM % 3 + 1))
done
wait
