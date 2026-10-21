#!/usr/bin/env bash
# Snapshot any composition of a film project: HyperFrames' snapshot reads only index.html, so the composition is
# swapped in for the run and index.html restored afterwards (even on failure).
#   scripts/snapshot.sh <film dir> <composition.html> <out dir> <t1,t2,...>
set -euo pipefail
dir=$1 comp=$2 out=$3 at=$4
cd "$dir"
if [ "$comp" != "index.html" ]; then
  cp index.html .index.master.html
  trap 'mv .index.master.html index.html' EXIT
  cp "$comp" index.html
fi
rm -rf "$out"
npx --yes hyperframes@0.8.181 snapshot --at "$at" --no-end --timeout 60000 -o "$out" .
