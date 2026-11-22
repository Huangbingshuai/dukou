#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ -n "${DSH_NODE_EXECUTABLE:-}" ] && [ -x "$DSH_NODE_EXECUTABLE" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" scripts/zcode-web-browser-regression.ts
fi

if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  exec node scripts/zcode-web-browser-regression.ts
fi

echo "需要 Node >= 24 或设置 DSH_NODE_EXECUTABLE" >&2
exit 1
