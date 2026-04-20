#!/usr/bin/env bash
# Local test script for distilled memory.
#
# Spins up the memory stack (postgres + ollama + memory-server), pulls
# the required models, ingests a multi-fact sentence, waits for
# background distillation, then queries to verify atoms were created.

set -euo pipefail

COMPOSE="docker compose -f e2e/openclaw/docker-compose.test.yml"
MEMORY_URL="http://localhost:3334"
DB_EXEC="docker exec openclaw-e2e-postgres-1 psql -U memory_test -d memory_test"

echo "=== 1. Starting stack (postgres + ollama + memory-server) ==="
$COMPOSE up -d --build postgres ollama memory-server

echo "=== 2. Waiting for memory server ==="
for i in $(seq 1 30); do
  if curl -sf "$MEMORY_URL/health" > /dev/null 2>&1; then
    echo "   ready"
    break
  fi
  sleep 2
done

echo "=== 3. Pulling Ollama models (first run only; ~2-3 min) ==="
$COMPOSE exec -T ollama ollama pull nomic-embed-text
$COMPOSE exec -T ollama ollama pull llama3.2:3b

echo "=== 4. Ingesting a multi-fact message ==="
RAW_CONTENT="My name is Phil, I love eating steak, I live in Nantwich, and I drive a vintage motorcycle. My favourite coffee is a cortado."
STORE_RESPONSE=$(curl -s "$MEMORY_URL/store" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$(printf '{"content": %s, "metadata": {"role": "user", "source": "distill-test"}}' "$(printf '%s' "$RAW_CONTENT" | python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))')")")
RAW_ID=$(echo "$STORE_RESPONSE" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
echo "   raw memory ID: $RAW_ID"

echo "=== 5. Waiting for background distillation (60s) ==="
for i in $(seq 1 30); do
  sleep 2
  COUNT=$($DB_EXEC -tAc "SELECT COUNT(*) FROM memory_nodes WHERE source_id = '$RAW_ID'" 2>/dev/null | tr -d '[:space:]' || echo 0)
  if [ "$COUNT" -gt 0 ]; then
    echo "   $COUNT atoms distilled"
    break
  fi
  echo "   still waiting... ($i/30)"
done

echo ""
echo "=== 6. Verifying atoms in DB ==="
$DB_EXEC -c "
  SELECT
    id,
    content,
    source_id,
    (SELECT name FROM memory_layers WHERE id = mn.layer_id) AS layer
  FROM memory_nodes mn
  WHERE source_id = '$RAW_ID'
  ORDER BY created_at;
"

echo "=== 7. Searching for individual facts ==="
for query in "What coffee does Phil drink?" "Where does Phil live?" "What does Phil ride?"; do
  echo ""
  echo "Query: \"$query\""
  curl -s "$MEMORY_URL/search" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "import json; print(json.dumps({'query': '$query', 'limit': 3, 'min_score': 0.3}))")" \
    | python3 -m json.tool
done

echo ""
echo "=== Done ==="
echo "Tear down: $COMPOSE down -v"
