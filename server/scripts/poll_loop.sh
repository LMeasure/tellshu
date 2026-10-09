#!/usr/bin/env bash
# 轮询词典批次直至全部终态。GET 批次接口会驱动服务端 syncBatch。
ADMIN_KEY="4914b47c5eed417e769cb165fedb6cbf95d9b303530ef982"
BASE="http://127.0.0.1:8787"
BATCH_IDS="836d3e88-e2aa-4eec-8380-e43203572566 b9b2d3e3-0c3f-4325-8597-cd38215a3a2f e0c228ba-f6c6-449d-837a-a716a768ad5e"
LOG="$(dirname "$0")/../data/poll.log"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
for round in $(seq 1 90); do
  open=0
  for id in $BATCH_IDS; do
    resp=$(curl -sS -m 60 -H "Authorization: Bearer $ADMIN_KEY" "$BASE/api/admin/dictionary/batches/$id" 2>&1)
    echo "[$(date +%H:%M:%S)] batch=$id $resp" >> "$LOG"
    if echo "$resp" | grep -q '"byStatus"'; then
      if echo "$resp" | grep -qE '"(pending|processing|queued|running)"'; then open=1; fi
    else
      open=1
    fi
  done
  if [ "$open" -eq 0 ]; then echo "ALL_TERMINAL round=$round" >> "$LOG"; exit 0; fi
  sleep 20
done
echo "TIMEOUT after 90 rounds" >> "$LOG"
exit 2
