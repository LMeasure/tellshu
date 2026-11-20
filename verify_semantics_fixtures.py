#!/usr/bin/env python3
"""
真实失败样例 / 变异测试（mutation testing）· 只读，零外部依赖

任务书 §五.8 要求：「新增断言必须有真实失败样例，证明它能够抓住对应缺陷」。

做法：
  1. 读取真实 stage_evidence_registry.json 与真实文件文本 → 构造 ctx
  2. 对注册表做【深拷贝】，注入一个明确定义的缺陷（mutator）
  3. 用与生产校验器【完全相同】的 semantic_assertions() 跑该变异副本
  4. 断言：目标断言在缺陷副本上 FAIL（抓到了），在修复后的正本上 PASS
  5. 输出「修复前 FAIL / 修复后 PASS」对照；任一 mutator 未被抓住 → exit 1

本脚本【不】写任何文件，【不】连接 PG/R2，【不】执行 SQL。
所有变异只在内存中发生，磁盘上的注册表与交付物不受影响。

用法：
  python verify_semantics_fixtures.py
  python verify_semantics_fixtures.py --json
退出码：0 = 全部变异均被抓住；1 = 存在漏检
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import verify_stage_semantics as V  # noqa: E402


def mutate_lock_blocking_to_deadlock(d: dict) -> None:
    """缺陷1：把普通阻塞(LW-02) 错写成死锁 + 两者回滚（旧报告的真实错误）"""
    s = next(x for x in d["semantic_audit"]["wp02_lock_model"]["scenarios"]
             if x["id"] == "LW-02")
    s["outcome"] = "deadlock"
    s["has_cycle"] = True
    s["whole_tx_rollback"] = True


def mutate_deadlock_two_aborts(d: dict) -> None:
    """缺陷2：把真死锁写成『两者均回滚』（旧报告的真实错误）"""
    s = next(x for x in d["semantic_audit"]["wp02_lock_model"]["scenarios"]
             if x["id"] == "LW-03")
    s["winner"] = "两者均完整回滚"


def mutate_lock_timeout_as_deadlock(d: dict) -> None:
    """缺陷3：把 lock_timeout 写成整事务回滚的死锁"""
    s = next(x for x in d["semantic_audit"]["wp02_lock_model"]["scenarios"]
             if x["id"] == "LW-04")
    s["outcome"] = "deadlock"
    s["whole_tx_rollback"] = True


def mutate_deadlock_timeout_as_timeout(d: dict) -> None:
    """缺陷4：把 deadlock_timeout 写成超时上限"""
    s = next(x for x in d["semantic_audit"]["wp02_lock_model"]["scenarios"]
             if x["id"] == "LW-05")
    s["outcome"] = "lock_timeout"


def mutate_trg01_strict_cas(d: dict) -> None:
    """缺陷5：TRG-01 退回 INTO STRICT 非幂等方案（六通道不可达）"""
    t = next(x for x in d["semantic_audit"]["wp02_sql_semantic_audit"]["triggers"]
             if x["id"] == "TRG-01" and "幂等" in x["fix"])
    t["fix"] = "UPDATE ... WHERE state='created' RETURNING INTO STRICT"


def mutate_drop_p0_finding(d: dict) -> None:
    """缺陷6：删除 findings_summary.P0 中的一条（验证计数断言）"""
    f = d["semantic_audit"]["wp02_sql_semantic_audit"]["findings_summary"]["P0"]
    f.pop()


def mutate_drop_p0_trigger(d: dict) -> None:
    """缺陷20：删除 triggers 中一条 P0 缺陷（验证编号/严重度登记断言）"""
    ts = d["semantic_audit"]["wp02_sql_semantic_audit"]["triggers"]
    idx = next(i for i, t in enumerate(ts) if t.get("issue", "").startswith("P0"))
    ts.pop(idx)


def mutate_A_enum_synonym(d: dict) -> None:
    """缺陷7：A 枚举引入同义别名（枚举混用）"""
    d["semantic_audit"]["wp03_evidence_taxonomy"]["dimension_A"]["enum"].append("partial")


def mutate_probe_bad_B(d: dict) -> None:
    """缺陷8：某探针的 B 维值越出权威枚举"""
    d["semantic_audit"]["wp03_evidence_taxonomy"]["probe_matrix"][0]["dimension_B"] = "maybe_test"


def mutate_legacy_drift_undeclared(d: dict) -> None:
    """缺陷9：删掉一条已登记的枚举漂移"""
    d["semantic_audit"]["wp03_evidence_taxonomy"]["legacy_semantic_drift"].pop()


def mutate_rewrite_legacy_classification(d: dict) -> None:
    """缺陷10：改写历史 classification 字段以掩盖漂移"""
    d["wp03_probes"][3]["classification"] = "not_guaranteed"


def mutate_T_as_backup_intrinsic(d: dict) -> None:
    """缺陷11：把 recovery_target_lsn 说成备份固有属性"""
    for a in d["semantic_audit"]["wp04_manifest_ownership"]["answers"]:
        if "recovery_target_lsn" in a["q"]:
            a["a"] = "是，T 属于备份固有属性"
    d["semantic_audit"]["wp04_manifest_ownership"]["correction"]["manifest_remove"] = []


def mutate_recovery_runs_cardinality(d: dict) -> None:
    """缺陷12：把 1:N 改回 1:1（同一备份不能多次恢复）"""
    d["semantic_audit"]["wp04_manifest_ownership"]["correction"]["recovery_runs_table"]["cardinality"] = "1 : 1"


def mutate_fi_matched_by_id_only(d: dict) -> None:
    """缺陷13：凭编号相同把错配项标成 matched（三要素实际不匹配）"""
    m = next(x for x in d["semantic_audit"]["wp04_fi_semantic_coverage"]["matrix"]
             if x["id"] == "CK-03")
    m["legacy_verdict"] = "matched"


def mutate_fi_subcase_counted(d: dict) -> None:
    """缺陷14：把新增细化子用例计入 215 父项（破坏计数口径）"""
    d["semantic_audit"]["wp04_fi_semantic_coverage"]["new_subcases"][0]["counted_in_parent_215"] = True


def mutate_delete_fi_parent(d: dict) -> None:
    """缺陷15：删除一条 215 主台账项"""
    d["fault_injections_215"].pop()


def mutate_fi_unresolvable_ref(d: dict) -> None:
    """缺陷16：语义引用指向不存在的 FI"""
    m = next(x for x in d["semantic_audit"]["wp04_fi_semantic_coverage"]["matrix"]
             if x["id"] == "CK-01")
    m["semantic_refs"] = ["FI-DOES-NOT-EXIST"]


def mutate_admission_upgrade(d: dict) -> None:
    """缺陷17：擅自把 L4 PG 验证标为已通过"""
    d["maturity_levels"]["L4_pg_verified"] = True


def mutate_sql_placeholder_grant(d: dict, ctx: dict) -> None:
    """缺陷18：设计资产中 GRANT 行退回未具名占位符"""
    ctx["sql_v3"] = ctx["sql_v3"].replace(
        "TO shutree_terminality_exec;", "TO <专用角色>;")


def mutate_sql_path_reverse_order(d: dict, ctx: dict) -> None:
    """缺陷19：某写路径锁顺序逆序（会形成死锁环）"""
    ctx["sql_v3"] = ctx["sql_v3"].replace(
        "-- PATH T-REQUEUE          : LO-0 → LO-1 → LO-2 → LO-3(只读) → LO-4",
        "-- PATH T-REQUEUE          : LO-2 → LO-1 → LO-0 → LO-3(只读) → LO-4")


def mutate_wp03_atomic_counts_wrong(d: dict) -> None:
    """缺陷21：原子能力模型自报计数与实测不符（跨交付物不一致）"""
    d["semantic_audit"]["wp03_evidence_taxonomy"]["atomic_capability_model"]["counts"]["atomic_total"] = 41


def mutate_wp03_drop_caps(d: dict) -> None:
    """缺陷22：抹掉某探针的 capability_assertions（原子粒度丢失）"""
    d["wp03_probes"][0]["capability_assertions"] = []


def mutate_wp03_derive_wrong(d: dict) -> None:
    """缺陷23：篡改某探针 overall_derived 的派生 A 维（派生不一致）"""
    d["wp03_probes"][0]["overall_derived"]["dimension_A_evidence_nature"] = "officially_unimplemented"


def mutate_wp03_drop_unstated_rule(d: dict) -> None:
    """缺陷24：删除『未说明不等于未实现』纪律声明"""
    acm = d["semantic_audit"]["wp03_evidence_taxonomy"]["atomic_capability_model"]
    acm.pop("unstated_not_unimplemented", None)


def mutate_wp03_collapse_caps(d: dict) -> None:
    """缺陷25：把多能力探针压缩成单能力（破坏多能力不压缩）"""
    p = next(p for p in d["wp03_probes"] if len(p.get("capability_assertions", [])) > 1)
    p["capability_assertions"] = [p["capability_assertions"][0]]


def mutate_wp03_collapse_derived(d: dict) -> None:
    """缺陷25b：把多能力探针的派生 atomic_classes 压缩成单值（派生视图丢失粒度）"""
    p = next(p for p in d["wp03_probes"] if len(p.get("capability_assertions", [])) > 1)
    od = p.setdefault("overall_derived", {})
    cls = {c.get("official_evidence_class") for c in p["capability_assertions"]}
    od["atomic_classes"] = [next(iter(cls))]


def mutate_wp03_blank_limitation(d: dict) -> None:
    """缺陷26：抹掉 conditionally_supported 能力的 limitation（掩盖限制）"""
    for p in d["wp03_probes"]:
        for c in p.get("capability_assertions", []):
            if c.get("official_evidence_class") == "conditionally_supported":
                c["limitation"] = ""
                return


def mutate_wp03_drop_legacy(d: dict) -> None:
    """缺陷27：删除『保留历史 classification』纪律声明（掩盖漂移）"""
    acm = d["semantic_audit"]["wp03_evidence_taxonomy"]["atomic_capability_model"]
    acm.pop("keep_legacy", None)


def mutate_fis06_r2_false(d: dict) -> None:
    """缺陷28：FI-S-06 的 needs_r2 错标为 false（R2 操作漏标）"""
    subs = d["semantic_audit"]["wp04_fi_semantic_coverage"]["new_subcases"]
    next(s for s in subs if s["id"] == "FI-S-06")["needs_r2"] = False


def mutate_fis_purepg_r2_true(d: dict) -> None:
    """缺陷29：纯 PG 的 FI-S-01 错标 needs_r2=true（PG 操作误标 R2）"""
    subs = d["semantic_audit"]["wp04_fi_semantic_coverage"]["new_subcases"]
    next(s for s in subs if s["id"] == "FI-S-01")["needs_r2"] = True


def mutate_rr_reinsert_fk(d: dict, ctx: dict) -> None:
    """缺陷30：重新插入虚构跨库物理 FK"""
    ctx["sql_v3"] += "\n--     manifest_id uuid NOT NULL REFERENCES shutree_sec.backup_manifests(manifest_id),"


def mutate_rr_remove_logical(d: dict, ctx: dict) -> None:
    """缺陷31：删除逻辑引用/内容摘要列"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("manifest_content_sha256", "manifest_digest_removed")


