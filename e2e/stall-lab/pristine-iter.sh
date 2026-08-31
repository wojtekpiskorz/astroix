#!/bin/zsh
# One faithful full-suite stall-hunt iteration: pristine conditions (no trace
# env, no NODE_OPTIONS — env feeds vite's config hash and changes the boot),
# external observers only (monitor + load bursts), artifacts preserved
# capture-first. Usage: pristine-iter.sh <n> <burst-mins>
set -u
# Kill a generator's whole tree, not just its shell: traps alone are not
# airtight (deferred mid-sleep, and grandchildren slip a plain kill — the
# #171 lane lost a batch to exactly that; see NOTES.md). Job control is not
# an option here (non-interactive zsh refuses `set -m`), and a CONT+TERM
# handoff lets the shell run one more wave loop before dying (observed live),
# so: freeze the generator, recurse over descendants, then SIGKILL the
# frozen shell — it never resumes, so it can never spawn again.
kill_tree() {
  local pid=$1 child
  kill -STOP $pid 2>/dev/null
  for child in $(pgrep -P $pid 2>/dev/null); do
    kill_tree $child
  done
  kill -KILL $pid 2>/dev/null
}
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
kill_tree $MON; kill_tree $BP; kill_tree $IO
if [ -d $ROOT/test-results ]; then
  rm -rf $OUT/pristine-$N-test-results
  cp -R $ROOT/test-results $OUT/pristine-$N-test-results
fi
echo "pristine $N exit=$STATUS failed=$(grep -ac '^  ✘' $OUT/pristine-$N.log) $(grep -a 'passed (' $OUT/pristine-$N.log | tail -1)" >> $OUT/summary.log
grep -aE "^  ✘" $OUT/pristine-$N.log | head -4 >> $OUT/summary.log
