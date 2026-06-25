#!/usr/bin/env bash
# Diagnose an inter-claude setup: runtime, registration, live peers, mailboxes.
set -uo pipefail

BUS_DB="${INTER_CLAUDE_HOME:-$HOME/.claude/channels/inter-claude}/bus.db"
CLAUDE_JSON="$HOME/.claude.json"
ok() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
no() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "inter-claude doctor"
echo "-------------------"

command -v bun >/dev/null && ok "bun $(bun --version)" || no "bun not found (https://bun.sh)"
command -v claude >/dev/null \
  && ok "claude $(claude --version 2>/dev/null | head -1)  (channels need >= 2.1.80)" \
  || no "claude CLI not found"
command -v sqlite3 >/dev/null && ok "sqlite3 present" || no "sqlite3 not found (only needed for this report)"

if [ -f "$CLAUDE_JSON" ] && python3 -c "import json,sys; sys.exit(0 if 'inter-claude' in json.load(open('$CLAUDE_JSON')).get('mcpServers',{}) else 1)" 2>/dev/null; then
  ok "registered in ~/.claude.json"
else
  no "not registered — run: bash scripts/install.sh"
fi

echo
echo "Bus: $BUS_DB"
if command -v sqlite3 >/dev/null && [ -f "$BUS_DB" ]; then
  now_ms=$(( $(date +%s) * 1000 ))
  echo "Live peers:"
  sqlite3 "$BUS_DB" "SELECT '  - '||name||' (pid '||pid||')  '||CASE WHEN last_seen >= $now_ms - 45000 THEN 'online' ELSE 'stale' END FROM peers ORDER BY name;" 2>/dev/null
  [ "$(sqlite3 "$BUS_DB" 'SELECT count(*) FROM peers;' 2>/dev/null)" = "0" ] && echo "  (none)"
  echo
  echo "Mailboxes (pending / delivered):"
  sqlite3 "$BUS_DB" "SELECT '  - '||recipient||'  '||sum(delivered_at IS NULL)||' pending / '||sum(delivered_at IS NOT NULL)||' delivered' FROM messages GROUP BY recipient ORDER BY recipient;" 2>/dev/null
  [ "$(sqlite3 "$BUS_DB" 'SELECT count(*) FROM messages;' 2>/dev/null)" = "0" ] && echo "  (no messages yet)"
else
  echo "  (no bus yet — start a session first)"
fi