def mutate_rr_remove_verify_fn(d: dict, ctx: dict) -> None:
    """缺陷32：删除跨库独立核验函数（外部库不可用处理缺失）"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("sp_verify_recovery_manifest", "sp_verify_removed")


def mutate_trg01_drop_channel_count(d: dict, ctx: dict) -> None:
    """缺陷33：删除六通道 COUNT(DISTINCT channel)=6 判定（并发可达性破坏）"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("count(DISTINCT r.channel)", "count(1)")


def mutate_trg01_drop_consumable_atomic(d: dict, ctx: dict) -> None:
    """缺陷34：删除 consumable 原子推进条件"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("IF v_channels = 6 THEN", "IF 1=1 THEN")


def mutate_wp03_no_coexist(d: dict) -> None:
    """缺陷35：抹掉『官方支持 + 必须实测可同时成立』的全部实例"""
    for p in d["wp03_probes"]:
        od = p.setdefault("overall_derived", {})
        od["dimension_B_verification_requirement"] = "official_evidence_only"


def mutate_cdb_same_db(d: dict) -> None:
    """缺陷36：把 recovery_runs 与 backup_manifests 放在同一库（违反跨库隔离）"""
    arch = d["semantic_audit"]["wp02_cross_db_verification"]["arch"]
    arch["recovery_runs_location"] = arch["backup_manifests_location"]


def mutate_cdb_plain_query(d: dict) -> None:
    """缺陷37：恢复成『PG 普通函数直查另一库』假设"""
    d["semantic_audit"]["wp02_cross_db_verification"]["arch"]["no_plain_pg_cross_db_query"] = False


def mutate_cdb_initiator_pg(d: dict) -> None:
    """缺陷38：跨库请求发起方错写成 PG 触发器"""
    d["semantic_audit"]["wp02_cross_db_verification"]["arch"]["initiator"] = "pg_trigger"


def mutate_cdb_failopen(d: dict) -> None:
    """缺陷39：网络失败被写成可继续成功（fail-open）"""
    d["semantic_audit"]["wp02_cross_db_verification"]["arch"]["network_failure_handling"] = "proceed_success"


def mutate_cdb_drop_keyversion(d: dict) -> None:
    """缺陷40：从协议字段删除 key_version（密钥轮换信息缺失）"""
    d["semantic_audit"]["wp02_cross_db_verification"]["protocol_fields"].remove("key_version")


def mutate_cdb_conflate_sig(d: dict) -> None:
    """缺陷41：把非对称签名与 HMAC 混为同一机制（四者区分被破坏）"""
    fw = d["semantic_audit"]["wp02_cross_db_verification"]["four_way_distinction"]
    fw["asymmetric_signature"] = fw["hmac"]


def mutate_cdb_binding(d: dict) -> None:
    """缺陷42：移除 recovery_run_id 绑定（字段绑定不完整）"""
    d["semantic_audit"]["wp02_cross_db_verification"]["binding_fields"].remove("recovery_run_id")


def mutate_cdb_drop_scenario(d: dict) -> None:
    """缺陷43：删减一条跨库场景（不足 13）"""
    d["semantic_audit"]["wp02_cross_db_verification"]["scenarios_13"].pop()


def mutate_cdb_auto_success(d: dict) -> None:
    """缺陷44：把未知态标记为非终态可自动转 success 的开关关闭"""
    d["semantic_audit"]["wp02_cross_db_verification"]["unknown_stays_non_success"] = False


def mutate_trg01_rowlock_none(d: dict) -> None:
    """缺陷45：删除行锁归属（槽位行锁未命名）"""
    d["semantic_audit"]["trg01_concurrency_proof"]["transaction_model"]["row_lock"] = None


def mutate_trg01_serializable(d: dict) -> None:
    """缺陷46：并发正确性改为依赖 SERIALIZABLE（弱化 READ COMMITTED 证明）"""
    d["semantic_audit"]["trg01_concurrency_proof"]["transaction_model"]["relies_on_serializable"] = True


def mutate_trg01_no_serial_point(d: dict) -> None:
    """缺陷47：抹掉串行化点声明"""
    d["semantic_audit"]["trg01_concurrency_proof"]["transaction_model"]["serialization_point"] = ""


def mutate_trg01_drop_timeline(d: dict) -> None:
    """缺陷48：删减一条并发时间线（不足 10）"""
    d["semantic_audit"]["trg01_concurrency_proof"]["ten_timelines"].pop()


def mutate_trg01_timeline_missing_field(d: dict) -> None:
    """缺陷49：删掉某时间线的 commit_or_rollback 字段"""
    d["semantic_audit"]["trg01_concurrency_proof"]["ten_timelines"][0].pop("commit_or_rollback", None)


def mutate_sql_reinsert_crossdb(d: dict, ctx: dict) -> None:
    """缺陷50：重新插入『PG 普通函数直查另一库』语句"""
    ctx["sql_v3"] += "\n--     FROM audit_store.backup_manifests m"


def mutate_sql_drop_dbb(d: dict, ctx: dict) -> None:
    """缺陷51：删除 DB-B 部署位置标记"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("DB-B", "DB-X-MISSING")


