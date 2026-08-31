#!/bin/zsh
# Serial campaign of pristine full-suite iterations. SERIAL ONLY: two loops
# sharing the lane ports + fixture dirs contaminate each other's boots (the
# #171 lane paid for this — see NOTES.md). Usage: campaign.sh <first> <last>
set -u
LAB="$(cd "$(dirname "$0")" && pwd)"
N1=$1; N2=$2
for n in $(seq $N1 $N2); do
  zsh $LAB/pristine-iter.sh $n 7
done
