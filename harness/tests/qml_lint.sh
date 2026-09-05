#!/usr/bin/env bash
# QML lint gate for the jenkins-health plugin.
#
# Lints each plugin QML file with Qt's qmllint, with the Omarchy shell tree
# available under the "qs." import namespace (symlinked into a temp import
# path). A file passes when qmllint exits 0, emits no "Error:" lines, and
# has no unresolved-import diagnostics, and has no missing-property warning
# on a concrete type (a property typo). Warning categories that are
# tolerated in the Omarchy codebase (missing-property on QObject — the
# Loader-injected idiom — unqualified access, unused imports) do not fail
# the gate. Model.js is not linted (it is plain JavaScript, not QML); its
# check is file existence.
#
# Always exits 0: failures lower the score, they never break the harness.
# Prints one PASS/FAIL line per file and a final
# "qml_lint_passed=N qml_lint_failed=N qml_lint_errors=N" summary.

cd "$(dirname "$0")/../.." || exit 0

passed=0
failed=0
errors=0

QMLLINT=/usr/lib/qt6/bin/qmllint
if [ ! -x "$QMLLINT" ]; then
  if command -v qmllint >/dev/null 2>&1; then
    QMLLINT=$(command -v qmllint)
  else
    echo "WARN: qmllint not found (looked at /usr/lib/qt6/bin/qmllint and PATH)"
    echo "qml_lint_passed=0 qml_lint_failed=4 qml_lint_errors=0"
    exit 0
  fi
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ln -s /usr/share/omarchy/shell "$TMP/qs"

lint_one() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "FAIL: $f (missing)"
    failed=$((failed + 1))
    return
  fi
  local out rc errcount unresolved badprops
  out=$("$QMLLINT" -I "$TMP" "$f" 2>&1)
  rc=$?
  errcount=$(printf '%s\n' "$out" | grep -cE 'Error:')
  [ "$rc" -ne 0 ] && errcount=$((errcount + 1))  # syntax failures exit non-zero
  unresolved=$(printf '%s\n' "$out" | grep -icE 'failed to import|unresolved.*import|\[import\]')
  # missing-property warnings are tolerated only on type "QObject" (the
  # singleton/Loader idiom); on a concrete type they are property typos.
  badprops=$(printf '%s\n' "$out" | grep -E '\[missing-property\]' | grep -vcE 'on type "QObject"')

  if [ "$rc" -eq 0 ] && [ "$errcount" -eq 0 ] && [ "$unresolved" -eq 0 ] && [ "$badprops" -eq 0 ]; then
    echo "PASS: $f"
    passed=$((passed + 1))
  else
    echo "FAIL: $f (exit $rc, $errcount errors, $unresolved unresolved imports, $badprops bad property references)"
    failed=$((failed + 1))
    errors=$((errors + errcount + unresolved + badprops))
  fi
}

lint_one Service.qml
lint_one BarWidget.qml
lint_one Panel.qml

if [ -f Model.js ]; then
  echo "PASS: Model.js (present, not linted)"
  passed=$((passed + 1))
else
  echo "FAIL: Model.js (missing)"
  failed=$((failed + 1))
fi

echo "qml_lint_passed=$passed qml_lint_failed=$failed qml_lint_errors=$errors"
exit 0
