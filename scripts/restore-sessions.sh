#!/usr/bin/env bash
# =============================================================================
# restore-sessions.sh — Restaurar sessões Baileys a partir de um backup
#
# Uso:
#   bash restore-sessions.sh /opt/whatsapp-gateway/backups/sessions_20240115_030000.tar.gz
#
# ATENÇÃO: Para o Gateway ANTES de restaurar para evitar conflito de estado.
#   sudo systemctl stop whatsapp-gateway
#   bash restore-sessions.sh <arquivo>
#   sudo systemctl start whatsapp-gateway
# =============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"
SESSIONS_DIR="${SESSIONS_DIR:-/opt/whatsapp-gateway/sessions}"
GATEWAY_SERVICE="${GATEWAY_SERVICE:-whatsapp-gateway}"

# ── Validações ────────────────────────────────────────────────────────────────
if [ -z "$BACKUP_FILE" ]; then
  echo "Uso: bash restore-sessions.sh <arquivo_backup.tar.gz>"
  echo ""
  echo "Backups disponíveis em /opt/whatsapp-gateway/backups/:"
  ls -lht /opt/whatsapp-gateway/backups/sessions_*.tar.gz 2>/dev/null || echo "  (nenhum encontrado)"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERRO: Arquivo não encontrado: $BACKUP_FILE"
  exit 1
fi

# ── Verifica se Gateway está rodando ─────────────────────────────────────────
if systemctl is-active --quiet "$GATEWAY_SERVICE" 2>/dev/null; then
  echo "AVISO: O Gateway está rodando. Parando $GATEWAY_SERVICE..."
  sudo systemctl stop "$GATEWAY_SERVICE"
  STOP_GATEWAY=true
else
  STOP_GATEWAY=false
fi

# ── Faz backup da pasta atual antes de sobrescrever ───────────────────────────
if [ -d "$SESSIONS_DIR" ] && [ "$(ls -A "$SESSIONS_DIR" 2>/dev/null)" ]; then
  PRE_RESTORE_BACKUP="/tmp/sessions_pre_restore_$(date +%Y%m%d_%H%M%S).tar.gz"
  echo "Salvando estado atual em $PRE_RESTORE_BACKUP antes de restaurar..."
  tar -czf "$PRE_RESTORE_BACKUP" -C "$(dirname "$SESSIONS_DIR")" "$(basename "$SESSIONS_DIR")" || true
fi

# ── Restaura ──────────────────────────────────────────────────────────────────
echo "Restaurando: $BACKUP_FILE → $SESSIONS_DIR"

PARENT_DIR=$(dirname "$SESSIONS_DIR")
rm -rf "$SESSIONS_DIR"
mkdir -p "$PARENT_DIR"

tar -xzf "$BACKUP_FILE" -C "$PARENT_DIR"

# Garante permissões corretas
chmod 700 "$SESSIONS_DIR"
find "$SESSIONS_DIR" -type d -exec chmod 700 {} \;
find "$SESSIONS_DIR" -type f -exec chmod 600 {} \;

INSTANCE_COUNT=$(find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
echo "Restauração concluída: $INSTANCE_COUNT instância(s)"

# ── Reinicia Gateway se foi parado por nós ────────────────────────────────────
if [ "$STOP_GATEWAY" = true ]; then
  echo "Reiniciando $GATEWAY_SERVICE..."
  sudo systemctl start "$GATEWAY_SERVICE"
  echo "Gateway reiniciado. As sessões serão restauradas automaticamente."
fi

echo ""
echo "Restore concluído. Verifique os logs:"
echo "  sudo journalctl -u $GATEWAY_SERVICE -f"

exit 0