def _cdb(d: dict) -> dict:
    return d["semantic_audit"]["wp02_cross_db_verification"]


def _tr(d: dict) -> dict:
    return d["semantic_audit"]["trg01_concurrency_proof"]


def mutate_cdb_method_back_to_dual(d: dict) -> None:
    """缺陷52：跨库方案退回『二选一』（R8 已定案唯一=Worker）"""
    _cdb(d)["arch"]["cross_db_access_method"] = "controlled_fdw_or_control_plane_worker"


def mutate_cdb_flags_false(d: dict) -> None:
    """缺陷53：抹掉唯一方案/禁用 FDW 标志"""
    a = _cdb(d)["arch"]
    a["access_method_unique"] = False
    a["fdw_not_used_as_cross_db_mechanism"] = False


def mutate_cdb_drop_proto_version(d: dict) -> None:
    """缺陷54：删除协议版本字段"""
    _cdb(d).pop("protocol_version", None)


def mutate_cdb_req_bind_false(d: dict) -> None:
    """缺陷55：关闭请求绑定（request_id/request_ts 非必需）"""
    _cdb(d)["request_binding"]["request_id_required"] = False


def mutate_cdb_auth_orthogonal_false(d: dict) -> None:
    """缺陷56：身份认证不再声明与 ①②③ 正交"""
    _cdb(d)["auth_identity_independent"]["orthogonal_to_123"] = False


