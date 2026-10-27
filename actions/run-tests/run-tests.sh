#!/usr/bin/env bash
# Runs every detected test suite (resolve-config `tests`) and enforces H4a / T20:
# a failing suite always fails; prod also needs at least one suite that ran > 0
# tests. Zero-test detection: cargo ("running N tests"), fastedge-test
# ("N/M passed"); npm / custom suites are trusted if they exit 0.
#
# Env: SUITES (JSON array of {kind, command}), STRICT (true = prod rules).
set -uo pipefail

count=$(jq length <<<"$SUITES")
ran_tests=0

for i in $(seq 0 $((count - 1))); do
  kind=$(jq -r ".[$i].kind" <<<"$SUITES")
  command=$(jq -r ".[$i].command" <<<"$SUITES")
  echo "::group::Test suite: $kind"
  log=$(mktemp)
  bash -c "$command" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    echo "::error::Test suite '$kind' failed (exit $status)"
    exit 1
  fi

  case "$kind" in
    cargo)
      n=$(grep -oE '^running [0-9]+ tests?$' "$log" | awk '{s += $2} END {print s + 0}') ;;
    fastedge-test)
      n=$(grep -oE '[0-9]+/[0-9]+ passed' "$log" | tail -1 | cut -d/ -f2 | cut -d' ' -f1)
      n=${n:-unknown} ;;
    *) n=unknown ;;
  esac
  echo "Suite '$kind': $n test(s)"
  if [ "$n" = 0 ]; then
    echo "::warning::Test suite '$kind' ran zero tests"
  else
    ran_tests=1
  fi
done

if [ "$ran_tests" -eq 0 ]; then
  if [ "${STRICT:-false}" = true ]; then
    echo "::error::No test suite ran any tests — prod requires one (H4a, T20)"
    exit 1
  fi
  echo "::warning::No test suite ran any tests — allowed for preprod only (H4a)"
fi
