#!/usr/bin/env bash
# Mechanically verifies no unrenamed agentscope/AgentScope refs remain in source.
# Exit 0 = clean. Exit 1 = matches found.

REPO="$(cd "$(dirname "$0")/.." && pwd)"

RESULTS=$(grep -rIE 'agentscope|AgentScope' \
  "$REPO/src" \
  "$REPO/frontend/src" \
  "$REPO/test" \
  "$REPO/bin" \
  "$REPO/LICENSE" \
  "$REPO/README.md" \
  --exclude-dir=assets \
  2>/dev/null \
  | grep -v -F -f "$REPO/scripts/rename-allowlist.txt")

if [ -z "$RESULTS" ]; then
  echo "rename check: PASS (zero matches)"
  exit 0
else
  echo "rename check: FAIL — remaining matches:"
  echo "$RESULTS"
  exit 1
fi
