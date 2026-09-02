#!/usr/bin/env bash
# Restart the PIE API cleanly, from any working directory.
# Only kills processes whose command line STARTS WITH "node " — never a shell.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/server" || { echo "cannot find $ROOT/server"; exit 1; }

for p in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  c=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null) || continue
  case "$c" in node\ *index.js*) kill "$p" 2>/dev/null ;; esac
done 2>/dev/null

sleep 1
setsid nohup node src/index.js > /tmp/pie.log 2>&1 < /dev/null &
sleep 2
if curl -s -m 5 "localhost:${PORT:-5174}/api/health" > /dev/null; then
  echo "PIE API up on :${PORT:-5174}"
  grep -E '^  (env|AI|Store):' /tmp/pie.log | tail -6
else
  echo "FAILED — last log lines:"; tail -20 /tmp/pie.log
fi
