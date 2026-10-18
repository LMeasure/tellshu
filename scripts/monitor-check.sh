#!/usr/bin/env bash
# =============================================================================
# monitor-check.sh —— 发现书籍 API 监控摘要（B.10 任务 4）
#
# 干什么：curl 一次 GET /api/discover/status，输出人类可读摘要。
#         设计给 cron / 定时任务用，所以**用退出码表达严重程度**：
#             0 = OK（或 WARN）
#             1 = 异常：服务不可达 / health 非 ok / regression 判 ALERT
#             2 = 依赖缺失（curl 或 python 找不到）
#
# 用法：
#   scripts/monitor-check.sh
#   BASE=http://127.0.0.1:8000 scripts/monitor-check.sh
#   PYTHON_BIN=C:/Python314/python.exe scripts/monitor-check.sh   # Windows 指定解释器
#
# cron 示例（每 5 分钟一次，只在异常时发信）：
#   */5 * * * * /path/scripts/monitor-check.sh || echo "discover API 告警" | mail -s "alert" ops@example.com
# =============================================================================

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8000}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CURL_BIN="${CURL_BIN:-curl}"

command -v "$CURL_BIN" >/dev/null 2>&1 || { echo "[FAIL] 找不到 curl（设 CURL_BIN 指定路径）"; exit 2; }
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "[FAIL] 找不到 python（设 PYTHON_BIN，Windows 例：C:/Python314/python.exe）"; exit 2; }

STATUS="$("$CURL_BIN" -s --max-time 15 "$BASE/api/discover/status" || true)"
if [ -z "$STATUS" ]; then
  echo "[ALERT] 服务不可达：$BASE/api/discover/status"
  exit 1
fi

echo "=== Discover API Status ==="
# --no-ensure-ascii：中文不要被转义成 \uXXXX，人要看的是原文。
# 老版本 json.tool 没有这个参数，失败就退回默认输出。
echo "$STATUS" | "$PYTHON_BIN" -m json.tool --no-ensure-ascii 2>/dev/null \
  || echo "$STATUS" | "$PYTHON_BIN" -m json.tool

echo
echo "=== 摘要 ==="
"$PYTHON_BIN" - "$STATUS" <<'PY'
import json, sys

try:
    d = json.loads(sys.argv[1])
except Exception as exc:
    print(f"[ALERT] 响应不是合法 JSON：{exc}")
    sys.exit(1)

h = d.get("health") or {}
r = d.get("regression_quick") or {}

print(f"  时间          : {d.get('timestamp')}")
print(f"  服务状态      : {h.get('status')}")
print(f"  编码模式      : {(h.get('embedding') or {}).get('backend')}"
      f"（{(h.get('latency_profile') or {}).get('mode')}）")
db = h.get("database") or {}
print(f"  ef/iterative  : {db.get('ef_search')} / {db.get('iterative_scan')}  (match={db.get('guc_match')})")
pl = h.get("plan") or {}
print(f"  执行计划      : {pl.get('type')}  rows={pl.get('rows_returned')}/{pl.get('expected_rows')}")
lp = h.get("latency_profile") or {}
if lp.get("e2e_p50_ms") is not None:
    print(f"  最近压测 P50  : encode {lp.get('encode_p50_ms')} + retrieve {lp.get('retrieve_p50_ms')} "
          f"= e2e {lp.get('e2e_p50_ms')} ms  [{lp.get('source')}]")
else:
    print("  最近压测 P50  : 无（还没跑过压测）")

if r.get("available"):
    print(f"  数据规模      : {r.get('row_count')} 行")
    occ = r.get("occupancy_pct")
    print(f"  400ms 预算占用: {occ}%  (status={r.get('status')}, N*={r.get('n_star_400ms_long_query')})")
    if r.get("slope_source"):
        print(f"  斜率来源      : {r.get('slope_source')}")
else:
    print(f"  回归信息      : 不可用（{r.get('detail', '未返回')}）")

bad = []
if h.get("status") != "ok":
    bad.append(f"health={h.get('status')}")
if not (pl.get("ok") is True):
    bad.append("执行计划/返回行数异常")
if r.get("status") == "ALERT":
    bad.append("regression=ALERT")

if bad:
    print(f"\n[ALERT] {'; '.join(bad)}")
    sys.exit(1)

print("\n[OK] 全部检查通过")
PY
