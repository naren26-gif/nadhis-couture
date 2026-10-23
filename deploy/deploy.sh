#!/usr/bin/env bash
# Update the running app on the server: get the latest code, rebuild the image, restart, clean old images.
# Run from the project folder on the server:   ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=/etc/nadhi/env
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy deploy/env.example and fill it in)"; exit 1; }

git pull --ff-only
sudo docker compose --env-file "$ENV_FILE" up -d --build
sudo docker image prune -f
sudo docker compose --env-file "$ENV_FILE" ps
