#!/bin/sh
# Start the session-mirror web app.
#
# The engine needs node:sqlite and zlib zstd (Node >= 22), which the system node
# may not have; the Harness runtime ships one, so prefer it.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${DSH_NODE_EXECUTABLE:-}" ] && [ -x "$DSH_NODE_EXECUTABLE" ]; then
  NODE="$DSH_NODE_EXECUTABLE"
  ELECTRON="1"
elif node -e "require('node:sqlite');require('node:zlib').zstdDecompressSync" >/dev/null 2>&1; then
  NODE="node"
  ELECTRON="0"
else
  echo "需要 Node >= 22（node:sqlite + zlib zstd），或设置 DSH_NODE_EXECUTABLE 指向 DSH 运行时" >&2
  exit 1
fi

PORT="${SESSION_MIRROR_PORT:-8787}"
echo "启动：http://127.0.0.1:${PORT}"
if [ "$ELECTRON" = "1" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$NODE" web/server.ts
fi
exec "$NODE" web/server.ts
