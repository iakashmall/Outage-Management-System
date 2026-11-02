#!/usr/bin/env bash
# Load the network topology (network.* schema + inferred Haridwar graph) into the OMS database on this server.
# Required after the first deploy and after any change to backend/src/infra/importHaridwarInferred.js.
# See deploy/ubuntu/DEPLOY.md, "Load the network topology".
#
#   bash deploy/ubuntu/load-topology.sh            backup, schema, then importer --dry-run (writes no topology rows)
#   bash deploy/ubuntu/load-topology.sh --write    backup, schema, dry run, then importer --write
#
# Run from the project folder (the one with docker-compose.deploy.yml). Needs no passwords: like backup-db.sh it
# finds the containers of the "oms" compose project by label, and psql / the importer use the credentials those
# containers were started with. Nothing here reads or prints a password or DATABASE_URL.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

WRITE=0
case "${1:-}" in
  "") ;;
  --write) WRITE=1 ;;
  *) echo "usage: $0 [--write]" >&2; exit 2 ;;
esac

SCHEMA=db/migrations/network_topology_schema.sql
[ -f "$SCHEMA" ] || { echo "ERROR: $SCHEMA not found - run this from the OMS project folder" >&2; exit 1; }

container() { # $1 = compose service name
  docker ps -q --filter label=com.docker.compose.project=oms --filter "label=com.docker.compose.service=$1"
}
PG=$(container postgres)
BE=$(container oms-backend)
[ -n "$PG" ] || { echo "ERROR: the OMS postgres container is not running" >&2; exit 1; }
[ -n "$BE" ] || { echo "ERROR: the OMS backend container is not running" >&2; exit 1; }

# psql inside the postgres container, as its own POSTGRES_USER, on database oms. Same pattern as backup-db.sh.
psql_oms() {
  docker exec -i "$PG" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d oms -v ON_ERROR_STOP=1 -X -q "$@"' _ "$@"
}

echo "==> 1/4 Backup (deploy/ubuntu/backup-db.sh)"
bash deploy/ubuntu/backup-db.sh

echo "==> 2/4 PostGIS check"
if [ "$(psql_oms -tAc "SELECT count(*) FROM pg_extension WHERE extname = 'postgis'")" != "1" ]; then
  echo "ERROR: PostGIS is not enabled on database oms (db/init/00-init.sql enables it on a fresh volume)." >&2
  echo "       The topology schema needs it; nothing was changed." >&2
  exit 1
fi

echo "==> 3/4 Schema: $SCHEMA (idempotent, CREATE ... IF NOT EXISTS only)"
psql_oms < "$SCHEMA"
echo "    network.conducting_equipment rows now: $(psql_oms -tAc 'SELECT count(*) FROM network.conducting_equipment')"

# The importer is in the backend image at /app/backend/src/infra/ (WORKDIR /app/backend), and reads
# src/infra/network.json next to it, i.e. the network.json baked into the image at build time.
IMPORTER=src/infra/importHaridwarInferred.js
echo "==> 4/4 Importer dry run (read-only transaction; nothing written)"
docker exec "$BE" node "$IMPORTER" --dry-run

if [ "$WRITE" -ne 1 ]; then
  echo
  echo "Dry run only. Check above: components 611 (10 substation-anchored, 601 orphaned), 'refusedByNodeSpanCap' present,"
  echo "and '--write would proceed'. Then run again with --write."
  exit 0
fi

echo "==> Importer --write (one transaction: all or nothing)"
docker exec "$BE" node "$IMPORTER" --write

echo "==> Row counts after the import"
psql_oms -c "SELECT 'substations' t, count(*) FROM network.substations
             UNION ALL SELECT 'feeders', count(*) FROM network.feeders
             UNION ALL SELECT 'conducting_equipment', count(*) FROM network.conducting_equipment
             UNION ALL SELECT 'connectivity_nodes', count(*) FROM network.connectivity_nodes
             UNION ALL SELECT 'terminals', count(*) FROM network.terminals"
echo "DONE. Restart the backend so its startup log reports the topology: docker compose -f docker-compose.deploy.yml restart oms-backend"
