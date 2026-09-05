#!/usr/bin/env bash
# Runtime E2E: drives Service.qml inside a standalone Quickshell instance
# (tests/e2e/shell.qml, with Service.qml/Model.js symlinked in) against the
# mock Jenkins server, one scenario at a time. Exercises the live wiring the
# static checks cannot: netrc auth, sequential curl fetches, X-Jenkins
# header capture, assessment, and the QML property surface.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=28888
TOKEN_DIR=$(mktemp -d)
MOCK_PID=""
FAILED=0

cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "${E2E_DIR:-}" "$TOKEN_DIR"
}
trap cleanup EXIT
printf 'e2e-token-123\n' > "$TOKEN_DIR/token"

# Quickshell sandboxes a config to its own folder, but the omarchy plugin
# validator forbids symlinks inside the plugin tree — so the config folder
# is generated at runtime in /tmp, symlinking the REAL Service.qml and
# Model.js (the test always exercises the shipped files).
E2E_DIR=$(mktemp -d)
ln -s "$ROOT/Service.qml" "$E2E_DIR/Service.qml"
ln -s "$ROOT/Model.js" "$E2E_DIR/Model.js"
cp "$ROOT/tests/e2e/shell.qml" "$E2E_DIR/shell.qml"

start_mock() {
  python3 "$ROOT/harness/mock_jenkins.py" "$1" "$PORT" >/dev/null 2>&1 &
  MOCK_PID=$!
  local i
  for i in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/api/json" && return 0
    sleep 0.1
  done
  echo "mock failed to start (scenario: $1)" >&2
  exit 1
}

run_scenario() {
  local scenario="$1" expect="$2"
  start_mock "$scenario"

  local log
  log=$(mktemp)
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" timeout 20 qs -p "$E2E_DIR" >"$log" 2>&1 || true
  kill "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  echo "--- $scenario qs log:" >&2
  cat "$log" >&2

  local out
  out=$(grep -o 'JH-E2E {.*}' "$log" | tail -n1 || true)
  rm -f "$log"

  if [ -z "$out" ]; then
    echo "FAIL: $scenario — no JH-E2E output (instance crashed?)"
    FAILED=1
    return
  fi
  local json="${out#JH-E2E }"
  local verdict
  verdict=$(printf '%s' "$json" | jq -r "$expect")
  if [ "$verdict" = "true" ]; then
    echo "PASS: $scenario"
  else
    echo "FAIL: $scenario — invariant '$expect' not met: $json"
    FAILED=1
  fi
}

run_scenario healthy \
  '(.state == "ok") and (.score == 100) and (.version == "2.440.3") and (.nodes == 6) and (.queueDepth == 2) and (.controllerStatus == "up")'
run_scenario degraded \
  '(.state == "warn") and (.score == 60) and (.nodes == 6) and (.queueDepth == 12) and (.controllerStatus == "up")'
run_scenario outage \
  '(.state == "critical") and (.score == 0) and (.controllerStatus == "unreachable")'

if [ "$FAILED" = 1 ]; then
  echo "E2E-FAILED"
  exit 1
fi
echo "E2E-ALL-PASS"
