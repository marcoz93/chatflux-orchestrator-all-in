#!/usr/bin/env bash
# Guard: bloqueia escrita de .ts em workers/ que viola programação funcional.
# Chamado como PostToolUse hook do Claude Code (Write|Edit em workers/**/*.ts).
#
# Recebe $TOOL_INPUT via stdin (JSON com file_path).
# Exit 0 = ok, exit 2 = block.

set -euo pipefail

# Extrair file_path do input JSON
FILE=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('file_path',''))" 2>/dev/null || echo "")

# Só checa .ts dentro de workers/chatflux-orchestrator/src/
if [[ ! "$FILE" == *workers/chatflux-orchestrator/src/*.ts ]]; then
  exit 0
fi

# Se o arquivo não existe (Write falhou ou algo assim), skip
if [[ ! -f "$FILE" ]]; then
  exit 0
fi

ERRORS=""

# 1. Proibir class (exceto orchestrator.ts que PRECISA de extends DurableObject)
BASENAME=$(basename "$FILE")
if [[ "$BASENAME" != "orchestrator.ts" ]]; then
  if grep -nE '^\s*(export\s+)?(abstract\s+)?class\s+' "$FILE" >/dev/null 2>&1; then
    LINES=$(grep -nE '^\s*(export\s+)?(abstract\s+)?class\s+' "$FILE" | head -3)
    ERRORS="$ERRORS\n[BLOCK] class proibida fora de orchestrator.ts:\n$LINES"
  fi
fi

# 2. Proibir enum (usar union types ou as const)
if grep -nE '^\s*(export\s+)?enum\s+' "$FILE" >/dev/null 2>&1; then
  LINES=$(grep -nE '^\s*(export\s+)?enum\s+' "$FILE" | head -3)
  ERRORS="$ERRORS\n[BLOCK] enum proibido (usar union types ou 'as const'):\n$LINES"
fi

# 3. Proibir var (usar const)
if grep -nE '^\s*var\s+' "$FILE" >/dev/null 2>&1; then
  LINES=$(grep -nE '^\s*var\s+' "$FILE" | head -3)
  ERRORS="$ERRORS\n[BLOCK] var proibido (usar const):\n$LINES"
fi

# 4. Proibir let (usar const — exceção: dentro de loops)
if grep -nE '^\s*let\s+' "$FILE" >/dev/null 2>&1; then
  # Contar ocorrências fora de for/while
  LET_COUNT=$(grep -cE '^\s*let\s+' "$FILE" || true)
  if [[ "$LET_COUNT" -gt 0 ]]; then
    LINES=$(grep -nE '^\s*let\s+' "$FILE" | head -3)
    ERRORS="$ERRORS\n[WARN] let encontrado ($LET_COUNT ocorrências) — preferir const:\n$LINES"
  fi
fi

# 5. Proibir any (usar tipos explícitos)
if grep -nE ':\s*any\b|<any>|as\s+any' "$FILE" >/dev/null 2>&1; then
  LINES=$(grep -nE ':\s*any\b|<any>|as\s+any' "$FILE" | head -3)
  ERRORS="$ERRORS\n[BLOCK] 'any' proibido (tipar explicitamente):\n$LINES"
fi

# 6. Proibir this fora de orchestrator.ts (indica estado mutável)
if [[ "$BASENAME" != "orchestrator.ts" ]]; then
  if grep -nE '\bthis\.' "$FILE" >/dev/null 2>&1; then
    LINES=$(grep -nE '\bthis\.' "$FILE" | head -3)
    ERRORS="$ERRORS\n[BLOCK] 'this' proibido fora de orchestrator.ts (funções puras não usam this):\n$LINES"
  fi
fi

# 7. Rodar biome check no arquivo
BIOME_OUTPUT=$(npx biome check "$FILE" 2>&1 || true)
if echo "$BIOME_OUTPUT" | grep -q "Found [0-9]* error"; then
  BIOME_ERRORS=$(echo "$BIOME_OUTPUT" | grep -E "(error|×)" | head -5)
  ERRORS="$ERRORS\n[BLOCK] Biome errors:\n$BIOME_ERRORS"
fi

# Se tem [BLOCK], rejeitar
if echo -e "$ERRORS" | grep -q "\[BLOCK\]"; then
  echo -e "========================================="
  echo -e "FUNCTIONAL GUARD: código rejeitado"
  echo -e "========================================="
  echo -e "$ERRORS"
  echo ""
  echo "Regras:"
  echo "  - class: só em orchestrator.ts (extends DurableObject)"
  echo "  - enum/var/any/this: proibidos fora de orchestrator.ts"
  echo "  - const: obrigatório (let apenas se justificado)"
  echo "  - Biome: zero errors"
  exit 2
fi

# Se só tem [WARN], mostrar mas deixar passar
if echo -e "$ERRORS" | grep -q "\[WARN\]"; then
  echo -e "$ERRORS"
fi

exit 0
