#!/bin/sh
# A stand-in for ci-runners in the sandbox, answering from the runners crate's fixtures:
#   CI_RUNNERS_BIN=$PWD/scripts/fake-ci-runners.sh COCKPIT_SANDBOX=/tmp/cc-r sh scripts/sandbox.sh start
# CI_RUNNERS_FAKE=stale serves the fixture with a stale tick; anything else serves the live one.
here=$(cd "$(dirname "$0")" && pwd)
fixtures="$here/../herdr/tui/runners/tests/fixtures"
case "$CI_RUNNERS_FAKE" in
  stale) status="$fixtures/status-stale.json" ;;
  *) status="$fixtures/status-live.json" ;;
esac
case "$*" in
  "version --json") cat "$fixtures/version.json" ;;
  "status --json --offline") cat "$status" ;;
  *)
    echo "fake-ci-runners: unsupported arguments: $*" >&2
    exit 2
    ;;
esac
