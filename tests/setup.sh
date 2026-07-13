#!/usr/bin/env bash
# Set up node_modules symlinks so the e2e tests can resolve @earendil-works/pi-coding-agent.
# The package is globally installed; bun test doesn't respect NODE_PATH.
#
# Run once before the first test:
#   bash tests/setup.sh
set -euo pipefail

GLOBAL_MODULES="/opt/homebrew/lib/node_modules/@earendil-works"
LOCAL_MODULES="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@earendil-works"

mkdir -p "$LOCAL_MODULES"

for pkg in pi-coding-agent pi-agent-core pi-ai pi-tui; do
  if [ ! -e "$LOCAL_MODULES/$pkg" ]; then
    ln -s "$GLOBAL_MODULES/$pkg" "$LOCAL_MODULES/$pkg"
    echo "Linked $pkg"
  else
    echo "Already linked: $pkg"
  fi
done
