# -*- coding: utf-8 -*-
"""
config.py —— 集中配置 + 启动校验（fail fast）

设计原则（沿用 server 侧约定）：
  · 所有配置来自环境变量，启动时一次性解析并校验；缺关键项直接抛错拒绝启动，
    绝不在请求路径里才发现「哦，没配」。
  · 检索相关的 GUC 期望值**只有一个真相源**：server/src/scripts/db-conn-init.sql。
    本模块从该文件解析出 ef_search / iterative_scan，避免配置文件与 SQL 两处漂移。
  · 密钥 / DSN 只从 server/.env 读，不硬编码、不进仓库。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent                 # <root>/api
PROJECT_ROOT = API_ROOT.parent                             # <root>
SERVER_ROOT = PROJECT_ROOT / "server"
INIT_SQL_PATH = SERVER_ROOT / "src" / "scripts" / "db-conn-init.sql"
QUERY_SET_PATH = PROJECT_ROOT / "discover-query-set-v3.json"
VECTOR_CACHE_PATH = SERVER_ROOT / ".crawl-cache" / "_b8-query-vectors.json"

# B.6 矩阵里实测过的 ef_search 取值。请求里只允许这些值 ——
# 没测过的 ef 可能落在「退化区」（B.7：160~400 会让优化器改用 book_idx 全扫 + Sort），
# 那不是「稍慢」，是路径变了。宁可 400 也不给一个未验证的数字。
ALLOWED_EF_SEARCH: tuple[int, ...] = (40, 80, 120, 200, 400, 800)


def load_dotenv(path: Path) -> None:
    """极简 .env 读取（只 setdefault，不覆盖真实环境变量）。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


def parse_init_sql(path: Path) -> tuple[list[str], dict[str, str]]:
    """把 db-conn-init.sql 拆成可执行语句，并解析出 GUC 期望值。

    与 b8-e2e-experiment.py / regression-check.py 的 init_statements() 同款做法：
    按分号切段，去掉整行注释，剩下的非空段就是一条语句。
    """
    if not path.exists():
        raise RuntimeError(f"连接初始化 SQL 不存在：{path}")
    stmts: list[str] = []
    settings: dict[str, str] = {}
    for chunk in path.read_text(encoding="utf-8").split(";"):
        body = "\n".join(
            ln for ln in chunk.splitlines() if not ln.lstrip().startswith("--")
        ).strip()
        if not body:
            continue
        stmts.append(body)
        m = re.search(r"hnsw\.ef_search\s*=\s*(\S+)", body)
        if m:
            settings["ef_search"] = m.group(1)
        m = re.search(r"hnsw\.iterative_scan\s*=\s*(\S+)", body)
        if m:
            settings["iterative_scan"] = m.group(1)
    if not stmts:
        raise RuntimeError(f"{path} 里没有任何可执行语句")
    return stmts, settings


@dataclass(frozen=True)
class Config:
    database_url: str
    init_statements: tuple[str, ...]
    expected_ef_search: str
    expected_iterative_scan: str

    pool_min: int = 5
    pool_max: int = 10

    top_k_default: int = 10
    top_k_max: int = 50
    max_query_chars: int = 500

    embed_backend: str = "local"          # local | remote | onnx（onnx 仅预留，未实现）
    embed_model: str = "BAAI/bge-m3"
    embed_dim: int = 1024
    embedding_service_url: str = ""

    # §10.1 拍板第 4 条：对 ef=800 查询做 1% EXPLAIN ANALYZE 抽样，退化即告警
    explain_sample_rate: float = 0.01

    host: str = "127.0.0.1"
    port: int = 8000

    paths: dict[str, str] = field(default_factory=dict)

    @property
    def embed_mode(self) -> str:
        """B.10：编码是跟 API 共置（local）还是在独立进程（remote）。

        health 的 latency_profile 用这个字段标注当前延迟属于哪种部署形态 ——
        共置的 retrieve 与隔离的 retrieve 不是同一个数，混着看会得出错误预算。
        """
        return "colocated" if self.embed_backend == "local" else "isolated"


def load() -> Config:
    load_dotenv(SERVER_ROOT / ".env")

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("缺少 DATABASE_URL（从 server/.env 读取）")

    stmts, settings = parse_init_sql(INIT_SQL_PATH)
    ef = settings.get("ef_search")
    iscan = settings.get("iterative_scan")
    if ef is None or iscan is None:
        raise RuntimeError(
            f"{INIT_SQL_PATH} 里没解析出 hnsw.ef_search / hnsw.iterative_scan，"
            "连接初始化口径缺失，拒绝启动"
        )

    # 后端判定（B.10 修订）：
    #   设了 EMBEDDING_SERVICE_URL  → remote（编码在独立进程，隔离）
    #   没设                        → local（编码在 API 进程内，共置）
    #   显式 EMBEDDING_BACKEND      → 以显式值为准，与 URL 冲突时报错而不是猜
    service_url = os.environ.get("EMBEDDING_SERVICE_URL", "").strip()
    backend = os.environ.get("EMBEDDING_BACKEND", "").strip().lower()
    if not backend:
        backend = "remote" if service_url else "local"
    if backend not in ("local", "remote", "onnx"):
        raise RuntimeError(f"EMBEDDING_BACKEND 只能是 local / remote / onnx，收到 {backend!r}")
    if backend == "onnx":
        # B.9 任务 2 只做了调研，没实现。这里如实拒绝，不静默退化成 torch 冒充量化。
        raise RuntimeError(
            "EMBEDDING_BACKEND=onnx 尚未实现（B.9 只完成 ONNX INT8 调研，见报告 §7）。"
            "当前请使用 local 或 remote。"
        )
    if backend == "local" and service_url:
        raise RuntimeError(
            "EMBEDDING_BACKEND=local 但又设了 EMBEDDING_SERVICE_URL，口径冲突："
            "要么去掉 URL 走共置，要么去掉 EMBEDDING_BACKEND=local 走隔离。"
        )
    if backend == "remote" and not service_url:
        raise RuntimeError("EMBEDDING_BACKEND=remote 但未设置 EMBEDDING_SERVICE_URL")

    pool_min = int(os.environ.get("POOL_MIN", "5"))
    pool_max = int(os.environ.get("POOL_MAX", "10"))
    if pool_min < 1 or pool_max < pool_min:
        raise RuntimeError(f"连接池参数非法：POOL_MIN={pool_min} POOL_MAX={pool_max}")

    return Config(
        database_url=url,
        init_statements=tuple(stmts),
        expected_ef_search=ef,
        expected_iterative_scan=iscan,
        pool_min=pool_min,
        pool_max=pool_max,
        top_k_default=int(os.environ.get("TOP_K_DEFAULT", "10")),
        top_k_max=int(os.environ.get("TOP_K_MAX", "50")),
        max_query_chars=int(os.environ.get("MAX_QUERY_CHARS", "500")),
        embed_backend=backend,
        embed_model=os.environ.get("EMBED_MODEL", "BAAI/bge-m3"),
        embed_dim=int(os.environ.get("EMBED_DIM", "1024")),
        embedding_service_url=service_url,
        explain_sample_rate=float(os.environ.get("EXPLAIN_SAMPLE_RATE", "0.01")),
        host=os.environ.get("API_HOST", "127.0.0.1"),
        port=int(os.environ.get("API_PORT", "8000")),
        paths={
            "init_sql": str(INIT_SQL_PATH),
            "query_set": str(QUERY_SET_PATH),
            "vector_cache": str(VECTOR_CACHE_PATH),
        },
    )
