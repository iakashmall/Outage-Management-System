#!/usr/bin/env bash
# Replace the old OMS containers on this shared server with the new stack on port 8080.
# Does NOT touch other apps (sel-hrms, caddy, tileserver) and does NOT delete any volumes.
# Run from the project root:   bash deploy/ubuntu/replace-old-oms.sh
set -euo pipefail
: "${OMS_DB_PASSWORD:?set OMS_DB_PASSWORD before running this script}"
: "${OMS_KC_ADMIN_PASSWORD:?set OMS_KC_ADMIN_PASSWORD before running this script}"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
DC="docker compose -f docker-compose.deploy.yml"

# The address people type in the browser. Override with:  OMS_HOST=oms.example.org bash deploy/ubuntu/replace-old-oms.sh
export OMS_HOST="${OMS_HOST:-$(hostname -I | awk '{print $1}')}"
echo "==> Using address: $OMS_HOST  (open https://$OMS_HOST:8443 ; plain http://$OMS_HOST:8080 also serves the pages but login needs https)"

# Allow the login redirect back to this address (the shipped realm only knows localhost:15173).
python3 deploy/ubuntu/patch-realm.py "$OMS_HOST"

echo "==> Stopping the old OMS web/backend (frees port 8080). Old data volumes are kept."
docker rm -f oms-app-web oms-app-backend 2>/dev/null || true

echo "==> Building and starting the new stack (first build takes several minutes)"
$DC up -d --build

echo -n "==> Waiting for the database"
until [ "$($DC ps postgres --format '{{.Health}}')" = "healthy" ]; do echo -n "."; sleep 3; done; echo " ready"

echo -n "==> Waiting for the login server (Keycloak, about a minute)"
until curl -fs "http://127.0.0.1:18080/realms/oms-upcl" >/dev/null; do echo -n "."; sleep 5; done; echo " ready"

echo "==> Loading the demo data (safe to repeat)"
$DC run --rm oms-backend node src/infra/seed.js

echo "==> Checking"
sleep 8
curl -fsS http://127.0.0.1:8080/api/health && echo
curl -fskS https://127.0.0.1:8443/api/health --resolve "$OMS_HOST:8443:127.0.0.1" -H "Host: $OMS_HOST:8443" && echo || echo "(https check skipped)"
echo "Logins: see the users in infra/keycloak-realm.json (e.g. test.operator)."
echo "DONE. Open https://$OMS_HOST:8443  (the browser warns about the self-signed certificate: Advanced > Proceed)"
echo "Logs: $DC logs -f oms-backend"
