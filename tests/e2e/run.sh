#!/usr/bin/env bash
# Runtime E2E: drives Service.qml inside a standalone Quickshell instance
# (tests/e2e/shell.qml, with Service.qml/Model.js symlinked into a throwaway
# /tmp config folder) against the mock Jenkins server.
#
# Phases:
#   1. scenario dumps    — healthy / degraded / outage state assertions
#   2. notification flow — healthy→degraded transition mid-run with
#                          notifications captured via an omarchyPath shim;
#                          asserts the exact edge-triggered event set (five
#                          events, no duplicates on later polls, no
#                          controller flapping)
#   3. IPC surface       — live qs ipc calls against the running instance
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=28888
TOKEN_DIR=$(mktemp -d)
MOCK_PID=""
ACTION_PID=""
QS_PID=""
FAILED=0

cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  [ -n "$ACTION_PID" ] && kill "$ACTION_PID" 2>/dev/null || true
  [ -n "$QS_PID" ] && kill "$QS_PID" 2>/dev/null || true
  rm -rf "${E2E_DIR:-}" "$TOKEN_DIR" "${SHIM_DIR:-}"
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
ln -s "$ROOT/BarWidget.qml" "$E2E_DIR/BarWidget.qml"
ln -s "$ROOT/Panel.qml" "$E2E_DIR/Panel.qml"
# qs.* imports resolve against the config folder: provide the Omarchy
# shell's Ui and Commons trees so BarWidget/Panel load with their real
# base classes and singletons.
ln -s /usr/share/omarchy/shell/Ui "$E2E_DIR/Ui"
ln -s /usr/share/omarchy/shell/Commons "$E2E_DIR/Commons"
cp "$ROOT/tests/e2e/shell.qml" "$E2E_DIR/shell.qml"
cp "$ROOT/tests/e2e/widget-shell.qml" "$E2E_DIR/widget-shell.qml"
cp "$ROOT/tests/e2e/render-shell.qml" "$E2E_DIR/render-shell.qml"
cp "$ROOT/tests/e2e/action-shell.qml" "$E2E_DIR/action-shell.qml"
cp "$ROOT/tests/e2e/lifecycle-shell.qml" "$E2E_DIR/lifecycle-shell.qml"

start_mock() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
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

# ---- phase 1: scenario dumps ----------------------------------------------

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

# ---- phase 2: notification flow --------------------------------------------
# The shim tree's bin/omarchy-notification-send logs every invocation; the
# service's omarchyPath property (injected by the harness) points at it. The
# first healthy snapshot emits nothing (null baseline); the mock then
# switches to degraded, and the next poll must emit exactly the five
# edge-triggered events. Subsequent polls of the same state emit nothing.

run_notify_phase() {
  SHIM_DIR=$(mktemp -d)
  mkdir -p "$SHIM_DIR/bin"
  cat > "$SHIM_DIR/bin/omarchy-notification-send" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$JH_NOTIFY_LOG"
EOF
  chmod +x "$SHIM_DIR/bin/omarchy-notification-send"
  local notify_log="$SHIM_DIR/notifications.log"
  : > "$notify_log"

  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    JH_NOTIFY_LOG="$notify_log" \
    JH_E2E_NOTIFY=1 JH_E2E_SHIM_DIR="$SHIM_DIR" \
    JH_E2E_REFRESH=5 JH_E2E_QUIT_MS=12000 \
    qs -p "$E2E_DIR" >"$SHIM_DIR/qs.log" 2>&1 &
  QS_PID=$!

  # First (healthy) snapshot lands ~1s in; poll cadence is 5s, so switching
  # the mock now (~0.3s window) cannot overlap a poll.
  sleep 2
  start_mock degraded
  wait "$QS_PID" || true
  QS_PID=""

  echo "--- notification flow:" >&2
  cat "$notify_log" >&2

  # Check the timing hazard first: a poll landing in the mock-switch window
  # would emit controller-down/up events — diagnose that specifically
  # before the exact-count assertion turns it into a confusing number.
  if grep -q "controller" "$notify_log"; then
    echo "FAIL: notification flow — unexpected controller event (mock switch overlapped a poll?)"
    FAILED=1
    return
  fi

  local count
  count=$(wc -l < "$notify_log")
  if [ "$count" -ne 5 ]; then
    echo "FAIL: notification flow — expected 5 notifications, got $count (see stderr)"
    FAILED=1
    return
  fi
  local want
  for want in "Jenkins node offline" "Jenkins job failure" "Jenkins queue backlog" "Jenkins maintenance"; do
    if ! grep -q "$want" "$notify_log"; then
      echo "FAIL: notification flow — missing '$want' (see stderr)"
      FAILED=1
      return
    fi
  done
  if ! grep -q '"state":"warn"' "$SHIM_DIR/qs.log" || ! grep -q '"score":60' "$SHIM_DIR/qs.log"; then
    echo "FAIL: notification flow — final dump is not degraded warn/60 (see stderr)"
    FAILED=1
    return
  fi
  echo "PASS: notification flow (5 edge-triggered events, no duplicates, no controller flap)"
}

