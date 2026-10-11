#!/bin/sh
set -eu
umask 077

mode=${1:-start}
config_file=${DEPANATOR_CONFIG:-/config/config.json}
agent_data_dir=${DEPANATOR_DATA_DIR:-/data}
case "$agent_data_dir" in
  /*) ;;
  *) echo 'DEPANATOR_DATA_DIR must be an absolute path' >&2; exit 64 ;;
esac
case "$mode" in
  setup) shift; exec bun /app/src/setup.js "$@" ;;
  status|llm-login) exec bun /app/src/cli.js "$mode" --config "$config_file" ;;
  start|login) ;;
  *) echo 'Use setup, start, login, llm-login, or status' >&2; exit 64 ;;
esac

VNC_PASSWORD=$(bun -e 'import { readSecret } from "/app/src/config.js"; process.stdout.write(readSecret(process.env, "VNC_PASSWORD"));')
: "${VNC_PASSWORD:?Set VNC_PASSWORD or VNC_PASSWORD_FILE}"
if [ "${#VNC_PASSWORD}" -lt 8 ]; then
  echo 'VNC_PASSWORD must contain at least 8 characters' >&2
  exit 64
fi
mkdir -p "$agent_data_dir" "$HOME"

# All agent/login containers share this kernel lock, independent of PID namespaces.
# Once held, a prior container is gone and its process-local lock may be cleared.
exec 9>"$agent_data_dir/container.lock"
flock -n 9 || { echo 'Another agent/login container is using this data volume' >&2; exit 75; }
rm -f "$agent_data_dir/agent.lock"

Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
ready=0
while ! xdpyinfo -display :99 >/dev/null 2>&1; do
  ready=$((ready + 1))
  [ "$ready" -lt 50 ] || { echo 'Virtual display failed to start' >&2; exit 1; }
  sleep 0.1
done
openbox >/dev/null 2>&1 &
printf '%s\n' "$VNC_PASSWORD" >/tmp/depanator-vnc-password
unset VNC_PASSWORD
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared \
  -passwdfile /tmp/depanator-vnc-password >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

# Keep the shell alive holding flock while Bun runs. Forward shutdown to Bun so
# it commits the outcome and releases its own lock before the container exits.
bun /app/src/cli.js "$mode" --config "$config_file" &
agent_pid=$!
trap 'kill -TERM "$agent_pid" 2>/dev/null || true; result=0; wait "$agent_pid" || result=$?; exit "$result"' TERM INT
wait "$agent_pid"
