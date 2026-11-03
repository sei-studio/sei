#!/usr/bin/env bash
# The pilot matrix, run serially (one Xvfb + Chrome at a time). Reps are the
# outer loop so a stopped run still leaves every task with balanced reps.
#   OUT=... REPS=3 bash matrix.sh   (logs one line per run to stdout)
set -u
cd "$(dirname "$0")"
OUT=${OUT:-$HOME/suisei/reports/take-the-wheel-2026-11-03/runs}
REPS=${REPS:-3}
run() { timeout 900 node run.mjs --out "$OUT" "$@" || echo "run exited $? ($*)"; }
budget() { case $1 in 2048) echo "--max-steps 150 --max-seconds 360";; *) echo "--max-steps 60 --max-seconds 180";; esac; }

for rep in $(seq 1 "$REPS"); do
  for task in mc-walk mc-blocks mc-find 2048 cookie; do
    for arm in single batch; do
      run --task "$task" --arm "$arm" --rep "$rep" $(budget "$task")
    done
  done
  run --task 2048 --arm random --rep "$rep" $(budget 2048)
done
# A stronger model on the hardest task.
for rep in 1 2; do
  run --task "${HARD:-mc-find}" --arm batch --model claude-sonnet-5 --rep "$rep" $(budget "${HARD:-mc-find}")
done
echo matrix done
