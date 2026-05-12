#!/usr/bin/env bash
set -euo pipefail

# Run from the repo root so .env, data/, downloads/, dist/ all resolve.
# (readlink -f doesn't exist on macOS BSD; this idiom is portable.)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
mkdir -p logs

# YYYY-MM-DD stamp.
STAMP="$(date +%Y-%m-%d)"

# Tell the logger to also write to this file. The app still writes
# to stdout normally, so manual runs show up in the terminal AND the file.
export LOG_FILE="$SCRIPT_DIR/logs/cron-${STAMP}.log"

# cron / launchd can launch with a stripped PATH. If node isn't visible,
# probe the common install locations before giving up.
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
    if ! command -v node >/dev/null 2>&1; then
        echo "node not found on PATH" >&2
        exit 127
    fi
fi

# exec so the script's exit code is whatever node returned
# (0 ok, 1 fatal, 2 reauth required).
exec node dist/index.js run
