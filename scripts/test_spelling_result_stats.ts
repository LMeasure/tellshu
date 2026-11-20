/**
 * 单词默写 V2 · SpellingResult 结果页统计 · 专项自动化回归
 * ------------------------------------------------------------------
 * 覆盖用户点名的 7 类：active 统计、total 统计、reset 覆盖、stale 排除、
 * ORPHAN 异常提示、空数据状态、当前账号范围说明。
 * 另加：按词合并、双指标分别标注、不出现禁用文案、真实页面渲染断言所需文案常量。
 *
 * 说明：本文件测的是**领域层聚合与页面所依赖的数据契约**；
 * 真实 DOM 渲染断言由 scripts/check_spelling_v2_browser.mjs 在浏览器里执行，
 * 两者分别报告，不互相替代。
 *
 * 运行：npx tsx scripts/test_spelling_result_stats.ts
 */

import 'fake-indexeddb/auto'
import { storage } from '../src/services/storage'
import {
  loadSessionErrorStats,
  loadWrongWordBook,
} from '../src/domain/spellingErrorEvents'
import { STAT_LABELS, ACTIVE_CLASSES } from '../src/domain/spellingErrorStats'
import { aggregateWrongWordBook, collectCovered, type WrongBookEvent } from '../src/domain/spellingWrongBook'
import type { SpellingSession } from '../src/domain/spelling'
import type { SpellingErrorEvent } from '../src/domain/types'