def mutate_cdb_signed_drop_one(d: dict) -> None:
    """缺陷57：签名覆盖字段少一项（8→7）"""
    _cdb(d)["signed_fields_covered"].remove("protocol_version")


def mutate_cdb_mac_drop_one(d: dict) -> None:
    """缺陷58：MAC 覆盖字段少一项（8→7）"""
    _cdb(d)["mac_covered_fields"].remove("actual_stop_lsn")


def mutate_cdb_sig_not_asymmetric(d: dict) -> None:
    """缺陷59：签名不再声明为非对称（易与 HMAC 混用）"""
    _cdb(d)["manifest_signature_is_asymmetric"] = False


def mutate_cdb_key_rotation_false(d: dict) -> None:
    """缺陷60：关闭历史密钥验证（轮换后旧记录被误判）"""
    _cdb(d)["key_rotation"]["historical_key_validation"] = False


def mutate_cdb_replay_false(d: dict) -> None:
    """缺陷61：关闭重试幂等"""
    _cdb(d)["replay_protection"]["idempotent_on_retry"] = False


def mutate_cdb_toctou_false(d: dict) -> None:
    """缺陷62：关闭绑定不可变（TOCTOU 防范失效）"""
    _cdb(d)["toctou_protection"]["binding_immutable"] = False


