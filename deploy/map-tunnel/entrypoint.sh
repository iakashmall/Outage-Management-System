#!/bin/sh
# Keeps "ssh -L" open and reconnects when it drops.
#   MAP_SSH_HOST         where the map server's sshd is (default host.docker.internal = this server)
#   MAP_SSH_USER         tunnel-only login (default mapdev)
#   MAP_SSH_PORT         default 22
#   MAP_SSH_REMOTE_PORT  map server port on that machine (default 8095)
# The private key is mounted at /keys/id_ed25519 (read-only).
set -u
HOST="${MAP_SSH_HOST:-host.docker.internal}"
USER_="${MAP_SSH_USER:-mapdev}"
PORT="${MAP_SSH_PORT:-22}"
RPORT="${MAP_SSH_REMOTE_PORT:-8095}"

mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f /keys/id_ed25519 ]; then
  echo "map-tunnel: no key at /keys/id_ed25519 (see deploy/ubuntu/DEPLOY.md, map section)"; sleep 3600; exit 1
fi
cp /keys/id_ed25519 /root/.ssh/id_ed25519 && chmod 600 /root/.ssh/id_ed25519

while true; do
  echo "map-tunnel: connecting ${USER_}@${HOST}:${PORT}, forwarding 8095 -> 127.0.0.1:${RPORT} there"
  ssh -N -T -i /root/.ssh/id_ed25519 \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts \
    -L "0.0.0.0:8095:127.0.0.1:${RPORT}" -p "$PORT" "${USER_}@${HOST}"
  echo "map-tunnel: connection ended, retrying in 5 s"; sleep 5
done
