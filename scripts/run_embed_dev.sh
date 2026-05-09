#!/usr/bin/env bash
# Run Tarsa with embedded cc-web terminal (feat/embed-terminal).
# Starts: tarsa backend (port 8100), vendored cc-web (port 8101, supervised),
# and the Vite frontend dev server.
#
# Usage:
#   ./scripts/run_embed_dev.sh                # default: backend + frontend
#   PORT=8100 ./scripts/run_embed_dev.sh      # override backend port
#   NO_FRONTEND=1 ./scripts/run_embed_dev.sh  # backend only
#   NO_BROWSER=1 ./scripts/run_embed_dev.sh   # don't auto-open browser
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-8100}"
EXPECTED_BRANCH="feat/embed-terminal"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "[run_embed_dev] warn: on '$CURRENT_BRANCH', expected '$EXPECTED_BRANCH'" >&2
fi

# Pick a node binary. better-sqlite3 11.x and node-pty don't compile cleanly
# against node 26 yet, so prefer node@22 LTS when present (Homebrew layout).
# Override with TARSA_NODE_BIN=/path/to/node ./scripts/run_embed_dev.sh.
NODE_BIN="${TARSA_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  for cand in /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node "$(command -v node 2>/dev/null || true)"; do
    if [[ -x "$cand" ]]; then NODE_BIN="$cand"; break; fi
  done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[run_embed_dev] no node binary found (install node@22: brew install node@22)" >&2; exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR >= 24 )); then
  echo "[run_embed_dev] warn: node $NODE_MAJOR may fail to compile better-sqlite3; recommend node@22" >&2
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
export TARSA_NODE_BIN="$NODE_BIN"
RUN_BACKEND=(npx --yes tsx src/cli.ts)

# Ensure vendored cc-web deps are present (node-pty needs install once).
if [[ ! -d vendor/cc-web/node_modules ]]; then
  echo "[run_embed_dev] installing vendor/cc-web deps..."
  (cd vendor/cc-web && npm install --no-audit --no-fund)
fi

# node-pty is a native module. If installed under a different node ABI (e.g.
# bun, nvm switch, system upgrade) it loads but throws on use, and the cc-web
# child exits silently — UI then shows "cc-web is not running". Verify against
# the current node and rebuild on mismatch. Force rebuild via REBUILD_PTY=1.
NODE_ABI="$("$NODE_BIN" -p 'process.versions.modules' 2>/dev/null || echo unknown)"
# Workspace hoists node-pty to root node_modules; fall back to per-package.
PTY_DIR=""
for d in node_modules/node-pty vendor/cc-web/node_modules/node-pty; do
  [[ -d "$d" ]] && PTY_DIR="$d" && break
done
if [[ -z "$PTY_DIR" ]]; then
  echo "[run_embed_dev] node-pty not installed — running npm install at repo root..."
  npm install --no-audit --no-fund
  for d in node_modules/node-pty vendor/cc-web/node_modules/node-pty; do
    [[ -d "$d" ]] && PTY_DIR="$d" && break
  done
fi
PTY_STAMP="$PTY_DIR/.tarsa-abi"
NEED_REBUILD=0
if [[ -n "${REBUILD_PTY:-}" ]]; then
  NEED_REBUILD=1
elif [[ ! -f "$PTY_STAMP" ]] || [[ "$(cat "$PTY_STAMP" 2>/dev/null)" != "$NODE_ABI" ]]; then
  NEED_REBUILD=1
fi
if [[ "$NEED_REBUILD" == "1" ]]; then
  echo "[run_embed_dev] rebuilding native modules (node-pty, better-sqlite3) for node ABI $NODE_ABI..."
  npm rebuild node-pty better-sqlite3
  (cd vendor/cc-web && npm rebuild node-pty) 2>/dev/null || true
  echo "$NODE_ABI" > "$PTY_STAMP"
fi

# Ensure frontend deps installed.
if [[ -z "${NO_FRONTEND:-}" && ! -d frontend/node_modules ]]; then
  echo "[run_embed_dev] installing frontend deps..."
  (cd frontend && npm install --no-audit --no-fund)
fi

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

BACKEND_ARGS=(--port "$PORT")
[[ -n "${NO_BROWSER:-}" ]] && BACKEND_ARGS+=(--no-browser)

export TARSA_TERMINAL="${TARSA_TERMINAL:-1}"

echo "[run_embed_dev] backend: ${RUN_BACKEND[*]} ${BACKEND_ARGS[*]} (TARSA_TERMINAL=$TARSA_TERMINAL)"
"${RUN_BACKEND[@]}" "${BACKEND_ARGS[@]}" &
PIDS+=($!)

if [[ -z "${NO_FRONTEND:-}" ]]; then
  echo "[run_embed_dev] frontend: vite dev"
  (cd frontend && npm run dev) &
  PIDS+=($!)
fi

# macOS ships bash 3.2 (no `wait -n`). Poll children; exit when any dies.
while :; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      exit $?
    fi
  done
  sleep 1
done