def mutate_cdb_audit_false(d: dict) -> None:
    """缺陷63：关闭审计记录强制"""
    _cdb(d)["audit_log_required"] = False


def mutate_cdb_fault_pop(d: dict) -> None:
    """缺陷64：故障语义不足 12 项"""
    _cdb(d)["fault_semantics_12"].pop()


def mutate_cdb_fault_auto_success(d: dict) -> None:
    """缺陷65：某故障可自动转 success（违反未知态不自动成功）"""
    _cdb(d)["fault_semantics_12"][0]["never_auto_success"] = False


def mutate_trg01_drop_sql_proof(d: dict) -> None:
    """缺陷66：删除 SQL 级证明（退回文字推演）"""
    _tr(d).pop("sql_level_proof", None)


def mutate_trg01_lock_paths_pop(d: dict) -> None:
    """缺陷67：删减一条锁与并发路径（不足 10）"""
    _tr(d)["lock_concurrency_paths_10"].pop()


def mutate_trg01_invariants_pop(d: dict) -> None:
    """缺陷68：删减一条最终不变量（不足 7）"""
    _tr(d)["final_invariants_7"].pop()


def mutate_sql_drop_unique_worker(d: dict, ctx: dict) -> None:
    """缺陷69：SQL 文本不再声明唯一方案（控制平面 Worker）"""
    ctx["sql_v3"] = ctx["sql_v3"].replace("唯一方案：控制平面 Worker", "唯一方案：待定")


def mutate_sql_reintro_dual(d: dict, ctx: dict) -> None:
    """缺陷70：SQL 文本重新引入『二选一』+ FDW 作为机制"""
    ctx["sql_v3"] = ctx["sql_v3"].replace(
        "【唯一方案：控制平面 Worker（禁止 FDW 作为跨库机制",
        "【受控 FDW 或独立 Worker 二选一（不得用 PG 普通函数直查")


def mutate_sql_drop_ten_dim(d: dict, ctx: dict) -> None:
    """缺陷71：删除十维度选型对比（唯一方案未论证）"""
    ctx["sql_v3"] = (ctx["sql_v3"]
        .replace("十维度选型对比", "选型对比")
        .replace("控制平面 Worker（推荐）", "控制平面 Worker")
        .replace("受控 postgres_fdw（不采用）", "受控 postgres_fdw"))


