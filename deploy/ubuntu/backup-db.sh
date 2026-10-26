#!/usr/bin/env bash
# Back up the OMS databases: "oms" (incidents, jobs, crew photos, QR asset scans, ...) and "keycloak" (logins).
# Crew photos and QR scans are stored only in Postgres, so this backup is the only copy of them outside the
# pgdata volume. Safe to run while the OMS is in use. Keeps the last OMS_BACKUP_KEEP_DAYS days of backups.
#   bash deploy/ubuntu/backup-db.sh
# Nightly at 02:30 (crontab -e):
#   30 2 * * * bash /path/to/OMS-deploy/deploy/ubuntu/backup-db.sh >> $HOME/oms-backups/backup.log 2>&1
# Copy the backup folder to another machine too: a backup on the same disk is lost with the disk.
set -euo pipefail
BACKUP_DIR="${OMS_BACKUP_DIR:-$HOME/oms-backups}"
KEEP_DAYS="${OMS_BACKUP_KEEP_DAYS:-14}"

# Find the Postgres container of the "oms" compose project. No docker compose here, so cron does not need the
# passwords exported: pg_dump uses the password the container itself was started with.
PG=$(docker ps -q --filter label=com.docker.compose.project=oms --filter label=com.docker.compose.service=postgres)
if [ -z "$PG" ]; then echo "$(date '+%F %T') ERROR: the OMS postgres container is not running" >&2; exit 1; fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F_%H%M)
for DB in oms keycloak; do
  OUT="$BACKUP_DIR/${DB}_$STAMP.dump"
  # Write to a .part file first, so a failed dump never looks like a good backup.
  docker exec "$PG" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -Fc "$1"' _ "$DB" > "$OUT.part"
  mv "$OUT.part" "$OUT"
  echo "$(date '+%F %T') saved $OUT ($(du -h "$OUT" | cut -f1))"
done

find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -mtime +"$KEEP_DAYS" -print -delete
find "$BACKUP_DIR" -maxdepth 1 -name '*.dump.part' -delete
