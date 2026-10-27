#!/bin/sh
# Dumps the database to backups/grokbot-<timestamp>.sql.gz and keeps the newest 14.
# Cron example (daily 03:15):  15 3 * * * cd /srv/grok-bot-universal && ./scripts/backup.sh
# The dump holds encrypted bot keys; restoring also needs ENCRYPTION_KEY from .env.
# Restore: gunzip -c backups/FILE.sql.gz | docker compose exec -T db psql -U grokbot -d grokbot
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
file="backups/grokbot-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose exec -T db pg_dump -U grokbot -d grokbot --clean --if-exists | gzip > "$file"
echo "wrote $file"
ls -1t backups/grokbot-*.sql.gz | tail -n +15 | xargs -r rm --
