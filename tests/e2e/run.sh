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
  kill_wait "$MOCK_PID"
  kill_wait "$ACTION_PID"
  kill_wait "$QS_PID"
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
cp "$ROOT/tests/e2e/auth-shell.qml" "$E2E_DIR/auth-shell.qml"

# Kill a background server and WAIT for it to die. Python's
# ThreadingHTTPServer.server_close() can block on lingering keep-alive
# handler threads, so a bare kill may leave the port held — and a new
# server would then fail to bind while the old one keeps answering.
kill_wait() {
  local pid="$1" i
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 0
}

start_mock() {
  kill_wait "$MOCK_PID"
  MOCK_PID=""
  python3 "$ROOT/harness/mock_jenkins.py" "$1" "$PORT" >/dev/null 2>&1 &
  MOCK_PID=$!

  # Content-aware readiness: a stale server holding the port would answer
  # a liveness probe with the WRONG scenario. Verify the mock actually
  # serves the requested fixture.
  local want="$1" i depth code
  for i in $(seq 1 40); do
    case "$want" in
      outage)
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
          "http://127.0.0.1:$PORT/api/json" 2>/dev/null || true)
        [ "$code" = "502" ] && return 0
        ;;
      *)
        depth=$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/queue/api/json" 2>/dev/null \
          | jq -r '.items | length' 2>/dev/null || true)
        if [ "$want" = "healthy" ] && [ "$depth" = "2" ]; then return 0; fi
        if [ "$want" = "degraded" ] && [ "$depth" = "12" ]; then return 0; fi
        ;;
    esac
    sleep 0.1
  done
  echo "mock failed to start or serves the wrong content (scenario: $want, queue depth: ${depth:-n/a}, code: ${code:-n/a})" >&2
  exit 1
}

# ---- phase 1: scenario dumps ----------------------------------------------

