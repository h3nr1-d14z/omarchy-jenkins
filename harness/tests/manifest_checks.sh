#!/usr/bin/env bash
# Marketplace-specific manifest checks for the jenkins-health plugin.
#
# Complements `omarchy plugin validate ./` (which owns the shell contract:
# schemaVersion, required fields, entry points, kind<->entryPoint table,
# symlinks, reserved IDs). This script checks requirements the binary does
# not cover: exact plugin id, kind pair, keepLoaded, bar-widget settings
# schema, defaults consistency, the marketplace's community field-length
# limits (which the binary and the gate's own error message disagree on),
# README install/remove docs, LICENSE, and a secret scan.
#
# Always exits 0: failures lower the plugin score, they never break the
# harness. Prints one PASS/FAIL line per check and a final
# "manifest_passed=N manifest_failed=N" summary (22 checks).

cd "$(dirname "$0")/../.." || exit 0

passed=0
failed=0

ok() { echo "PASS: $1"; passed=$((passed + 1)); }
no() { echo "FAIL: $1"; failed=$((failed + 1)); }

# check <description> <command...>  — command exit 0 => PASS
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else no "$desc"; fi
}

manifest_core() {
  [ -f manifest.json ] || return 1
  jq -e 'type == "object"' manifest.json >/dev/null 2>&1 || return 1
  omarchy plugin validate ./ >/dev/null 2>&1
}

kinds_ok() {
  jq -e '(.kinds // []) | any(. == "service") and any(. == "bar-widget")' manifest.json
}

people_ok() {
  jq -e '((.author // "") | (type == "string" and length > 0))
      and ((.description // "") | (type == "string" and length > 0))
      and ((.license // "") | (type == "string" and length > 0))' manifest.json
}

widget_meta_ok() {
  jq -e '((.barWidget.displayName // "") | (type == "string" and length > 0))
      and ((.barWidget.category // "") | (type == "string" and length > 0))' manifest.json
}

schema_is_array() {
  jq -e '(.barWidget.schema // []) | type == "array"' manifest.json
}

# setting <key> <type> [bounded]
#   bounded (integers): requires min, max, and defaultValue
#   otherwise: requires defaultValue (integer) or nothing extra (string)
setting_ok() {
  local key="$1" type="$2" bounded="$3" extra=""
  if [ "$type" = "integer" ] && [ "$bounded" = "bounded" ]; then
    extra=' and .[0].min != null and .[0].max != null and .[0].defaultValue != null'
  elif [ "$type" = "integer" ]; then
    extra=' and .[0].defaultValue != null'
  fi
  jq -e "[.barWidget.schema[]? | select(.key == \"$key\")]
      | (length == 1 and .[0].type == \"$type\"$extra)" manifest.json
}

defaults_match() {
  jq -e '(.barWidget.defaults != null)
      and ([.barWidget.schema[]? | select(.key == "tokenFile")] | length == 1)
      and ([.barWidget.schema[]? | select(.key == "refreshIntervalSec")] | length == 1)
      and ([.barWidget.schema[]? | select(.key == "queueBacklogThreshold")] | length == 1)
      and ([.barWidget.schema[]? | select(.key == "tokenFile")][0].defaultValue
              == .barWidget.defaults.tokenFile)
      and ([.barWidget.schema[]? | select(.key == "refreshIntervalSec")][0].defaultValue
              == .barWidget.defaults.refreshIntervalSec)
      and ([.barWidget.schema[]? | select(.key == "queueBacklogThreshold")][0].defaultValue
              == .barWidget.defaults.queueBacklogThreshold)' manifest.json
}

# Marketplace community-manifest field limits (manifestFieldLimits in
# omacom/omarchy-plugin-marketplace scripts/build-catalog.mjs
# validateManifest): the gate rejects longer fields with a needs-fixes
# label, and `omarchy plugin validate` is blind to these — v0.5.0's
# 622-char description shipped through every local gate and cost a
# failed marketplace validation before this guard existed.
field_limits_ok() {
  jq -e '((.id | length) <= 128) and ((.name | length) <= 120)
      and ((.version | length) <= 64) and ((.author | length) <= 120)
      and ((.description | length) <= 500) and ((.license | length) <= 120)' manifest.json
}

readme_ok() {
  [ -f README.md ] || return 1
  grep -qi 'install' README.md && grep -qi 'remove' README.md
}

license_ok() {
  [ -f LICENSE ]
}

no_secrets() {
  [ -f manifest.json ] || return 1
  if grep -qE 'sqa_|sqp_|[0-9a-fA-F]{40}' manifest.json; then return 1; fi
  local f
  for f in *.qml; do
    [ -f "$f" ] || continue
    if grep -qE 'sqa_|sqp_|[0-9a-fA-F]{40}' "$f"; then return 1; fi
  done
  return 0
}

check "manifest.json exists, parses, and passes omarchy plugin validate" manifest_core
check "id is exactly h3nr1.d14z.jenkins" \
  jq -e '.id == "h3nr1.d14z.jenkins"' manifest.json
check "kinds includes service and bar-widget" kinds_ok
check "keepLoaded is true" jq -e '.keepLoaded == true' manifest.json
check "author, description, and license are non-empty strings" people_ok
check "barWidget displayName and category are non-empty" widget_meta_ok
check "barWidget schema is an array" schema_is_array
check "schema setting jenkinsUrl (string)" setting_ok jenkinsUrl string
check "schema setting jenkinsUser (string)" setting_ok jenkinsUser string
check "schema setting tokenFile (string)" setting_ok tokenFile string
check "schema setting refreshIntervalSec (integer with min/max/defaultValue)" \
  setting_ok refreshIntervalSec integer bounded
check "schema setting queueBacklogThreshold (integer with min/max/defaultValue)" \
  setting_ok queueBacklogThreshold integer bounded
check "schema setting diskWarnGb (integer with defaultValue)" setting_ok diskWarnGb integer
check "schema setting diskCriticalGb (integer with defaultValue)" setting_ok diskCriticalGb integer
check "schema setting diskWarnPct (integer with min/max/defaultValue)" \
  setting_ok diskWarnPct integer bounded
check "schema setting diskCriticalPct (integer with min/max/defaultValue)" \
  setting_ok diskCriticalPct integer bounded
check "manifest fields within marketplace limits (id 128, name 120, version 64, author 120, description 500, license 120)" \
  field_limits_ok
check "schema setting responseTimeWarnMs (integer with defaultValue)" \
  setting_ok responseTimeWarnMs integer
check "barWidget defaults match schema (tokenFile, refreshIntervalSec, queueBacklogThreshold)" \
  defaults_match
check "README.md documents Install and Remove" readme_ok
check "LICENSE exists" license_ok
check "no hardcoded tokens in manifest.json or QML sources" no_secrets

echo "manifest_passed=$passed manifest_failed=$failed"
exit 0
