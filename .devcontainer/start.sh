#!/usr/bin/env bash
set -eu
mkdir -p data
if curl --fail --silent http://127.0.0.1:3000/api/health >/dev/null; then
  exit 0
fi
nohup node server.mjs >data/server.log 2>&1 </dev/null &
