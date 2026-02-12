#!/bin/bash
# DayDiff — Install / Uninstall macOS launchd job
# Usage:
#   ./scripts/install-launchd.sh install
#   ./scripts/install-launchd.sh uninstall

set -euo pipefail

LABEL="com.daydiff.daily"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

case "${1:-install}" in
  install)
    echo "Installing DayDiff daily job..."
    node src/cli.mjs install-schedule
    ;;

  uninstall)
    echo "Uninstalling DayDiff daily job..."
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "Removed: $PLIST_PATH"
    else
      echo "No plist found at $PLIST_PATH"
    fi
    echo "Done."
    ;;

  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "DayDiff job is loaded."
      launchctl list "$LABEL"
    else
      echo "DayDiff job is not loaded."
    fi
    ;;

  *)
    echo "Usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