run_scenario() {
  local scenario="$1" expect="$2"
  start_mock "$scenario"

  local log
  log=$(mktemp)
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" timeout 20 qs -p "$E2E_DIR" >"$log" 2>&1 || true
  kill_wait "$MOCK_PID"
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
# ---- phase 2b: recovery + controller transitions -----------------------------
# Completes the live notification matrix: recovery events (node-online,
# job-recovered, queue-clear) and controller transitions (down, up) —
# previously verified only in unit tests. Polls are driven EXPLICITLY via
# the refresh IPC after each mock switch, so no poll can land inside a
# switch window. Expected: exactly 5 notifications — 3 recovery (info),
# controller-down (critical), controller-up (info).

run_recovery_phase() {
  local shim_dir notify_log
  shim_dir=$(mktemp -d)
  mkdir -p "$shim_dir/bin"
  cat > "$shim_dir/bin/omarchy-notification-send" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$JH_NOTIFY_LOG"
EOF
  chmod +x "$shim_dir/bin/omarchy-notification-send"
  notify_log="$shim_dir/notifications.log"
  : > "$notify_log"

  start_mock degraded
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    JH_NOTIFY_LOG="$notify_log" \
    JH_E2E_NOTIFY=1 JH_E2E_SHIM_DIR="$shim_dir" \
    JH_E2E_REFRESH=30 JH_E2E_QUIT_MS=30000 \
    qs -p "$E2E_DIR" >"$shim_dir/qs.log" 2>&1 &
  QS_PID=$!
  sleep 2.5   # first poll (~1.5s) takes the degraded baseline (no events)

  local refresh_out
  start_mock healthy
  sleep 0.5
  refresh_out=$(qs ipc --pid "$QS_PID" call jenkins-health refresh 2>&1 || true)
  sleep 2     # reauth + poll + 3 recovery events

  start_mock outage
  sleep 0.5
  refresh_out=$(qs ipc --pid "$QS_PID" call jenkins-health refresh 2>&1 || true)
  sleep 2     # controller-down

  start_mock healthy
  sleep 0.5
  refresh_out=$(qs ipc --pid "$QS_PID" call jenkins-health refresh 2>&1 || true)
  sleep 2     # controller-up

  kill_wait "$QS_PID"
  wait "$QS_PID" 2>/dev/null || true
  QS_PID=""
  kill_wait "$MOCK_PID"
  MOCK_PID=""

  echo "--- recovery phase notifications:" >&2
  cat "$notify_log" >&2
  # (cleanup happens in the assertions' wake via the EXIT trap: SHIM_DIR)
  SHIM_DIR="$shim_dir"

  local count
  count=$(wc -l < "$notify_log")
  if [ "$count" -ne 5 ]; then
    echo "FAIL: recovery phase — expected 5 notifications, got $count (see stderr)"
    FAILED=1
    return
  fi
  local want
  for want in "Jenkins node online" "Jenkins jobs recovered" "Jenkins queue clear" "Jenkins controller down" "Jenkins controller is back up"; do
    if [ "$(grep -c "$want" "$notify_log")" != "1" ]; then
      echo "FAIL: recovery phase — '$want' not present exactly once (see stderr)"
      FAILED=1
      return
    fi
  done
  if [ "$(grep -c 'controller down.*-u critical\|-u critical.*controller down' "$notify_log")" != "1" ]; then
    echo "FAIL: recovery phase — controller-down is not critical urgency (see stderr)"
    FAILED=1
    return
  fi
  echo "PASS: recovery + controller transitions (node-online, job-recovered, queue-clear, controller-down critical, controller-up)"
}

# ---- phase 3: IPC surface ---------------------------------------------------

run_ipc_phase() {
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" JH_E2E_QUIT_MS=30000 \
    qs -p "$E2E_DIR" >"$TOKEN_DIR/ipc.log" 2>&1 &
  QS_PID=$!
  sleep 2

  local status refresh open close toggle
  status=$(qs ipc --pid "$QS_PID" call jenkins-health status 2>&1 || true)
  refresh=$(qs ipc --pid "$QS_PID" call jenkins-health refresh 2>&1 || true)
  open=$(qs ipc --pid "$QS_PID" call jenkins-health open 2>&1 || true)
  close=$(qs ipc --pid "$QS_PID" call jenkins-health close 2>&1 || true)
  toggle=$(qs ipc --pid "$QS_PID" call jenkins-health toggle 2>&1 || true)
  kill_wait "$QS_PID"
  wait "$QS_PID" 2>/dev/null || true
  QS_PID=""
  kill_wait "$MOCK_PID"
  MOCK_PID=""

  printf 'status:  %s\nrefresh: %s\nopen:    %s\nclose:   %s\ntoggle:  %s\n' "$status" "$refresh" "$open" "$close" "$toggle" >&2

  if ! printf '%s' "$status" | jq -e '(.state == "ok") and (.score == 100) and (.version == "2.440.3")' >/dev/null 2>&1; then
    echo "FAIL: IPC status — got: $status"
    FAILED=1
    return
  fi
  if [ "$refresh" = "ok" ] && [ "$open" = "ok" ] && [ "$close" = "ok" ] && [ "$toggle" = "ok" ]; then
    echo "PASS: IPC surface (status JSON, refresh, open, close, toggle)"
  else
    echo "FAIL: IPC — refresh='$refresh' open='$open' close='$close' toggle='$toggle'"
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
  kill_wait "$MOCK_PID"
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
run_recovery_phase
run_ipc_phase
run_widget_phase

# ---- phase 5: visual render --------------------------------------------------
# Draws the chip and panel content in a layer-shell window and captures
# exactly that surface (namespace jh-e2e-render) with grim — the user's
# desktop is never included. The automated assertions are structural
# (surface found, non-blank capture); the visual verdict comes from
# inspecting the saved capture.

run_render_phase() {
  local scenario="$1" out_png="$2"
  if ! command -v grim >/dev/null 2>&1; then
    echo "SKIP: render phase (grim not found)"
    return
  fi
  start_mock "$scenario"
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/render-shell.qml" >"$TOKEN_DIR/render.log" 2>&1 &
  QS_PID=$!
  sleep 4

  local geo
  geo=$(hyprctl layers -j | jq -r \
    '[.[] | .levels | to_entries[] | .value[]? | select(.namespace == "jh-e2e-render")]
     | .[0] | "\(.x),\(.y) \(.w)x\(.h)"' 2>/dev/null || true)
  if [ -n "$geo" ] && [ "$geo" != "null" ]; then
    grim -g "$geo" "$out_png" 2>>"$TOKEN_DIR/render.log" || true
  fi
  kill_wait "$QS_PID"
  wait "$QS_PID" 2>/dev/null || true
  QS_PID=""
  kill_wait "$MOCK_PID"
  MOCK_PID=""

  echo "--- render phase $scenario (geo='$geo'):" >&2
  cat "$TOKEN_DIR/render.log" >&2

  if [ ! -s "$out_png" ]; then
    echo "FAIL: render phase $scenario — no capture (surface not found or grim failed)"
    FAILED=1
    return
  fi
  local size
  size=$(stat -c %s "$out_png")
  if [ "$size" -lt 20000 ]; then
    echo "FAIL: render phase $scenario — capture looks blank (${size}B)"
    FAILED=1
    return
  fi
  # Semantics guard: the service inside the render instance must report
  # the scenario's state — PNG sizes alone can differ on noise (the v16
  # stray-mock incident produced three healthy renders that passed a
  # size-based differ).
  local want_state
  case "$scenario" in
    healthy) want_state="ok" ;;
    degraded) want_state="warn" ;;
    outage) want_state="critical" ;;
  esac
  if ! grep -q "JH-E2E-R {.*\"state\":\"$want_state\"" "$TOKEN_DIR/render.log"; then
    echo "FAIL: render phase $scenario — service state is not $want_state (see stderr)"
    FAILED=1
    return
  fi
  cp "$out_png" "/tmp/jenkins-health-render-$scenario.png"
  echo "PASS: render phase $scenario (state $want_state, ${size}B, saved /tmp/jenkins-health-render-$scenario.png)"
}

