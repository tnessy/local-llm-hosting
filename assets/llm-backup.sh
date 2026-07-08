#!/usr/bin/env bash
# Nightly backup for the LLM stack (step 13). GPG-encrypts both stateful stores
# and prunes archives older than 30 days. Install root-only and run via cron:
#   sudo install -m 700 -o root -g root assets/llm-backup.sh /root/llm-backup.sh
#   echo '0 4 * * * root /root/llm-backup.sh >> /var/log/llm-backup.log 2>&1' | sudo tee /etc/cron.d/llm-backup
# Requires /root/.backup-passphrase (600, root) — see step 13 "First-time setup".
set -euo pipefail

DEST=/srv/backups
PASS=/root/.backup-passphrase
DATE=$(date +%F)
MK=/snap/bin/microk8s

# Open WebUI — accounts, per-user keys, chat history (SQLite in the PVC).
# Exclude ./cache: it's the re-downloadable embedding/model cache (~800 MB).
"$MK" kubectl exec -n llm-core deploy/open-webui -- tar cz -C /app/backend/data --exclude=./cache . \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS" \
        --output "$DEST/openwebui-$DATE.tgz.gpg"

# LiteLLM — virtual keys, budgets, spend (PostgreSQL; pg_dump is consistent live).
"$MK" kubectl exec -n llm-core deploy/litellm-postgres -- \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS" \
        --output "$DEST/litellm-pg-$DATE.sql.gpg"

# Retention: drop encrypted archives older than 30 days.
find "$DEST" -name '*.gpg' -mtime +30 -delete
