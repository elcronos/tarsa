#!/usr/bin/env bash
# Tarsa installer
# Usage: curl -fsSL https://raw.githubusercontent.com/elcronos/tarsa/main/install.sh | sh

set -euo pipefail

REPO="https://github.com/elcronos/tarsa.git"
DEST="${TARSA_HOME:-$HOME/.tarsa-src}"
BRANCH="${TARSA_BRANCH:-main}"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "[tarsa] missing: $1" >&2; exit 1; }
}

need git
need node
need npm

echo "[tarsa] target: $DEST"

if [ -d "$DEST/.git" ]; then
  echo "[tarsa] repo exists, pulling..."
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  echo "[tarsa] cloning $REPO ..."
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
fi

cd "$DEST"

echo "[tarsa] installing root deps..."
npm install --silent

echo "[tarsa] building frontend..."
( cd frontend && npm install --silent && npm run build --silent )

echo "[tarsa] installing global..."
npm install -g . --silent

echo
echo "[tarsa] done. Run: tarsa"
echo "[tarsa] source: $DEST"
