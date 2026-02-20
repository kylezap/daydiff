#!/usr/bin/env bash
# When run from daydiff repo: sources .env and runs Python script
set -e
cd "$(dirname "$0")/.."
[[ -f .env ]] && set -a && source .env && set +a
exec python3 scripts/export-to-csv.py "$@"
