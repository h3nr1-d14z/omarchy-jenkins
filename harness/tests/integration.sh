#!/usr/bin/env bash
# End-to-end integration tests for the jenkins-health harness.
#
# For each scenario (healthy, degraded, outage) this spawns the mock Jenkins
# server, fetches its endpoints with real curl, validates the JSON shape with
# jq, and then runs the plugin's Model.js over the wire payloads (via
# integration_check.mjs) — the full HTTP -> parse -> assess pipeline. The
# outage scenario asserts curl fails (502) and that Model.js classifies an
# unreachable controller as critical.
#
# One composite check per scenario: PASS only if curls, jq shape checks, and
# the Model.js validation all succeed. Missing Model.js fails all scenarios.
# If the mock server cannot start (Python missing, port in use) the whole
# suite is skipped with a warning: pass=0 fail=0.
#
# Always exits 0: failures lower the score, they never break the harness.
# Prints one PASS/FAIL line per scenario and a final
# "integration_passed=N integration_failed=N integration_total=3" summary.

cd "$(dirname "$0")/../.." || exit 0

if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/mise/installs/node/26.7.0/bin:$PATH"
fi

PORT=28888
BASE="http://127.0.0.1:$PORT"
passed=0
failed=0

MOCK_PID=""
cleanup() {
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; fi
}
trap cleanup EXIT

# Wait until the server answers with any HTTP status (~2s).
wait_mock() {
  local i
  for i in $(seq 1 20); do
    curl -s -o /dev/null --max-time 1 "$BASE/api/json" && return 0
    sleep 0.1
  done
  return 1
}

fetch_all() { # <dir>: fetch the five endpoints, saving payloads + headers
  local d="$1"
  curl -fsS -D "$d/headers.txt" -o "$d/api.json" "$BASE/api/json" &&
    curl -fsS -o "$d/computer.json" "$BASE/computer/api/json?depth=1" &&
    curl -fsS -o "$d/queue.json" "$BASE/queue/api/json" &&
    curl -fsS -o "$d/pluginManager.json" "$BASE/pluginManager/api/json" &&
    curl -fsS -o "$d/updateCenter.json" "$BASE/updateCenter/api/json"
}

healthy_ok() {
  local d="$1"
  fetch_all "$d" &&
    jq -e '.mode' "$d/api.json" >/dev/null &&
    [ "$(jq '.computer | length' "$d/computer.json")" = "6" ] &&
    [ "$(jq '.items | length' "$d/queue.json")" = "2" ] &&
    node harness/tests/integration_check.mjs healthy "$d"
}

degraded_ok() {
  local d="$1"
  fetch_all "$d" &&
    jq -e '.mode' "$d/api.json" >/dev/null &&
    [ "$(jq '.items | length' "$d/queue.json")" = "12" ] &&
    [ "$(jq '[.plugins[] | select(.hasUpdate == true)] | length' "$d/pluginManager.json")" -ge 1 ] &&
    node harness/tests/integration_check.mjs degraded "$d"
}

outage_ok() {
  # curl -f exits non-zero on the 502; no JSON validation attempted.
  local d="$1"
  ! curl -fsS -o /dev/null --max-time 5 "$BASE/api/json" 2>/dev/null &&
    node harness/tests/integration_check.mjs outage "$d"
}

run_scenario() {
  local scenario="$1" ok_fn="$2"
  local tmp
  tmp=$(mktemp -d)
  python3 harness/mock_jenkins.py "$scenario" "$PORT" >"$tmp/mock.log" 2>&1 &
  MOCK_PID=$!
  if ! wait_mock; then
    echo "WARN: mock server did not start (scenario: $scenario, port $PORT)"
    echo "integration_passed=$passed integration_failed=$failed integration_total=0"
    rm -rf "$tmp"
    MOCK_PID=""
    exit 0
  fi
  if "$ok_fn" "$tmp" >/dev/null 2>&1; then
    echo "PASS: $scenario scenario"
    passed=$((passed + 1))
  else
    echo "FAIL: $scenario scenario"
    failed=$((failed + 1))
  fi
  kill "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
  MOCK_PID=""
  rm -rf "$tmp"
}

run_scenario healthy healthy_ok
run_scenario degraded degraded_ok
run_scenario outage outage_ok

echo "integration_passed=$passed integration_failed=$failed integration_total=3"
exit 0