MUTATORS = [
    ("M-01", "LW-02 普通阻塞被写成死锁", mutate_lock_blocking_to_deadlock,
     ["sem/lock_LW02_is_blocking_not_deadlock", "sem/lock_LW02_no_whole_tx_rollback"]),
    ("M-02", "真死锁写成两者均回滚", mutate_deadlock_two_aborts,
     ["sem/lock_deadlock_single_abort"]),
    ("M-03", "lock_timeout 写成整事务死锁", mutate_lock_timeout_as_deadlock,
     ["sem/lock_timeout_is_statement_level"]),
    ("M-04", "deadlock_timeout 写成超时上限", mutate_deadlock_timeout_as_timeout,
     ["sem/deadlock_timeout_is_detection_interval"]),
    ("M-05", "TRG-01 退回非幂等 INTO STRICT", mutate_trg01_strict_cas,
     ["sem/sql_trg01_idempotent_fix"]),
    ("M-06", "删除 findings_summary.P0 一条", mutate_drop_p0_finding,
     ["sem/sql_findings_p0_count"]),
    ("M-07", "A 枚举引入同义别名 partial", mutate_A_enum_synonym,
     ["sem/wp03_A_enum_exact", "sem/wp03_enum_no_synonym_mix"]),
    ("M-08", "探针 B 维值越出权威枚举", mutate_probe_bad_B,
     ["sem/wp03_all_B_in_enum"]),
    ("M-09", "删除一条已登记枚举漂移", mutate_legacy_drift_undeclared,
     ["sem/wp03_drift_all_declared"]),
    ("M-10", "改写历史 classification 掩盖漂移", mutate_rewrite_legacy_classification,
     ["sem/wp03_no_rewrite_of_legacy"]),
    ("M-11", "T 被写成备份固有属性", mutate_T_as_backup_intrinsic,
     ["sem/manifest_T_not_backup_intrinsic", "sem/manifest_remove_T_column"]),
    ("M-12", "recovery_runs 退回 1:1", mutate_recovery_runs_cardinality,
     ["sem/recovery_runs_1_to_N"]),
    ("M-13", "CK-03 凭编号判 matched", mutate_fi_matched_by_id_only,
     ["sem/fi_matched_iff_three_checks"]),
    ("M-14", "新增子用例计入 215 父项", mutate_fi_subcase_counted,
     ["sem/fi_subcases_not_counted"]),
    ("M-15", "删除一条 215 主台账 FI", mutate_delete_fi_parent,
     ["sem/fi_parent_count_unchanged"]),
    ("M-16", "语义引用指向不存在的 FI", mutate_fi_unresolvable_ref,
     ["sem/fi_all_refs_resolvable"]),
    ("M-17", "擅自升级 L4 PG 验证", mutate_admission_upgrade,
     ["sem/maturity_no_upgrade"]),
    ("M-18", "GRANT 行退回占位符", mutate_sql_placeholder_grant,
     ["sem/sql_v3_grants_named_roles"]),
    ("M-19", "写路径锁顺序逆序", mutate_sql_path_reverse_order,
     ["sem/lock_paths_monotonic", "sem/lock_paths_start_lo0"]),
    ("M-20", "删除 triggers 中一条 P0 缺陷", mutate_drop_p0_trigger,
     ["sem/sql_p0_findings_declared"]),
    ("M-21", "原子能力模型自报计数与实测不符", mutate_wp03_atomic_counts_wrong,
     ["sem/wp03_atomic_model_present", "sem/wp03_counts_cross_consistent"]),
    ("M-22", "抹掉某探针 capability_assertions", mutate_wp03_drop_caps,
     ["sem/wp03_probes_have_caps", "sem/wp03_atomic_total_40"]),
    ("M-23", "篡改 overall_derived 派生 A 维", mutate_wp03_derive_wrong,
     ["sem/wp03_derive_A_B_consistent"]),
    ("M-24", "删除未说明不等于未实现纪律", mutate_wp03_drop_unstated_rule,
     ["sem/wp03_unstated_ne_unimplemented"]),
    ("M-25", "压缩多能力探针为单能力", mutate_wp03_collapse_caps,
     ["sem/wp03_multi_cap_count"]),
    ("M-25b", "派生 atomic_classes 压缩成单值", mutate_wp03_collapse_derived,
     ["sem/wp03_multi_cap_not_collapsed"]),
    ("M-26", "抹掉 conditionally_supported limitation", mutate_wp03_blank_limitation,
     ["sem/wp03_conditional_keeps_limitation"]),
    ("M-27", "删除历史 legacy_classification", mutate_wp03_drop_legacy,
     ["sem/wp03_keep_legacy"]),
    ("M-28", "FI-S-06 needs_r2 错标 false", mutate_fis06_r2_false,
     ["sem/fi_s_06_07_r2"]),
    ("M-29", "纯 PG 的 FI-S-01 误标 needs_r2 true", mutate_fis_purepg_r2_true,
     ["sem/fi_s_pure_pg"]),
    ("M-30", "重插虚构跨库物理 FK", mutate_rr_reinsert_fk,
     ["sem/recovery_runs_no_physical_fk"]),
    ("M-31", "删除逻辑引用/内容摘要列", mutate_rr_remove_logical,
     ["sem/recovery_runs_logical_ref"]),
    ("M-32", "删除跨库独立核验函数", mutate_rr_remove_verify_fn,
     ["sem/recovery_runs_verify_fn"]),
    ("M-33", "删除六通道计数判定", mutate_trg01_drop_channel_count,
     ["sem/trg01_dual_branch_idempotent"]),
    ("M-34", "删除 consumable 原子推进", mutate_trg01_drop_consumable_atomic,
     ["sem/trg01_consumable_atomic"]),
    ("M-35", "抹掉支持+实测共存实例", mutate_wp03_no_coexist,
     ["sem/wp03_supported_and_test_coexist"]),
    ("M-36", "recovery_runs 与 manifest 同库", mutate_cdb_same_db,
     ["sem/cdb_arch_two_db_explicit", "sem/cdb_arch_verify_fn_same_db_as_runs"]),
    ("M-37", "恢复 PG 普通函数直查假设", mutate_cdb_plain_query,
     ["sem/cdb_arch_no_plain_cross_db_query"]),
    ("M-38", "发起方错写成 PG 触发器", mutate_cdb_initiator_pg,
     ["sem/cdb_arch_initiator_named"]),
    ("M-39", "网络失败 fail-open", mutate_cdb_failopen,
     ["sem/cdb_arch_network_fail_no_failopen"]),
    ("M-40", "删 key_version", mutate_cdb_drop_keyversion,
     ["sem/cdb_proto_key_id_version_present", "sem/cdb_proto_fields_complete"]),
    ("M-41", "签名与 HMAC 混用", mutate_cdb_conflate_sig,
     ["sem/cdb_proto_four_way_distinct"]),
    ("M-42", "移除 recovery_run_id 绑定", mutate_cdb_binding,
     ["sem/cdb_proto_binding_complete"]),
    ("M-43", "删一条跨库场景", mutate_cdb_drop_scenario,
     ["sem/cdb_scenarios_13_count"]),
    ("M-44", "未知态自动成功开关关闭", mutate_cdb_auto_success,
     ["sem/cdb_scenarios_unknown_stays_pending"]),
    ("M-45", "删除行锁归属", mutate_trg01_rowlock_none,
     ["sem/trg01_txn_model_row_lock_named"]),
    ("M-46", "并发改依赖 SERIALIZABLE", mutate_trg01_serializable,
     ["sem/trg01_txn_model_not_serializable_dependent"]),
    ("M-47", "抹掉串行化点", mutate_trg01_no_serial_point,
     ["sem/trg01_txn_model_serialization_point"]),
    ("M-48", "删一条时间线", mutate_trg01_drop_timeline,
     ["sem/trg01_ten_timelines_count"]),
    ("M-49", "时间线缺 commit_or_rollback 字段", mutate_trg01_timeline_missing_field,
     ["sem/trg01_ten_timelines_each_has_fields"]),
    ("M-50", "重插跨库直查语句", mutate_sql_reinsert_crossdb,
     ["sem/cdb_sql_no_plain_cross_db_query"]),
    ("M-51", "删除 DB-B 标记", mutate_sql_drop_dbb,
     ["sem/cdb_sql_arch_positions"]),
    ("M-52", "跨库方案退回二选一", mutate_cdb_method_back_to_dual,
     ["sem/cdb_arch_unique_worker", "sem/cdb_arch_no_fdw_option"]),
    ("M-53", "抹掉唯一方案/禁用FDW标志", mutate_cdb_flags_false,
     ["sem/cdb_arch_flags_present"]),
    ("M-54", "删除协议版本字段", mutate_cdb_drop_proto_version,
     ["sem/cdb_proto_version_present"]),
    ("M-55", "关闭请求绑定", mutate_cdb_req_bind_false,
     ["sem/cdb_request_binding_required"]),
    ("M-56", "身份认证不再正交", mutate_cdb_auth_orthogonal_false,
     ["sem/cdb_auth_identity_independent"]),
    ("M-57", "签名覆盖字段少一项", mutate_cdb_signed_drop_one,
     ["sem/cdb_signed_fields_covered_8"]),
    ("M-58", "MAC 覆盖字段少一项", mutate_cdb_mac_drop_one,
     ["sem/cdb_mac_fields_covered_8"]),
    ("M-59", "签名不再非对称", mutate_cdb_sig_not_asymmetric,
     ["sem/cdb_hmac_not_called_signature"]),
    ("M-60", "关闭历史密钥验证", mutate_cdb_key_rotation_false,
     ["sem/cdb_key_rotation_complete"]),
    ("M-61", "关闭重试幂等", mutate_cdb_replay_false,
     ["sem/cdb_replay_protection"]),
    ("M-62", "关闭绑定不可变", mutate_cdb_toctou_false,
     ["sem/cdb_toctou_protection"]),
    ("M-63", "关闭审计强制", mutate_cdb_audit_false,
     ["sem/cdb_audit_log_required"]),
    ("M-64", "故障语义不足12项", mutate_cdb_fault_pop,
     ["sem/cdb_fault_semantics_12_count"]),
    ("M-65", "某故障可自动转success", mutate_cdb_fault_auto_success,
     ["sem/cdb_fault_semantics_unknown_no_success"]),
    ("M-66", "删除SQL级证明", mutate_trg01_drop_sql_proof,
     ["sem/trg01_sql_proof_present"]),
    ("M-67", "删减锁并发路径", mutate_trg01_lock_paths_pop,
     ["sem/trg01_lock_paths_10"]),
    ("M-68", "删减最终不变量", mutate_trg01_invariants_pop,
     ["sem/trg01_invariants_7"]),
    ("M-69", "SQL不再声明唯一方案", mutate_sql_drop_unique_worker,
     ["sem/cdb_sql_unique_worker_stated"]),
    ("M-70", "SQL重引入二选一+FDW", mutate_sql_reintro_dual,
     ["sem/cdb_sql_no_fdw_mechanism", "sem/cdb_sql_unique_worker_stated"]),
    ("M-71", "删除十维度选型对比", mutate_sql_drop_ten_dim,
     ["sem/cdb_sql_ten_dimension_compare"]),
]


