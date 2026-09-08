#!/usr/bin/env bash
# Benchmark harness entrypoint for the jenkins-health Omarchy plugin.
#
# Measures plugin completeness across four suites (99 checks total):
#   manifest checks  harness/tests/manifest_checks.sh   (19)
#   model tests      harness/tests/model.test.mjs       (70)
#   qmllint gate     harness/tests/qml_lint.sh           (4)
#   integration      harness/tests/integration.sh        (3)
#
# Emits (parsed by autoresearch):
#   METRIC score=<passed>
#   METRIC passed=<passed> failed=<failed> total=<total> qmllint_errors=<N>
#
# Exits 0 unless the harness itself is broken: an incomplete plugin scores
# low, it never fails the run. The only hard failure is infrastructure
# breakage, e.g. `omarchy plugin validate` crashing (rc >= 2) instead of
# reporting an invalid plugin (rc 1).

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/mise/installs/node/26.7.0/bin:$PATH"
fi

TMP=$(mktemp -d)

# --- 1. built-in validator gate (infrastructure check, not a scored check)

validate_rc=0
omarchy plugin validate ./ >/dev/null 2>&1 || validate_rc=$?
if [ "$validate_rc" -ge 2 ]; then
  echo "harness error: omarchy plugin validate crashed (rc=$validate_rc)" >&2
  omarchy plugin validate ./ >&2 || true
  exit 1
fi
if [ "$validate_rc" -eq 1 ]; then
  echo "note: omarchy plugin validate reports an incomplete or invalid plugin (score reflects it):"
  omarchy plugin validate ./ 2>&1 | sed 's/^/      /' || true
fi

# --- 2. manifest checks

echo "== manifest checks =="
bash harness/tests/manifest_checks.sh >"$TMP/manifest.out" 2>&1 || true
cat "$TMP/manifest.out"
manifest_passed=$(grep -oE 'manifest_passed=[0-9]+' "$TMP/manifest.out" | tail -n1 | cut -d= -f2 || true)
manifest_failed=$(grep -oE 'manifest_failed=[0-9]+' "$TMP/manifest.out" | tail -n1 | cut -d= -f2 || true)
: "${manifest_passed:=0}"
: "${manifest_failed:=19}"

# --- 3. Model.js contract tests

echo "== model tests =="
node harness/tests/model.test.mjs >"$TMP/model.out" 2>&1 || true
cat "$TMP/model.out"
model_passed=$(grep -oE 'model_passed=[0-9]+' "$TMP/model.out" | tail -n1 | cut -d= -f2 || true)
model_failed=$(grep -oE 'model_failed=[0-9]+' "$TMP/model.out" | tail -n1 | cut -d= -f2 || true)
: "${model_passed:=0}"
: "${model_failed:=70}"

# --- 4. QML lint gate

echo "== qml lint =="
bash harness/tests/qml_lint.sh >"$TMP/qml.out" 2>&1 || true
cat "$TMP/qml.out"
qml_lint_passed=$(grep -oE 'qml_lint_passed=[0-9]+' "$TMP/qml.out" | tail -n1 | cut -d= -f2 || true)
qml_lint_failed=$(grep -oE 'qml_lint_failed=[0-9]+' "$TMP/qml.out" | tail -n1 | cut -d= -f2 || true)
qml_lint_errors=$(grep -oE 'qml_lint_errors=[0-9]+' "$TMP/qml.out" | tail -n1 | cut -d= -f2 || true)
: "${qml_lint_passed:=0}"
: "${qml_lint_failed:=4}"
: "${qml_lint_errors:=0}"

# --- 5. integration tests

echo "== integration =="
bash harness/tests/integration.sh >"$TMP/integration.out" 2>&1 || true
cat "$TMP/integration.out"
integration_passed=$(grep -oE 'integration_passed=[0-9]+' "$TMP/integration.out" | tail -n1 | cut -d= -f2 || true)
integration_failed=$(grep -oE 'integration_failed=[0-9]+' "$TMP/integration.out" | tail -n1 | cut -d= -f2 || true)
: "${integration_passed:=0}"
: "${integration_failed:=3}"

# --- aggregate

total_passed=$((manifest_passed + model_passed + qml_lint_passed + integration_passed))
total_failed=$((manifest_failed + model_failed + qml_lint_failed + integration_failed))
total_checks=99

echo
echo "Jenkins Health harness: $total_passed/$total_checks checks passed"
echo "  manifest:    $manifest_passed/22"
echo "  model:       $model_passed/70"
echo "  qml lint:    $qml_lint_passed/4 ($qml_lint_errors lint errors)"
echo "  integration: $integration_passed/3"
echo "METRIC score=$total_passed"
echo "METRIC passed=$total_passed failed=$total_failed total=$total_checks qmllint_errors=$qml_lint_errors"
exit 0