run_render_both_phases() {
  if ! command -v grim >/dev/null 2>&1; then
    echo "SKIP: render phases (grim not found)"
    return
  fi
  run_render_phase healthy "$TOKEN_DIR/render-healthy.png"
  run_render_phase degraded "$TOKEN_DIR/render-degraded.png"
  run_render_phase outage "$TOKEN_DIR/render-outage.png"
  if [ "$FAILED" = 1 ]; then
    return
  fi
  local a b
  for a in healthy degraded outage; do
    for b in healthy degraded outage; do
      if [ "$a" \< "$b" ] && cmp -s "$TOKEN_DIR/render-$a.png" "$TOKEN_DIR/render-$b.png"; then
        echo "FAIL: render phases — $a and $b captures are identical"
        FAILED=1
        return
      fi
    done
  done
  echo "PASS: render phases differ across all three states (level-dependent rendering confirmed)"
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
            f.write("POST %s\n" % self.path)
            f.write("crumb: %s\n" % self.headers.get("Jenkins-Crumb", ""))
        # cancelQuietDown is rejected — exercising the action-FAILURE
        # feedback path (curl -f exits 22 on the 500).
        if self.path == "/cancelQuietDown":
            self._reply(500, b'{}')
        else:
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
  kill_wait "$ACTION_PID"
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
  if ! printf '%s' "${a#JH-E2E-A }" | jq -e '.actionMessage == "action failed (exit 22)"' >/dev/null 2>&1; then
    echo "FAIL: action phase — failure feedback missing: $a"
    FAILED=1
    rm -f "$action_srv" "$action_log"
    return
  fi
  local posts crumbs
  posts=$(grep -c "^POST " "$action_log" || true)
  crumbs=$(grep -c "crumb: action-crumb-1" "$action_log" || true)
  if [ "$posts" -ne 4 ] || [ "$crumbs" -ne 4 ]; then
    echo "FAIL: action phase — expected 4 POSTs with crumbs, got $posts/$crumbs (see stderr)"
    FAILED=1
    rm -f "$action_srv" "$action_log"
    return
  fi
  for want in "POST /quietDown" "POST /queue/cancelItem?id=207" "POST /computer/build-agent-03/doChangeOffline" "POST /cancelQuietDown"; do
    if ! grep -qF "$want" "$action_log"; then
      echo "FAIL: action phase — missing '$want' (see stderr)"
      FAILED=1
      rm -f "$action_srv" "$action_log"
      return
    fi
  done
  rm -f "$action_srv" "$action_log"
  echo "PASS: safe actions (3 shapes succeed with crumbs, failure feedback on 500)"
}

# ---- phase 7: widget lifecycle -----------------------------------------------
# Registry across the full lifecycle: static registration, dynamic creation
# (multi-monitor analog), relay to all widgets, unregister on destruction.