# ---- phase 3: IPC surface ---------------------------------------------------

run_ipc_phase() {
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" JH_E2E_QUIT_MS=30000 \
    qs -p "$E2E_DIR" >"$TOKEN_DIR/ipc.log" 2>&1 &
  QS_PID=$!
  sleep 2

  local status refresh open
  status=$(qs ipc --pid "$QS_PID" call jenkins-health status 2>&1 || true)
  refresh=$(qs ipc --pid "$QS_PID" call jenkins-health refresh 2>&1 || true)
  open=$(qs ipc --pid "$QS_PID" call jenkins-health open 2>&1 || true)
  kill "$QS_PID" 2>/dev/null || true
  wait "$QS_PID" 2>/dev/null || true
  QS_PID=""
  kill "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  echo "--- IPC responses:" >&2
  printf 'status:  %s\nrefresh: %s\nopen:    %s\n' "$status" "$refresh" "$open" >&2

  if ! printf '%s' "$status" | jq -e '(.state == "ok") and (.score == 100) and (.version == "2.440.3")' >/dev/null 2>&1; then
    echo "FAIL: IPC status — got: $status"
    FAILED=1
    return
  fi
  if [ "$refresh" = "ok" ] && [ "$open" = "ok" ]; then
    echo "PASS: IPC surface (status JSON, refresh, open)"
  else
    echo "FAIL: IPC — refresh='$refresh' open='$open'"
    FAILED=1
  fi
}

# ---- phase 4: widget + panel load ------------------------------------------
# Loads the real BarWidget.qml (and Panel.qml via its PopupCard) against the
# real Service through a fake bar host. Proves the production settings flow
# (widget settings → applyConfig → service polls), widget registration, and
# the IPC panel-open relay landing on a live registered widget.

run_widget_phase() {
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/widget-shell.qml" >"$TOKEN_DIR/widget.log" 2>&1 &
  QS_PID=$!
  sleep 4.5

  local opened
  opened=$(qs ipc --pid "$QS_PID" call jenkins-health open 2>&1 || true)
  wait "$QS_PID" || true
  QS_PID=""
  kill "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  echo "--- widget phase log:" >&2
  cat "$TOKEN_DIR/widget.log" >&2

  local w1 w2
  w1=$(grep -o 'JH-E2E-W1 {.*}' "$TOKEN_DIR/widget.log" | tail -n1 || true)
  w2=$(grep -o 'JH-E2E-W2 {.*}' "$TOKEN_DIR/widget.log" | tail -n1 || true)

  if [ -z "$w1" ] || [ -z "$w2" ]; then
    echo "FAIL: widget load — missing dump (W1='$w1' W2='$w2', open='$opened')"
    FAILED=1
    return
  fi
  if ! printf '%s' "${w1#JH-E2E-W1 }" | jq -e '(.registered == 1) and (.widgetState == "ok") and (.chipText == "100") and (.serviceState == "ok")' >/dev/null 2>&1; then
    echo "FAIL: widget load — W1 invariant not met: $w1"
    FAILED=1
    return
  fi
  if [ "$opened" = "ok" ] && printf '%s' "${w2#JH-E2E-W2 }" | jq -e '.popupOpen == true' >/dev/null 2>&1; then
    echo "PASS: widget + panel load (settings flow, registration, IPC open relay)"
  else
    echo "FAIL: widget load — open='$opened' W2: $w2"
    FAILED=1
  fi
}

