#!/usr/bin/env bash
set -euo pipefail

# Resolve the script's own directory portably (readlink -f doesn't exist on macOS).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p logs
STAMP="$(date +%Y-%m-%d)"
# Let the logger mirror everything to this file; stdout still gets the same lines.
export LOG_FILE="$SCRIPT_DIR/logs/cron-${STAMP}.log"

# Cron runs with a minimal PATH. Probe the common Node install locations.
if ! command -v node >/dev/null 2>&1; then
  for candidate in \
    /usr/local/bin \
    /opt/homebrew/bin \
    /usr/bin \
    "$HOME/.nvm/versions/node"/*/bin \
    "$HOME/.volta/bin"; do
    if [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      break
    fi
  done
fi

exec node dist/index.js run
