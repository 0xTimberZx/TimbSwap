#!/usr/bin/env bash
#
# segment-commitments.sh — derive SegmentBoard openTable() commitments offline.
#
# Uses only `cast` (Foundry), so it needs no package.json and no npm install.
#
# A commitment is bound to the table id it will be opened under:
#   salt       = keccak256(abi.encodePacked(uint256 tableId, uint8 segment))
#   commitment = keccak256(abi.encodePacked(bytes32 secret, bytes32 salt))
#
# Getting the id wrong is SILENT — the table opens and takes bets, then every
# lockSegment reverts BadReveal and the round can only be settled by the public
# fallback. Read tableCount() on the board first and use tableCount + 1.
#
# Boards deployed with the nextTableId() / commitmentsFor() views should use those
# instead; this covers boards deployed before those helpers existed.
#
# Usage:
#   ./scripts/segment-commitments.sh <tableId> <passphrase>
#
# The passphrase deterministically derives all six secrets, so re-running the
# same command recovers them. KEEP IT SAFE: anyone with it can reveal early, and
# losing it means those segments can only settle via the fallback.

set -euo pipefail

TABLE_ID="${1:-}"
PASSPHRASE="${2:-}"

if [[ -z "$TABLE_ID" || -z "$PASSPHRASE" ]]; then
  echo "usage: $0 <tableId> <passphrase>" >&2
  exit 1
fi
if ! [[ "$TABLE_ID" =~ ^[0-9]+$ ]]; then
  echo "error: tableId must be a number" >&2
  exit 1
fi
if ! command -v cast >/dev/null 2>&1; then
  echo "error: 'cast' not found — install Foundry (https://getfoundry.sh)" >&2
  exit 1
fi

strip0x() { echo "${1#0x}"; }

echo "SegmentBoard commitments for table ${TABLE_ID}"
echo "(secrets derived from your passphrase — re-run this to recover them)"
echo

COMMITMENTS=()
for SEG in 1 2 3 4 5 6; do
  # abi.encodePacked(uint256 tableId, uint8 segment)
  PACKED=$(printf '0x%064x%02x' "$TABLE_ID" "$SEG")
  SALT=$(cast keccak "$PACKED")

  SECRET=$(cast keccak "${PASSPHRASE}:${TABLE_ID}:${SEG}")

  # abi.encodePacked(bytes32 secret, bytes32 salt)
  COMMITMENT=$(cast keccak "0x$(strip0x "$SECRET")$(strip0x "$SALT")")
  COMMITMENTS+=("$COMMITMENT")

  echo "segment ${SEG}"
  echo "  secret     ${SECRET}"
  echo "  salt       ${SALT}"
  echo "  commitment ${COMMITMENT}"
done

echo
echo "openTable() commitments array (paste into Remix):"
JOINED=""
for C in "${COMMITMENTS[@]}"; do
  [[ -n "$JOINED" ]] && JOINED+=","
  JOINED+="\"${C}\""
done
echo "[${JOINED}]"
echo
echo "At lock time: lockSegment(${TABLE_ID}, <segment>, <that segment's secret>)"
