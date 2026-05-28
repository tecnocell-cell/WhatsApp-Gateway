#!/usr/bin/env bash
# =============================================================================
# backup-sessions.sh — Backup automático das sessões Baileys (WhatsApp Gateway)
#
# Uso:
#   bash backup-sessions.sh               # usa variáveis padrão abaixo
#   SESSIONS_DIR=/outro/path bash backup-sessions.sh
#
# Cron recomendado (crontab -e no CT103):
#   0 3 * * * /opt/whatsapp-gateway/scripts/backup-sessions.sh >> /var/log/wpp-backup.log 2>&1
#
# Retenção padrão: 7 dias (ajuste RETENTION_DAYS abaixo)
# =============================================================================

set -euo pipefail

# ── Configuração ──────────────────────────────────────────────────────────────
SESSIONS_DIR="${SESSIONS_DIR:-/opt/whatsapp-gateway/sessions}"
BACKUP_DIR="${BACKUP_DIR:-/opt/whatsapp-gateway/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/sessions_${TIMESTAMP}.tar.gz"

# ── Validações ────────────────────────────────────────────────────────────────
if [ ! -d "$SESSIONS_DIR" ]; then
  echo "[$(date -Iseconds)] ERRO: SESSIONS_DIR não existe: $SESSIONS_DIR"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# ── Conta instâncias ──────────────────────────────────────────────────────────
INSTANCE_COUNT=$(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)

if [ "$INSTANCE_COUNT" -eq 0 ]; then
  echo "[$(date -Iseconds)] INFO: Nenhuma sessão em $SESSIONS_DIR — backup ignorado."
  exit 0
fi

# ── Executa backup ────────────────────────────────────────────────────────────
echo "[$(date -Iseconds)] Iniciando backup: $INSTANCE_COUNT instância(s) → $BACKUP_FILE"

tar -czf "$BACKUP_FILE" -C "$(dirname "$SESSIONS_DIR")" "$(basename "$SESSIONS_DIR")"

BACKUP_SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "[$(date -Iseconds)] Backup concluído: $BACKUP_FILE ($BACKUP_SIZE)"

# ── Remove backups antigos ────────────────────────────────────────────────────
REMOVED=$(find "$BACKUP_DIR" -name "sessions_*.tar.gz" -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
if [ "$REMOVED" -gt 0 ]; then
  echo "[$(date -Iseconds)] Limpeza: $REMOVED arquivo(s) removido(s) (>${RETENTION_DAYS} dias)"
fi

# ── Lista backups disponíveis ─────────────────────────────────────────────────
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "sessions_*.tar.gz" | wc -l)
echo "[$(date -Iseconds)] Backups retidos: $BACKUP_COUNT arquivo(s)"

exit 0