let passed = 0
let failed = 0
const failures: string[] = []
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed += 1
    console.log('  ✓', msg)
  } else {
    failed += 1
    failures.push(msg)
    console.error('  ❌', msg)
  }
}
function eq<T>(a: T, b: T, msg: string): void {
  ok(a === b, `${msg}（期望 ${String(b)}，实际 ${String(a)}）`)
}
async function group(t: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${t}`)
  await fn()
}

const NOW = 1_700_000_000_000
const W1 = 'CET4:abandon'
const W2 = 'CET4:ability'
const SESSIONS = storage.table('spellingSessions')
const EVENTS = storage.table('spellingErrorEvents')

function session(id: string, over: Record<string, unknown> = {}): SpellingSession {
  return {
    id,
    type: 'spelling',
    owner: 'guest',
    status: 'IN_PROGRESS',
    selection_mode: 'recent',
    target_correct: 3,
    total_words: 2,
    current_position: 0,
    started_at: NOW,
    updated_at: NOW,
    queue: [],
    processed_requests: {},
    active_tab_id: 'tab-A',
    lock_epoch: 0,
    lock_held_at: NOW,
    ...over,
  } as SpellingSession
}

interface EventOpts {
  session_id?: string
  word_id?: string
  owner?: string
  lock_epoch?: number
  occurred_at?: number
  word_snapshot?: string
  covered_event_ids?: string[]
}

function ev(id: string, opts: EventOpts = {}): SpellingErrorEvent {
  return {
    event_id: id,
    owner: opts.owner ?? 'guest',
    word_id: opts.word_id ?? W1,
    session_id: opts.session_id ?? 's',
    kind: 'wrong',
    occurred_at: opts.occurred_at ?? NOW,
    status: 'settled',
    tab_id: 'tab-A',
    lock_epoch: opts.lock_epoch ?? 0,
    ...(opts.word_snapshot ? { word_snapshot: opts.word_snapshot } : {}),
    ...(opts.covered_event_ids ? { covered_event_ids: opts.covered_event_ids } : {}),
  } as unknown as SpellingErrorEvent
}

async function resetDb(): Promise<void> {
  await storage.clearAll()
}

async function run(): Promise<void> {
  console.log('▶ SpellingResult 结果页统计专项回归')
  await storage.open()

  /* 1. active 错词事件统计 */
  await group('1 · 当前活动错词事件数（active）', async () => {
    await resetDb()
    // 生产路径：事件行 settled 且同事务写入凭证 → classify 判 SETTLED_ZEROED
    await SESSIONS.put(
      session('s', { applied_error_event_ids: { a1: true, a2: true } }) as never,
    )
    await EVENTS.put(ev('a1', { session_id: 's' }) as never)
    await EVENTS.put(ev('a2', { session_id: 's', occurred_at: NOW + 10 }) as never)
    const st = await loadSessionErrorStats('s')
    eq(st.active_wrong_count, 2, 'active = 2（两条本代次事件）')
    eq(st.by_class.SETTLED_ZEROED, 2, '分类为 SETTLED_ZEROED（凭证优先）')
    eq(ACTIVE_CLASSES.length, 2, '仅两类计入 active')
  })

  /* 2. total 错词事件统计 */
  await group('2 · 历史错误事件行数（total）与分类解耦', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    await EVENTS.put(ev('t1', { session_id: 's' }) as never)
    await EVENTS.put(ev('t2', { session_id: 's', lock_epoch: 9 }) as never) // stale
    await EVENTS.put(ev('t3', { session_id: 's' }) as never)
    const st = await loadSessionErrorStats('s')
    eq(st.total_error_events, 3, 'total 恒等于事件行数（含 stale）')
    eq(st.active_wrong_count, 2, 'active 排除 stale')
    eq(st.by_class.PENDING_STALE, 1, 'stale 行单独分类')
    ok(st.total_error_events >= st.active_wrong_count, 'total 恒 ≥ active')
    ok(!STAT_LABELS.total.includes('拼错次数'), 'total 文案不含主观「拼错次数」')
    ok(!STAT_LABELS.active.includes('拼错次数'), 'active 文案不含主观「拼错次数」')
    ok(STAT_LABELS.active !== STAT_LABELS.total, '两个指标分别标注')
  })

  /* 3. reset 覆盖后统计 */
  await group('3 · reset 覆盖后 active 下降、total 不变', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    await EVENTS.put(ev('r1', { session_id: 's' }) as never)
    await EVENTS.put(ev('r2', { session_id: 's' }) as never)
    await EVENTS.put(
      ev('R1', { session_id: 's', covered_event_ids: ['r1'] }) as never,
    )
    const st = await loadSessionErrorStats('s')
    eq(st.by_class.COVERED, 1, '被覆盖事件判 COVERED')
    eq(st.active_wrong_count, 1, 'active 从 2 降到 1')
    eq(st.total_error_events, 2, 'total 仍为 2（reset 行不计入）')
    // 并集幂等：重复 reset 快照不扩大覆盖范围
    const rows = (await EVENTS.toArray()) as unknown as WrongBookEvent[]
    const covered = collectCovered([...rows, ...rows])
    eq(covered.size, 1, '重复快照并集幂等')
  })

  /* 4. stale 事件排除 */
  await group('4 · 旧代次 stale 事件从 active 排除但计入 total', async () => {
    await resetDb()
    await SESSIONS.put(session('s', { lock_epoch: 2 }) as never)
    await EVENTS.put(ev('cur', { session_id: 's', lock_epoch: 2 }) as never)
    await EVENTS.put(ev('old', { session_id: 's', lock_epoch: 1 }) as never)
    const st = await loadSessionErrorStats('s')
    eq(st.active_wrong_count, 1, '只算本代次')
    eq(st.total_error_events, 2, '历史行数含旧代次')
    eq(st.by_class.PENDING_STALE, 1, '旧代次判 PENDING_STALE')
    eq(st.by_class.PENDING_CURRENT, 1, '本代次判 PENDING_CURRENT')
    // 已写 'stale' 凭证的旧代次事件
    await SESSIONS.put({
      ...(await SESSIONS.get('s')),
      applied_error_event_ids: { old: 'stale' },
    } as never)
    const st2 = await loadSessionErrorStats('s')
    eq(st2.by_class.SETTLED_STALE, 1, 'stale 凭证判 SETTLED_STALE')
    eq(st2.active_wrong_count, 1, '凭证优先，active 不变')
  })

  /* 5. ORPHAN 异常提示 */
  await group('5 · 会话文档缺失 / 脏数据 → ORPHAN 与 UNCLASSIFIABLE 提示', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    await EVENTS.put(ev('ok', { session_id: 's' }) as never)
    const dirty = ev('dirty', { session_id: 's' }) as unknown as Record<string, unknown>
    delete dirty.lock_epoch
    await EVENTS.put(dirty as never)
    const st = await loadSessionErrorStats('s')
    eq(st.by_class.UNCLASSIFIABLE, 1, '代次字段缺失判 UNCLASSIFIABLE')
    eq(st.active_wrong_count, 1, '异常记录不计入 active')
    eq(st.total_error_events, 2, '本会话异常记录仍计入 total')
    ok(st.anomaly_count > 0, 'anomaly_count > 0 供 UI 提示')

    // ORPHAN 的正统场景（1.2.3 §2）：事件行按 session_id 精确读会话文档读不到。
    // 模拟「会话文档被物理删除 / clearAll 部分成功」，事件行仍在。
    await resetDb()
    await EVENTS.put(ev('orph1', { session_id: 's' }) as never)
    await EVENTS.put(ev('orph2', { session_id: 's' }) as never)
    const orphanStats = await loadSessionErrorStats('s')
    eq(orphanStats.by_class.ORPHAN, 2, '会话文档缺失 → 2 条判 ORPHAN')
    eq(orphanStats.active_wrong_count, 0, 'ORPHAN 不计入活动错词')
    eq(orphanStats.total_error_events, 2, 'ORPHAN 仍计入历史行数')
    const orphanBook = await loadWrongWordBook('s')
    eq(orphanBook.orphan_count, 2, '错词本也如实报出 ORPHAN 数量')
    ok(STAT_LABELS.orphan.includes('{n}'), 'ORPHAN 文案带数量占位符')
    ok(STAT_LABELS.orphan.includes('未计入活动错词'), 'ORPHAN 文案明确不计入活动错词')
  })

  /* 6. 空数据状态 */
  await group('6 · 空数据返回 0 / 空错词本，不编造数字', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    const st = await loadSessionErrorStats('s')
    eq(st.total_error_events, 0, '无事件时 total = 0')
    eq(st.active_wrong_count, 0, '无事件时 active = 0')
    const book = await loadWrongWordBook('s')
    eq(book.records.length, 0, '错词本为空数组')
    eq(book.total_error_events, 0, '错词本合计 = 0')
    eq(STAT_LABELS.empty, '本轮没有错词事件', '空态文案存在')
    const missing = await loadSessionErrorStats('no-such-session')
    eq(missing.total_error_events, 0, '会话不存在返回 0，不抛错')
    const missingBook = await loadWrongWordBook('no-such-session')
    eq(missingBook.records.length, 0, '会话不存在返回空错词本')
  })

  /* 7. 当前账号范围说明 */
  await group('7 · 当前账号范围说明与 owner 隔离', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    await EVENTS.put(ev('mine', { session_id: 's', owner: 'guest' }) as never)
    await EVENTS.put(ev('theirs', { session_id: 's', owner: 'other-user' }) as never)
    const st = await loadSessionErrorStats('s')
    eq(st.total_error_events, 1, '其它 owner 的行不混入统计')
    const book = await loadWrongWordBook('s')
    eq(book.owner, 'guest', '错词本标注当前账号')
    eq(book.total_error_events, 1, '错词本同样按 owner 过滤')
    ok(STAT_LABELS.ownerScope.includes('当前账号'), '文案带「当前账号」限定')
    ok(!STAT_LABELS.ownerScope.includes('全部历史'), '文案不表述成「全部历史记录」')
    ok(
      STAT_LABELS.note.includes('不代表主观「拼错次数」'),
      'note 明确否定「拼错次数」这一主观口径',
    )
  })

  /* 8. 按词合并（结果页错词本区块数据契约） */
  await group('8 · 结果页错词本按词合并、错误次数与最近时间', async () => {
    await resetDb()
    await SESSIONS.put(session('s') as never)
    await EVENTS.put(ev('w1a', { session_id: 's', word_id: W1, word_snapshot: 'abandon', occurred_at: NOW }) as never)
    await EVENTS.put(ev('w1b', { session_id: 's', word_id: W1, word_snapshot: 'abandon', occurred_at: NOW + 20 }) as never)
    await EVENTS.put(ev('w2a', { session_id: 's', word_id: W2, word_snapshot: 'ability', occurred_at: NOW + 10 }) as never)
    const book = await loadWrongWordBook('s')
    eq(book.records.length, 2, '两个词各合并成 1 条记录')
    const a = book.records.find((r) => r.word_id === W1)!
    eq(a.word, 'abandon', '词条快照来自事件行')
    eq(a.active_wrong_count, 2, '同词错误次数 = 错误字母数 2')
    eq(a.last_error_at, NOW + 20, '最近错误时间 = max(occurred_at)')
    eq(book.total_error_events, 3, '合计 3 行')
    eq(book.active_wrong_count, 3, '合计 active 3')
  })

  /* 9. 页面文案契约（供浏览器渲染断言对齐） */
  await group('9 · 页面文案契约（与浏览器断言共用同一常量）', async () => {
    ok(STAT_LABELS.active.length > 0 && STAT_LABELS.total.length > 0, '两个指标文案非空')
    ok(STAT_LABELS.note.includes('每个真实错误字母'), '口径说明含逐字母规则')
    ok(STAT_LABELS.excluded.includes('{n}'), '排除数量文案带占位符')
    ok(STAT_LABELS.orphan.includes('{n}'), '异常数量文案带占位符')
    ok(STAT_LABELS.ownerScope.length > 0, '账号范围文案存在')
    ok(!STAT_LABELS.active.includes('次'), '活动指标不用「次」作量词')
    ok(!STAT_LABELS.total.includes('次'), '历史指标不用「次」作量词')
  })

  console.log(`\n${'─'.repeat(64)}`)
  if (failed === 0) {
    console.log(`✅ 结果页统计专项全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ 结果页统计专项失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run().catch((err) => {
  console.error('❌ 测试执行异常', err)
  process.exit(1)
})