def run(base: dict, ctx: dict, mutator, expected: list[str]):
    d = copy.deepcopy(base)
    c = dict(ctx)
    if mutator.__code__.co_argcount == 2:
        mutator(d, c)
    else:
        mutator(d)
    rows = V.semantic_assertions(d, c)
    status = {n: ok for n, ok, _ in rows}
    caught = [n for n in expected if status.get(n) is False]
    missed = [n for n in expected if status.get(n) is not False]
    # 修复后（正本）这些断言必须全 PASS
    fixed = {n: ok for n, ok, _ in V.semantic_assertions(base, ctx)}
    fixed_ok = all(fixed.get(n) is True for n in expected)
    return caught, missed, fixed_ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    base = json.loads((ROOT / "stage_evidence_registry.json").read_text(encoding="utf-8"))
    ctx = V.build_ctx(base)

    results = []
    for mid, desc, mut, expected in MUTATORS:
        caught, missed, fixed_ok = run(base, ctx, mut, expected)
        results.append({"id": mid, "defect": desc,
                        "expected_assertions": expected,
                        "before_fix_caught": caught,
                        "before_fix_missed": missed,
                        "after_fix_all_pass": fixed_ok,
                        "verdict": "PASS" if not missed and fixed_ok else "FAIL"})

    passed = sum(1 for r in results if r["verdict"] == "PASS")
    if args.json:
        print(json.dumps({"total": len(results), "passed": passed,
                          "results": results}, ensure_ascii=False, indent=2))
    else:
        print("=" * 96)
        print("真实失败样例 / 变异测试：修复前 FAIL（断言抓住缺陷）→ 修复后 PASS")
        print("=" * 96)
        for r in results:
            flag = "PASS" if r["verdict"] == "PASS" else "FAIL"
            print(f"[{flag}] {r['id']} {r['defect']}")
            print(f"        修复前被抓断言 : {', '.join(r['before_fix_caught']) or '（无）'}")
            if r["before_fix_missed"]:
                print(f"        ★漏检断言     : {', '.join(r['before_fix_missed'])}")
            print(f"        修复后全通过   : {r['after_fix_all_pass']}")
        print("-" * 96)
        print(f"合计 {len(results)} 个真实缺陷样例，被抓住 {passed}，漏检 {len(results)-passed}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
