#!/bin/sh
# Nightly PostgreSQL backup of the café database, kept 30 days. Run from cron on the VPS.
set -eu
umask 077
DIR=/opt/cafe/backups
mkdir -p "$DIR"
cd /opt/cafe/app
docker compose exec -T db pg_dump -U cafe -d cafe --no-owner | gzip > "$DIR/cafe-$(date +%F-%H%M).sql.gz"
find "$DIR" -name 'cafe-*.sql.gz' -mtime +30 -delete
