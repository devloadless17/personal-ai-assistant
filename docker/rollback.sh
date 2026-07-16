#!/usr/bin/env bash
# Roll the stack back to the previously-healthy release.
#
# The deploy records the running release's image tag in `.deploy_current` and,
# once a NEW release passes the health gate, copies the old tag into
# `.deploy_previous`. This script repins IMAGE_TAG to `.deploy_previous` and
# recreates api/web from those images (which are kept on the box for exactly
# this reason). Postgres/Caddy and all data volumes are untouched.
#
# Run it FROM the deploy dir on the VPS:
#   ./rollback.sh
#
# Note: a rollback does NOT reverse a database migration. Forward-only
# migrations are safe; if a release included a destructive migration, restore
# the database from backup instead.
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"

[ -f .env ] || { echo "error: no .env in $(pwd) — run this from the deploy dir"; exit 1; }
[ -f .deploy_previous ] || { echo "error: no .deploy_previous — nothing to roll back to"; exit 1; }

PREV_TAG="$(cat .deploy_previous)"
CUR_TAG="$(cat .deploy_current 2>/dev/null || echo '?')"
[ -n "$PREV_TAG" ] || { echo "error: .deploy_previous is empty"; exit 1; }

echo "Rolling back: $CUR_TAG -> $PREV_TAG"
sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=$PREV_TAG|" .env

docker compose -f "$COMPOSE_FILE" up -d --remove-orphans
echo "$PREV_TAG" > .deploy_current
echo "Rolled back to $PREV_TAG. Verify: docker compose -f $COMPOSE_FILE ps"
