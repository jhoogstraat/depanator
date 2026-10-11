#!/bin/sh
set -eu
umask 077

[ "$(uname -s)" = Linux ] || { echo 'Run this installer on your Linux server.' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Run as your rootless service user, not root.' >&2; exit 1; }
command -v podman >/dev/null
systemctl --user show-environment >/dev/null
image=${DEPANATOR_IMAGE:-ghcr.io/jhoogstraat/depanator:latest}
config_dir="$HOME/.config/depanator"
unit_dir="$HOME/.config/containers/systemd"
[ ! -e "$unit_dir/depanator.container" ] || { echo 'An agent Quadlet already exists; setup will not overwrite it.' >&2; exit 1; }
mkdir -p "$config_dir" "$unit_dir"
chmod 700 "$config_dir"
podman pull "$image"
podman run --rm -it --userns keep-id:uid=1000,gid=1000 --user 1000:1000 \
  --entrypoint bun -v "$config_dir:/config:z" -e "DEPANATOR_IMAGE=$image" \
  "$image" /app/src/setup.js
# Exclusive creation prevents overwriting an existing unit, even on concurrent setup.
(set -C; cat "$config_dir/depanator.container" > "$unit_dir/depanator.container")
systemctl --user daemon-reload
systemctl --user start depanator.service
printf '\nAgent started. Complete IS24 login in your configured browser viewer; it resumes automatically.\n'
if [ "$(loginctl show-user "$(id -u)" -p Linger --value)" != yes ]; then
  printf 'Enable startup after logout/at boot once: sudo loginctl enable-linger "%s"\n' "$(id -un)"
fi
