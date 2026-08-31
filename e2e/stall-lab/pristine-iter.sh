#!/bin/zsh
# One faithful full-suite stall-hunt iteration: pristine conditions (no trace
# env, no NODE_OPTIONS — env feeds vite's config hash and changes the boot),
# external observers only (monitor + load bursts), artifacts preserved
# capture-first. Usage: pristine-iter.sh <n> <burst-mins>
set -u
N=$1
BURST=${2:-7}
LAB="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$LAB/../.." && pwd)"
OUT=${OUT_DIR:-/tmp/astroix-stall-lab}
P=${ASTROIX_E2E_PORT:-4383}
PP=${ASTROIX_E2E_PACK_PORT:-4384}
PS=${ASTROIX_E2E_SRC_PORT:-4385}
mkdir -p $OUT
cd $ROOT || exit 1
zsh $LAB/monitor.sh pristine-$N &
MON=$!
zsh $LAB/burst.sh $BURST &
BP=$!
zsh $LAB/io-burst.sh $BURST &
IO=$!
uptime >> $OUT/uptime.log
ASTROIX_E2E_PORT=$P ASTROIX_E2E_PACK_PORT=$PP ASTROIX_E2E_SRC_PORT=$PS \
  bun run test:e2e > $OUT/pristine-$N.log 2>&1
STATUS=$?
kill $MON $BP $IO 2>/dev/null
pkill -f "createHash('sha256')" 2>/dev/null
if [ -d $ROOT/test-results ]; then
  rm -rf $OUT/pristine-$N-test-results
  cp -R $ROOT/test-results $OUT/pristine-$N-test-results
fi
echo "pristine $N exit=$STATUS failed=$(grep -ac '^  ✘' $OUT/pristine-$N.log) $(grep -a 'passed (' $OUT/pristine-$N.log | tail -1)" >> $OUT/summary.log
grep -aE "^  ✘" $OUT/pristine-$N.log | head -4 >> $OUT/summary.log
