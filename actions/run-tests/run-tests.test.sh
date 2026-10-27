#!/usr/bin/env bash
# Self-check for run-tests.sh: bash run-tests.test.sh
T="$(dirname "$0")/run-tests.sh"; fail=0
check() { SUITES="$1" STRICT=$2 bash "$T" >/dev/null 2>&1; got=$?
  [ "$got" = "$3" ] && echo "ok   $4" || { echo "FAIL $4 (exit $got, want $3)"; fail=1; }; }
check '[{"kind":"cargo","command":"echo running 0 tests"}]' true 1 "cargo zero blocks prod"
check '[{"kind":"cargo","command":"echo running 0 tests"}]' false 0 "cargo zero allowed in preprod"
check '[{"kind":"cargo","command":"echo running 0 tests"},{"kind":"fastedge-test","command":"echo 3/3 passed in 9ms"}]' true 0 "fastedge-test covers prod when cargo has none"
check '[{"kind":"cargo","command":"printf \"running 2 tests\\nrunning 0 tests\\n\""}]' true 0 "cargo unit + empty doc-tests passes prod"
check '[{"kind":"fastedge-test","command":"echo 0/0 passed"}]' true 1 "fastedge-test zero blocks prod"
check '[{"kind":"fastedge-test","command":"echo 1/2 passed; exit 1"}]' false 1 "failing suite fails even in preprod"
check '[]' true 1 "no suites blocks prod"
check '[]' false 0 "no suites allowed in preprod"
exit $fail
