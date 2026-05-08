#!/usr/bin/env bash
# ClaudeLens installer
# Usage: curl -fsSL https://raw.githubusercontent.com/elcronos/claudelens/main/install.sh | sh

set -euo pipefail

REPO="https://github.com/elcronos/claudelens.git"
DEST="${CLAUDELENS_HOME:-$HOME/.claudelens-src}"
BRANCH="${CLAUDELENS_BRANCH:-main}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "[claudelens] missing: $1" >&2; exit 1; }
}

need git
need node
need npm

echo "[claudelens] target: $DEST"

if [ -d "$DEST/.git" ]; then
  echo "[claudelens] repo exists, pulling..."
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  echo "[claudelens] cloning $REPO ..."
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
fi

cd "$DEST"

echo "[claudelens] installing root deps..."
npm install --silent

echo "[claudelens] building frontend..."
( cd frontend && npm install --silent && npm run build --silent )

echo "[claudelens] installing global..."
npm install -g . --silent

echo
echo "[claudelens] done. Run: claudelens"
echo "[claudelens] source: $DEST"
