#!/usr/bin/env bash
# API contract test — verifies the engine exposes the same wire format
# as pentatonic-memory v0.5.x.
#
# Run after `docker compose up -d` and a ~30s warm-up.
set -eu

BASE="${BASE:-http://localhost:8099}"
PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "=== /health ==="
H=$(curl -sf "$BASE/health" || echo "{}")
echo "$H" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  status:', d.get('status'), 'engine:', d.get('engine'), 'layers:', list(d.get('layers',{}).keys()))"
[ "$(echo "$H" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))')" = "ok" ] && ok "GET /health returns ok" || fail "GET /health"

echo ""
echo "=== /store ==="
R=$(curl -sf -X POST "$BASE/store" -H "Content-Type: application/json" \
  -d '{"content":"smoke-test the quick brown fox","metadata":{"test":"contract"}}')
echo "$R" | python3 -m json.tool | head -8
[ "$(echo "$R" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("id" in d and "content" in d and "layerId" in d)')" = "True" ] && ok "POST /store has v0.5 fields" || fail "POST /store"

echo ""
echo "=== /store-batch (NEW) ==="
B=$(curl -sf -X POST "$BASE/store-batch" -H "Content-Type: application/json" \
  -d '{"records":[{"id":"b1","content":"hello world"},{"id":"b2","content":"vova lives in worthing"}]}')
echo "$B" | python3 -m json.tool | head -8
[ "$(echo "$B" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("inserted",0)>=1)')" = "True" ] && ok "POST /store-batch inserted N records" || fail "POST /store-batch"

# Wait for indexing
sleep 3

echo ""
echo "=== /search ==="
S=$(curl -sf -X POST "$BASE/search" -H "Content-Type: application/json" \
  -d '{"query":"vova worthing","limit":5,"min_score":0.001}')
N=$(echo "$S" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("results",[])))')
echo "  hits: $N"
[ "$N" -gt 0 ] && ok "POST /search returned hits" || fail "POST /search returned 0 hits"
[ "$(echo "$S" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; print("similarity" in r[0] and "content" in r[0] if r else False)')" = "True" ] && ok "POST /search has v0.5 result fields" || fail "POST /search shape"

echo ""
echo "=== /forget (RESTORED) ==="
F=$(curl -sf -X POST "$BASE/forget" -H "Content-Type: application/json" \
  -d '{"metadata_contains":{"test":"contract"}}')
echo "$F" | python3 -m json.tool
[ "$(echo "$F" | python3 -c 'import json,sys; print("deleted" in json.load(sys.stdin))')" = "True" ] && ok "POST /forget exists" || fail "POST /forget"

echo ""
echo "=== Result ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
exit $FAIL