# ---- run --------------------------------------------------------------------

run_scenario healthy \
  '(.state == "ok") and (.score == 100) and (.version == "2.440.3") and (.nodes == 6) and (.queueDepth == 2) and (.controllerStatus == "up")'
run_scenario degraded \
  '(.state == "warn") and (.score == 60) and (.nodes == 6) and (.queueDepth == 12) and (.controllerStatus == "up")'
run_scenario outage \
  '(.state == "critical") and (.score == 0) and (.controllerStatus == "unreachable")'

run_notify_phase
run_ipc_phase
run_widget_phase

# ---- phase 5: visual render --------------------------------------------------
# Draws the chip and panel content in a layer-shell window and captures
# exactly that surface (namespace jh-e2e-render) with grim — the user's
# desktop is never included. The automated assertions are structural
# (surface found, non-blank capture); the visual verdict comes from
# inspecting the saved capture.

run_render_phase() {
  if ! command -v grim >/dev/null 2>&1; then
    echo "SKIP: render phase (grim not found)"
    return
  fi
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/render-shell.qml" >"$TOKEN_DIR/render.log" 2>&1 &
  QS_PID=$!
  sleep 4

  local png="$TOKEN_DIR/render.png" geo
  geo=$(hyprctl layers -j | jq -r \
    '[.[] | .levels | to_entries[] | .value[]? | select(.namespace == "jh-e2e-render")]
     | .[0] | "\(.x),\(.y) \(.w)x\(.h)"' 2>/dev/null || true)
  if [ -n "$geo" ] && [ "$geo" != "null" ]; then
    grim -g "$geo" "$png" 2>>"$TOKEN_DIR/render.log" || true
  fi
  kill "$QS_PID" 2>/dev/null || true
  wait "$QS_PID" 2>/dev/null || true
  QS_PID=""
  kill "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  echo "--- render phase (geo='$geo'):" >&2
  cat "$TOKEN_DIR/render.log" >&2

  if [ ! -s "$png" ]; then
    echo "FAIL: render phase — no capture (surface not found or grim failed)"
    FAILED=1
    return
  fi
  local size
  size=$(stat -c %s "$png")
  if [ "$size" -lt 20000 ]; then
    echo "FAIL: render phase — capture looks blank (${size}B)"
    FAILED=1
    return
  fi
  cp "$png" /tmp/jenkins-health-render.png
  echo "PASS: render phase (${size}B capture, saved /tmp/jenkins-health-render.png)"
}

# ---- phase 6: safe actions ---------------------------------------------------
# An inline action server (NOT the frozen harness mock) serves the crumb
# endpoint and accepts safe-action POSTs, logging the request. Proves the
# full action path: runAction → crumb fetch → buildActionCommand → POST →
# actionMessage feedback that survives the auto-refresh poll.

run_action_phase() {
  local action_srv action_log
  action_srv=$(mktemp)
  action_log=$(mktemp)
  cat > "$action_srv" <<'PYEOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[1])
log = sys.argv[2]


class H(BaseHTTPRequestHandler):
    def _reply(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/crumbIssuer/api/json":
            self._reply(200, b'{"crumb":"action-crumb-1","crumbRequestField":"Jenkins-Crumb"}')
        else:
            self._reply(404, b'{}')

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        if n:
            self.rfile.read(n)
        with open(log, "a") as f:
            f.write("POST %s\\n" % self.path)
            f.write("crumb: %s\\n" % self.headers.get("Jenkins-Crumb", ""))
        self._reply(200, b'{}')

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", port), H).serve_forever()
PYEOF
  python3 "$action_srv" 28889 "$action_log" >/dev/null 2>&1 &
  ACTION_PID=$!
  local i
  for i in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:28889/crumbIssuer/api/json" && break
    sleep 0.1
  done

  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/action-shell.qml" >"$TOKEN_DIR/action.log" 2>&1 || true
  kill "$ACTION_PID" 2>/dev/null || true
  ACTION_PID=""

  echo "--- action phase:" >&2
  cat "$TOKEN_DIR/action.log" >&2
  echo "--- action server log:" >&2
  cat "$action_log" >&2

  local a
  a=$(grep -o 'JH-E2E-A {.*}' "$TOKEN_DIR/action.log" | tail -n1 || true)
  if [ -z "$a" ]; then
    echo "FAIL: action phase — no dump"
    FAILED=1
    rm -f "$action_srv" "$action_log"
    return
  fi
  if ! printf '%s' "${a#JH-E2E-A }" | jq -e '.actionMessage == "action sent"' >/dev/null 2>&1; then
    echo "FAIL: action phase — feedback not persisted: $a"
    FAILED=1
    rm -f "$action_srv" "$action_log"
    return
  fi
  if ! grep -q "POST /quietDown" "$action_log" || ! grep -q "crumb: action-crumb-1" "$action_log"; then
    echo "FAIL: action phase — POST/crumb not received (see stderr)"
    FAILED=1
    rm -f "$action_srv" "$action_log"
    return
  fi
  rm -f "$action_srv" "$action_log"
  echo "PASS: safe actions (crumb + POST /quietDown + persisted feedback)"
}

# ---- phase 7: widget lifecycle -----------------------------------------------
# Registry across the full lifecycle: static registration, dynamic creation
# (multi-monitor analog), relay to all widgets, unregister on destruction.

run_lifecycle_phase() {
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/lifecycle-shell.qml" >"$TOKEN_DIR/lifecycle.log" 2>&1 || true
  kill "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=""

  echo "--- lifecycle phase:" >&2
  cat "$TOKEN_DIR/lifecycle.log" >&2

  local l1 l2 l3
  l1=$(grep -o 'JH-E2E-L1 {.*}' "$TOKEN_DIR/lifecycle.log" | tail -n1 || true)
  l2=$(grep -o 'JH-E2E-L2 {.*}' "$TOKEN_DIR/lifecycle.log" | tail -n1 || true)
  l3=$(grep -o 'JH-E2E-L3 {.*}' "$TOKEN_DIR/lifecycle.log" | tail -n1 || true)

  if [ -z "$l1" ] || [ -z "$l2" ] || [ -z "$l3" ]; then
    echo "FAIL: lifecycle phase — missing dumps (L1='$l1' L2='$l2' L3='$l3')"
    FAILED=1
    return
  fi
  if printf '%s' "${l1#JH-E2E-L1 }" | jq -e '.registered == 1' >/dev/null 2>&1 \
    && printf '%s' "${l2#JH-E2E-L2 }" | jq -e '(.registered == 2) and (.w1open == true) and (.w2open == true)' >/dev/null 2>&1 \
    && printf '%s' "${l3#JH-E2E-L3 }" | jq -e '(.registered == 1) and (.w1open == true)' >/dev/null 2>&1; then
    echo "PASS: widget lifecycle (static + dynamic registration, relay to both, unregister on destruction)"
  else
    echo "FAIL: lifecycle phase — L1: $l1 L2: $l2 L3: $l3"
    FAILED=1
  fi
}

run_render_phase
run_action_phase
run_lifecycle_phase
if [ "$FAILED" = 1 ]; then
  echo "E2E-FAILED"
  exit 1
fi
echo "E2E-ALL-PASS"
