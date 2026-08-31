#!/bin/zsh
# Safe observer: timestamped record of what listens on the lane ports and how
# many dev servers are alive. Usage: monitor.sh <tag>
TAG=$1
OUT=${OUT_DIR:-/tmp/astroix-stall-lab}
P=${ASTROIX_E2E_PORT:-4383}
PP=${ASTROIX_E2E_PACK_PORT:-4384}
PS=${ASTROIX_E2E_SRC_PORT:-4385}
mkdir -p $OUT
while true; do
  a=$(lsof -nP -iTCP:$P -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | tr '\n' ' ')
  b=$(lsof -nP -iTCP:$PP -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | tr '\n' ' ')
  c=$(lsof -nP -iTCP:$PS -sTCP:LISTEN 2>/dev/null | tail -n +2 | awk '{print $1"/"$2}' | tr '\n' ' ')
  n=$(pgrep -fl "astro dev" 2>/dev/null | wc -l | tr -d ' ')
  echo "$(date -u +%H:%M:%S) $P:[${a}] $PP:[${b}] $PS:[${c}] astro-dev-procs:$n" >> $OUT/monitor-$TAG.log
  sleep 0.5
done
