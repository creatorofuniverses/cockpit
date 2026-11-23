#!/bin/sh
# A stand-in for ci-runners in the sandbox, answering from the runners crate's fixtures:
#   CI_RUNNERS_BIN=$PWD/scripts/fake-ci-runners.sh COCKPIT_SANDBOX=/tmp/cc-r sh scripts/sandbox.sh start
# CI_RUNNERS_FAKE=stale serves the fixture with a stale tick; CI_RUNNERS_FAKE=fail makes every autoscale command
# fail with "control.lock busy"; anything else serves the live one. The autoscale commands keep the pause and the
# server cap in a state file that the status answer reads back.
here=$(cd "$(dirname "$0")" && pwd)
fixtures="$here/../herdr/tui/runners/tests/fixtures"
state="${TMPDIR:-/tmp}/fake-ci-runners.$(id -u)"
case "$CI_RUNNERS_FAKE" in
  stale) status="$fixtures/status-stale.json" ;;
  *) status="$fixtures/status-live.json" ;;
esac
# Sets one key of the state file, keeping the others.
put() {
  { grep -v "^$1=" "$state" 2>/dev/null; echo "$1=$2"; } >"$state.new"
  mv "$state.new" "$state"
}
get() { sed -n "s/^$1=//p" "$state" 2>/dev/null; }
case "$1" in
  autoscale)
    if [ "$CI_RUNNERS_FAKE" = fail ]; then
      echo "control.lock busy" >&2
      exit 1
    fi
    case "$*" in
      "autoscale pause --actor cockpit") put paused true ;;
      "autoscale resume --actor cockpit") put paused false ;;
      "autoscale set-max --reset --actor cockpit") put max reset ;;
      "autoscale set-max "*" --actor cockpit")
        case "$3" in
          '' | *[!0-9]*)
            echo "fake-ci-runners: unsupported arguments: $*" >&2
            exit 2
            ;;
        esac
        put max "$3"
        ;;
      *)
        echo "fake-ci-runners: unsupported arguments: $*" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    case "$*" in
      "version --json") cat "$fixtures/version.json" ;;
      "status --json --offline")
        paused=$(get paused)
        max=$(get max)
        [ -n "$paused" ] || paused=false
        if [ "$paused" = true ]; then by='"cockpit"'; else by=null; fi
        if [ -z "$max" ] || [ "$max" = reset ]; then
          sed -e "s/^\( *\"paused\": \).*/\1$paused,/" -e "s/^\( *\"paused_by\": \).*/\1$by,/" "$status"
        else
          sed -e "s/^\( *\"paused\": \).*/\1$paused,/" -e "s/^\( *\"paused_by\": \).*/\1$by,/" \
            -e "s/^\( *\"max_servers\": \).*/\1$max,/" -e "s/^\( *\"max_servers_source\": \).*/\1\"set-max\",/" "$status"
        fi
        ;;
      *)
        echo "fake-ci-runners: unsupported arguments: $*" >&2
        exit 2
        ;;
    esac
    ;;
esac
