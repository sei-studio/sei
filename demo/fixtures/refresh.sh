#!/usr/bin/env bash
# demo/fixtures/refresh.sh — re-pull the demo's default-character portraits and
# skins from the live cloud rows.
#
# Since 260707 the three defaults (Sui / Lyra / Marv) are ordinary cloud-owned
# public characters (owner ouen), NOT bundled resources, so the marketing demo
# keeps a self-contained copy of their art + persona here under demo/fixtures.
# Run this whenever ouen updates a default's portrait or skin in-app so the demo
# matches what users actually see. The persona text in default-characters/*.json
# is maintained by hand; update it from the characters table if it drifts.
#
# The portraits/skins buckets are public, so no auth is needed.
set -euo pipefail
cd "$(dirname "$0")"

BASE="https://wfloawnjgkpammmnjncm.supabase.co/storage/v1/object/public"
OWNER="571634bd-0f6d-4835-bef2-06fd7f449a3d"

# slug -> character uuid
declare -A IDS=(
  [sui]=bbf5b66f-2f0f-4918-a953-a2cf66d5a586
  [lyra]=e4511df2-fd20-470b-9131-f8f9968e1c01
  [marv]=25770cd6-a50b-409d-a7e2-6cc2026dd673
)

mkdir -p portraits skins
for slug in sui lyra marv; do
  uuid="${IDS[$slug]}"
  echo "fetching $slug ($uuid) ..."
  curl -fsS -o "portraits/$slug.png" "$BASE/portraits/$OWNER/$uuid.png"
  curl -fsS -o "skins/$slug.png"     "$BASE/skins/$OWNER/$uuid.png"
done
echo "done -> demo/fixtures/{portraits,skins}/*.png"
