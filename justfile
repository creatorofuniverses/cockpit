# Fork-only recipes for running the `desk` branch of the cockpit fork: upstream main plus the fork's feature branches.
# This file lives on its own branch that is merged into desk and never sent upstream.
#
#   just desk-mac      on the desktop: update the checkout to desk and install its Herdr app mod, keeping a remote desk
#   just desk-server   on the server: build desk, install it into both cockpit binaries and restart the hub
#   just desk          on the server: rebuild the desk branch with cockpit-desk, then desk-server

set shell := ["bash", "-euo", "pipefail", "-c"]

fork := env("COCKPIT_FORK", "creatorofuniverses/cockpit")
app_config := env("HOME") / ".config/herdr-app/cockpit.json"

# Show the recipes.
default:
    @just --list

# The git remote that points at the fork.
[private]
fork-remote:
    #!/usr/bin/env bash
    set -euo pipefail
    remote=$(git remote -v | awk -v f="{{ fork }}" 'index($2, f) && $3 == "(fetch)" { print $1; exit }')
    [ -n "$remote" ] || { echo "no git remote points at {{ fork }}" >&2; exit 1; }
    echo "$remote"

# Desktop: reset this checkout to the fork's desk and install its mod, keeping a remote-desk cockpit.json.
desk-mac:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{ justfile_directory() }}"
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      echo "the checkout has local changes; desk-mac resets it to desk, so commit or stash them first" >&2
      git status --short --untracked-files=no >&2
      exit 1
    fi
    remote=$(just fork-remote)
    git fetch -q "$remote" desk
    git checkout -q -B desk "$remote/desk"
    echo "desk at $(git log --oneline -1)"
    saved=""
    if [ -f "{{ app_config }}" ] && grep -q '"machine"' "{{ app_config }}"; then
      saved=$(mktemp)
      cp "{{ app_config }}" "$saved"
    fi
    cockpit app install --from "$PWD/app"
    if [ -n "$saved" ]; then
      cp "$saved" "{{ app_config }}"
      rm -f "$saved"
      echo "kept the remote desk in {{ app_config }}"
    fi
    echo "restart the Herdr app if it does not pick the new mod up"

# Server: build the fork's desk as a release through aq, install it into both cockpit binaries and restart the hub.
desk-server:
    #!/usr/bin/env bash
    set -euo pipefail
    repo="{{ justfile_directory() }}"
    cd "$repo"
    remote=$(just fork-remote)
    git fetch -q "$remote" desk
    work=$(mktemp -d /tmp/cockpit-desk-build.XXXXXX)
    trap 'git -C "$repo" worktree remove --force "$work" 2>/dev/null || true; git -C "$repo" worktree prune' EXIT
    git worktree add -q --detach "$work" "$remote/desk"
    echo "building desk at $(git -C "$work" log --oneline -1)"
    cd "$work"
    id=$(aq submit --name cockpit-build-release --memory 8G --expected 2G --cpus 8 --timeout 30m -- \
      bash -lc "cd herdr/tui && CARGO_TARGET_DIR='$repo/herdr/tui/target' cargo build --release --locked -p cockpit-cli -j \"\$AQ_CPUS\"" | head -1)
    aq wait "$id" || { aq result "$id" >&2 || true; exit 1; }
    cd "$repo"
    new="$repo/herdr/tui/target/release/cockpit"
    for dir in "$HOME/.config/cockpit/herdr/bin" "$HOME/.claude/plugins/marketplaces/cockpit/herdr/bin"; do
      [ -d "$dir" ] || continue
      [ -f "$dir/cockpit" ] && cp -p "$dir/cockpit" "$dir/cockpit.prev"
      cp "$new" "$dir/cockpit.new"
      chmod +x "$dir/cockpit.new"
      mv -f "$dir/cockpit.new" "$dir/cockpit"
      echo "installed into $dir (the previous one is cockpit.prev)"
    done
    listen="${COCKPIT_HUB_LISTEN:-}"
    pid=$(pgrep -f 'bin/cockpit hub$' | head -1 || true)
    if [ -n "$pid" ]; then
      running=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^COCKPIT_HUB_LISTEN=//p' || true)
      listen="${running:-$listen}"
    fi
    cockpit hub stop || true
    COCKPIT_HUB_LISTEN="$listen" cockpit hub start >/dev/null
    echo "hub restarted${listen:+, listening on $listen}"

# Server: rebuild desk from upstream main and the listed branches (cockpit-desk), then run desk-server.
desk: && desk-server
    cockpit-desk
