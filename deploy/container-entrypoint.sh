#!/bin/sh
set -eu
umask 077

mode=${1:-start}
agent_data_dir=${DEPANATOR_DATA_DIR:-/data}
case "$agent_data_dir" in
  /*) ;;
  *) echo 'DEPANATOR_DATA_DIR must be an absolute path' >&2; exit 64 ;;
esac
case "$mode" in
  # Container healthcheck for `start`: the agent renews this deadline after every poll.
  health) [ "$(cat "$agent_data_dir/heartbeat" 2>/dev/null || echo 0)" -gt "$(date +%s)" ]; exit $? ;;
  status) exec bun /app/src/cli.js status ;;
  start) ;;
  *) echo 'Use start, status, or health' >&2; exit 64 ;;
esac

mkdir -p "$agent_data_dir" "$HOME"

# All agent containers share this kernel lock, independent of PID namespaces.
# Once held, a prior container is gone and its process-local lock may be cleared.
exec 9>"$agent_data_dir/container.lock"
flock -n 9 || { echo 'Another agent container is using this data volume' >&2; exit 75; }
rm -f "$agent_data_dir/agent.lock"
# A hard stop leaves Chromium's profile lock naming the old container's hostname, which would make
# every later launch refuse the profile. The flock above proves no browser is using it now.
rm -f "${DEPANATOR_BROWSER_PROFILE:-$agent_data_dir/browser}"/Singleton*

# Chromium runs headful (sites treat headless browsers as bots) on a virtual display nobody views:
# the IS24 login tab is streamed into Telegram instead.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
ready=0
while ! xdpyinfo -display :99 >/dev/null 2>&1; do
  ready=$((ready + 1))
  [ "$ready" -lt 50 ] || { echo 'Virtual display failed to start' >&2; exit 1; }
  sleep 0.1
done

# Keep the shell alive holding flock while Bun runs. Forward shutdown to Bun so
# it commits the outcome and releases its own lock before the container exits.
bun /app/src/cli.js start &
agent_pid=$!
trap 'kill -TERM "$agent_pid" 2>/dev/null || true; result=0; wait "$agent_pid" || result=$?; exit "$result"' TERM INT
wait "$agent_pid"
