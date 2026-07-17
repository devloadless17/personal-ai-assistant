#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Postgres backup for the assistant stack.
#
# The ONLY durable copy of every client's tasks, reminders, memory, message
# history, and (encrypted) OAuth/bot tokens is the `pgdata` Docker volume on a
# single VPS. A bad migration, disk failure, or `docker volume rm` destroys it
# permanently. This script takes a consistent logical dump so that is
# recoverable. Run it on a schedule AND ship the dumps OFF the box.
#
# Runs pg_dump inside the running postgres container, gzips to ./backups with a
# UTC-timestamped name, prunes to the newest $BACKUP_KEEP, and (if configured)
# uploads off-box.
#
# Schedule via host cron in the deploy dir, e.g. every 6 hours:
#   0 */6 * * * cd /opt/assistant && ./backup.sh >> backups/backup.log 2>&1
#
# RESTORE: see README → "Backups & restore".
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.prod.yml"
DB_USER="${POSTGRES_USER:-assistant}"
DB_NAME="${POSTGRES_DB:-assistant}"
DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-56}"   # 56 × 6h ≈ 14 days of history
mkdir -p "$DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/assistant-$TS.sql.gz"

# -T: no TTY (cron-safe). pipefail makes a pg_dump error fail the whole pipe so
# a truncated dump is never mistaken for a good one. Write to .tmp then rename
# atomically — a crash mid-dump never leaves a half-written .sql.gz that looks
# restorable. --clean --if-exists makes the dump self-contained for restore.
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists | gzip -9 >"$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
echo "$(date -u +%FT%TZ) backup OK: $OUT ($(du -h "$OUT" | cut -f1))"

# Prune old LOCAL backups (keep the newest $KEEP).
# shellcheck disable=SC2012
ls -1t "$DIR"/assistant-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

# OFF-BOX COPY — STRONGLY RECOMMENDED. A VPS-local backup dies WITH the VPS.
# Set BACKUP_UPLOAD_CMD to ship "$1" (the new dump) somewhere durable, e.g.:
#   export BACKUP_UPLOAD_CMD='rclone copy "$1" b2:my-bucket/assistant/'
#   export BACKUP_UPLOAD_CMD='aws s3 cp "$1" s3://my-bucket/assistant/'
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  bash -c "$BACKUP_UPLOAD_CMD" _ "$OUT" && echo "off-box upload OK: $OUT"
else
  echo "WARNING: BACKUP_UPLOAD_CMD not set — this backup is VPS-LOCAL ONLY." >&2
fi
