#!/bin/sh
# One-command acceptance: run this after restarting DSH.
#
# It prints the health of every mirror group, runs the full regression, and shows
# the resume command for each replica so the same conversation can be opened in
# all three harnesses.
set -eu

NODE="${DSH_NODE_EXECUTABLE:-/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness}"

echo "=== 1. 三端存储 ==="
ELECTRON_RUN_AS_NODE=1 "$NODE" src/cli.ts stats

echo
echo "=== 2. 镜像组健康度 ==="
ELECTRON_RUN_AS_NODE=1 "$NODE" src/cli.ts doctor

echo
echo "=== 3. 回归测试 ==="
ELECTRON_RUN_AS_NODE=1 "$NODE" scripts/regression.ts

echo
echo "=== 4. 备份 ==="
ls -1dt ~/.codex/mirror-backups/* 2>/dev/null | head -3 || echo "(还没有 Codex 写入备份)"
ls -1dt ~/.dsh/migration-backups/* 2>/dev/null | head -3 || echo "(还没有 DSH 写入备份)"

echo
echo "=== 5. 用同一个会话在三端打开 ==="
python3 - <<'PY'
import json, os
path = os.path.expanduser('~/.dsh/migration-ledgers/session-mirror.json')
try:
    data = json.load(open(path))
except FileNotFoundError:
    print('还没有镜像组')
    raise SystemExit(0)
for record in data.get('records', {}).values():
    print(f"\n{record['title']}")
    replicas = record.get('replicas', {})
    cwd = record.get('cwd') or '~'
    if 'claude' in replicas:
        print(f"  Claude : (cd {cwd} && claude --resume {replicas['claude']['sessionId']})")
    if 'codex' in replicas:
        print(f"  Codex  : (cd {cwd} && codex resume {replicas['codex']['sessionId']})")
    if 'dsh' in replicas:
        print(f"  DSH    : 侧栏打开 {replicas['dsh']['sessionId']}")
PY