run_lifecycle_phase() {
  start_mock healthy
  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" \
    qs -p "$E2E_DIR/lifecycle-shell.qml" >"$TOKEN_DIR/lifecycle.log" 2>&1 || true
  kill_wait "$MOCK_PID"
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

# ---- phase 7b: crumb-less actions --------------------------------------------
# Old Jenkins can disable the crumb issuer: the crumb fetch fails (404),
# the action POST must still fire — gracefully, without a crumb header.

run_crumbless_phase() {
  local srv log
  srv=$(mktemp)
  log=$(mktemp)
  cat > "$srv" <<'PYEOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

log = sys.argv[2]


class H(BaseHTTPRequestHandler):
    def _reply(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # crumb issuer disabled, like old Jenkins configurations
        self._reply(404, b'{}')

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        if n:
            self.rfile.read(n)
        with open(log, "a") as f:
            f.write("POST %s\n" % self.path)
            f.write("crumb: %s\n" % self.headers.get("Jenkins-Crumb", ""))
        self._reply(200, b'{}')

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYEOF
  python3 "$srv" 28889 "$log" >/dev/null 2>&1 &
  ACTION_PID=$!
  local i
  for i in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:28889/anything" && break
    sleep 0.1
  done

  JH_E2E_TOKEN_FILE="$TOKEN_DIR/token" JH_E2E_ACTIONS="quietDown" \
    qs -p "$E2E_DIR/action-shell.qml" >"$TOKEN_DIR/crumbless.log" 2>&1 || true
  kill_wait "$ACTION_PID"
  ACTION_PID=""

  echo "--- crumb-less phase:" >&2
  cat "$TOKEN_DIR/crumbless.log" >&2
  echo "--- crumb-less server log:" >&2
  cat "$log" >&2

  local a
  a=$(grep -o 'JH-E2E-A {.*}' "$TOKEN_DIR/crumbless.log" | tail -n1 || true)
  if [ -z "$a" ] || ! printf '%s' "${a#JH-E2E-A }" | jq -e '.actionMessage == "action sent"' >/dev/null 2>&1; then
    echo "FAIL: crumb-less phase — action did not succeed: $a"
    FAILED=1
    rm -f "$srv" "$log"
    return
  fi
  if ! grep -q '^POST /quietDown$' "$log"; then
    echo "FAIL: crumb-less phase — POST not received (see stderr)"
    FAILED=1
    rm -f "$srv" "$log"
    return
  fi
  if grep -q "crumb: .\+" "$log"; then
    echo "FAIL: crumb-less phase — a crumb header was sent despite the 404 issuer (see stderr)"
    FAILED=1
    rm -f "$srv" "$log"
    return
  fi
  rm -f "$srv" "$log"
  echo "PASS: crumb-less action (crumb fetch 404 → POST without crumb header, action succeeds)"
}
# ---- phase 8: auth failures ---------------------------------------------------
# Proves the failure-classification branches execute in the LIVE service:
# 401/403 → noauth with a credentials message, 3xx → unconfigured with a
# URL-scheme hint, and a missing token file → noauth via the netrc path.
# Inline servers (never the frozen mock) on port 28890.

run_auth_case() {
  # $1 = label, $2 = expected state, $3 = jq expression over the dump,
  # $4 = server status to serve on /api/json ("" = no server)
  local label="$1" expect_state="$2" expect_jq="$3" status="$4"
  local srv="" pid=""
  if [ -n "$status" ]; then
    srv=$(mktemp)
    cat > "$srv" <<PYEOF
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

status = int(sys.argv[2])


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        # Real Jenkins redirects serve an HTML page, not JSON — a JSON
        # body would parse as a valid (empty) controller and the service
        # would report healthy instead of classifying the redirect.
        body = b'<html><head>302 Found</head></html>' if status in (301, 302, 307, 308) else b'{}'
        self.send_response(status)
        if status in (301, 302, 307, 308):
            self.send_header("Location", "https://ci.example.com/jenkins")
        self.send_header("X-Jenkins", "2.440.3")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYEOF
    python3 "$srv" 28890 "$status" >/dev/null 2>&1 &
    pid=$!
    local i
    for i in $(seq 1 30); do
      curl -s -o /dev/null "http://127.0.0.1:28890/api/json" && break
      sleep 0.1
    done
  fi

  local token_arg="$TOKEN_DIR/token"
  if [ "$label" = "missing-token" ]; then
    token_arg="$TOKEN_DIR/does-not-exist"
  fi

  JH_E2E_TOKEN_FILE="$token_arg" \
    qs -p "$E2E_DIR/auth-shell.qml" >"$TOKEN_DIR/auth-$label.log" 2>&1 || true
  kill_wait "$pid"
  [ -n "$srv" ] && rm -f "$srv"

  echo "--- auth case $label:" >&2
  cat "$TOKEN_DIR/auth-$label.log" >&2

  local x
  x=$(grep -o 'JH-E2E-X {.*}' "$TOKEN_DIR/auth-$label.log" | tail -n1 || true)
  if [ -z "$x" ]; then
    echo "FAIL: auth $label — no dump"
    FAILED=1
    return
  fi
  if printf '%s' "${x#JH-E2E-X }" | jq -e "(.state == \"$expect_state\") and ($expect_jq)" >/dev/null 2>&1; then
    echo "PASS: auth $label → $expect_state"
  else
    echo "FAIL: auth $label — expected $expect_state: $x"
    FAILED=1
  fi
}

run_auth_phase() {
  run_auth_case reject-403 noauth '(.statusMessage | contains("HTTP 403"))' 403
  run_auth_case reject-401 noauth '(.statusMessage | contains("HTTP 401"))' 401
  run_auth_case redirect-302 unconfigured '(.statusMessage | contains("redirected"))' 302
  run_auth_case missing-token noauth '(.statusMessage | contains("token"))' ""
}

run_render_both_phases
run_action_phase
run_crumbless_phase
run_lifecycle_phase
run_auth_phase

if [ "$FAILED" = 1 ]; then
  echo "E2E-FAILED"
  exit 1
fi
echo "E2E-ALL-PASS"
