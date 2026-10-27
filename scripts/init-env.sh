#!/bin/sh
# Writes .env from .env.example with fresh secrets. Refuses to overwrite an existing .env.
# Usage: ./scripts/init-env.sh https://grokbot.example.com
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then echo ".env already exists; not touching it." >&2; exit 1; fi
url="${1:-}"
if [ -z "$url" ]; then echo "Usage: $0 https://your-hostname" >&2; exit 1; fi
umask 077
sed -e "s|^PUBLIC_URL=.*|PUBLIC_URL=${url}|" \
    -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
    .env.example > .env
echo "Wrote .env (mode 600). Next:"
echo "  1. Paste your CLOUDFLARE_TUNNEL_TOKEN into .env"
echo "  2. Copy ENCRYPTION_KEY into your password manager (needed to restore backups)"
echo "  3. docker compose --profile tunnel up -d --build"
echo "  4. docker compose exec app node src/cli.ts invite --admin"
