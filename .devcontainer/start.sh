#!/usr/bin/env bash
set -eu
mkdir -p data
if curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then
  exit 0
fi
nohup setsid node server.mjs >data/server.log 2>&1 </dev/null &
preview_process=$!
for preview_attempt in {1..40}; do
  if curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then
    exit 0
  fi
  if ! kill -0 "$preview_process" 2>/dev/null; then
    cat data/server.log
    exit 1
  fi
  sleep 0.25
done
echo 'Preview did not become healthy. See data/server.log.' >&2
exit 1
