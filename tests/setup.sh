#!/usr/bin/env bash
# Set up node_modules symlinks so the e2e tests can resolve @earendil-works/pi-coding-agent.
# The package is globally installed; bun test doesn't respect NODE_PATH.
#
# Run once before the first test:
#   bash tests/setup.sh
set -euo pipefail

GLOBAL_MODULES="/opt/homebrew/lib/node_modules/@earendil-works"
# pi-agent-core / pi-ai / pi-tui are NOT installed at the top level of
# /opt/homebrew/lib/node_modules/@earendil-works — they live nested inside
# pi-coding-agent's own node_modules. Linking the top-level path creates a
# DANGLING symlink, which wedges bun's module resolver when two test files
# import the same missing package (bun test then prints partial results and
# never exits). Resolve each package's real location and fail loudly if it
# cannot be found anywhere.
NESTED_MODULES="$GLOBAL_MODULES/pi-coding-agent/node_modules/@earendil-works"
LOCAL_MODULES="$(cd "$(dirname "$0")/.." && pwd)/node_modules/@earendil-works"

mkdir -p "$LOCAL_MODULES"

for pkg in pi-coding-agent pi-agent-core pi-ai pi-tui; do
  target=""
  if [ -d "$GLOBAL_MODULES/$pkg" ]; then
    target="$GLOBAL_MODULES/$pkg"
  elif [ -d "$NESTED_MODULES/$pkg" ]; then
    target="$NESTED_MODULES/$pkg"
  else
    echo "ERROR: cannot locate @earendil-works/$pkg (checked $GLOBAL_MODULES and $NESTED_MODULES)" >&2
    exit 1
  fi

  local_link="$LOCAL_MODULES/$pkg"
  if [ -L "$local_link" ]; then
    # -L is true for symlinks incl. dangling ones; readlink gives the raw target.
    current="$(readlink "$local_link")"
    if [ "$current" = "$target" ]; then
      echo "Already linked: $pkg"
    else
      # ln -s will NOT replace an existing (even dangling) symlink — it fails
      # with "File exists". -f unlinks the old entry first; -n prevents the
      # "symlink-to-directory destination" trap.
      ln -sfn "$target" "$local_link"
      echo "Re-linked $pkg -> $target (was -> $current)"
    fi
  elif [ -e "$local_link" ]; then
    echo "ERROR: $local_link exists as a non-symlink; remove it and re-run setup.sh" >&2
    exit 1
  else
    ln -s "$target" "$local_link"
    echo "Linked $pkg -> $target"
  fi
done
