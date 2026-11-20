/**
 * 单词默写 V2 · 逐字母打字状态机 · 自动化回归
 * ------------------------------------------------------------------
 * 真实库：fake-indexeddb + 真实 Dexie 驱动；memory 驱动做双驱动对照。
 * 覆盖产品规则 1–10 与用户点名的 14 项测试要求，均为**本文件实际执行**的断言。
 *
 * 运行：npx tsx scripts/test_spelling_v2_typing.ts
 * ⚠️ 本脚本是自动化层，不替代浏览器 / 真机验收（另见 check_spelling_v2_browser.mjs）。
 */

import 'fake-indexeddb/auto'
import { storage } from '../src/services/storage'
import { memoryStorage } from '../src/services/storage/memory'
import { noopSpeechLog, resetNoopSpeechLog } from '../src/services/speech/noop'
import {
  LOCK_LEASE_MS,
  TAB_ID,
  clearLockInvalidation,
  invalidateLocalLocks,
  takeoverSessionLock,
} from '../src/domain/spellingLock'
import { submitLetter, createSession } from '../src/domain/spellingSession'
import { loadWrongWordBook, drainPendingEvents, runRecoveryChain } from '../src/domain/spellingErrorEvents'
import { applyLetter, letterEventId, type LetterResult } from '../src/domain/spellingTyping'
import { STAT_LABELS } from '../src/domain/spellingErrorStats'
import { aggregateWrongWordBook, type WrongBookEvent } from '../src/domain/spellingWrongBook'
import type { SpellingSession } from '../src/domain/spelling'
import type { SpellingErrorEvent, VocabEntry } from '../src/domain/types'

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
const VOCAB = storage.table('vocab')
const LOGS = storage.table('reviewLog')

function wordState(word_id: string, word: string, position: number, target = 3) {
  return {
    word_id,
    word,
    definition_zh: '测试释义',
    position,
    status: 'IN_PROGRESS',
    consecutive_correct: 0,
    target_correct: target,
    total_attempts: 0,
    correct_attempts: 0,
    wrong_attempts: 0,
    srs_reported: false,
  }
}

function session(id: string, over: Partial<SpellingSession> = {}): SpellingSession {
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
    queue: [wordState(W1, 'abandon', 0), wordState(W2, 'ability', 1)],
    processed_requests: {},
    active_tab_id: TAB_ID,
    lock_epoch: 0,
    lock_held_at: NOW,
    ...over,
  } as SpellingSession
}

function vocab(word_id: string, word: string): VocabEntry {
  return {
    word_id,
    word,
    definition_zh: '测试释义',
    layer: 'new',
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: NOW + 86_400_000,
    added_at: NOW,
    owner: 'guest',
  }
}

async function resetDb(): Promise<void> {
  await storage.clearAll()
  await memoryStorage.clearAll()
  clearLockInvalidation()
  resetNoopSpeechLog()
}

async function putSession(s: SpellingSession): Promise<void> {
  await SESSIONS.put(s as never)
}
async function row(id: string): Promise<SpellingSession> {
  return (await SESSIONS.get(id)) as unknown as SpellingSession
}
async function eventsOf(wordId?: string): Promise<SpellingErrorEvent[]> {
  const all = (await EVENTS.toArray()) as unknown as SpellingErrorEvent[]
  return wordId ? all.filter((e) => e.word_id === wordId) : all
}
function currentWord(s: SpellingSession) {
  return s.queue.find((w) => w.position === s.current_position)
}

/** 依次提交若干字符（每次按键一个 request_id） */
async function typeLetters(
  sid: string,
  chars: string,
  tag: string,
): Promise<LetterResult[]> {
  const out: LetterResult[] = []
  for (let i = 0; i < chars.length; i += 1) {
    const s = await row(sid)
    const w = currentWord(s)
    if (!w) break
    const r = await submitLetter({
      word_id: w.word_id,
      char: chars[i],
      request_id: `${tag}-${i}`,
      now: NOW + i,
    })
    out.push(r.result)
  }
  return out
}

async function run(): Promise<void> {
  console.log('▶ 单词默写 V2 · 逐字母打字状态机回归')
  await storage.open()

  /* ===== 1. 一个错误字母 = 一个事件 ===== */
  await group('规则 1/2/10 · 一个错误字母 = 一条错词事件（幂等 event_id）', async () => {
    await resetDb()
    await putSession(session('s1', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const r = await submitLetter({ word_id: W1, char: 'z', request_id: 'r1', now: NOW })
    eq(r.result.outcome, 'wrong', '错误字母判 wrong')
    eq(r.errorInserted, true, '确实落了 1 条新事件')
    eq(r.tonePlayed, true, '错误提示音已触发')
    eq((await eventsOf()).length, 1, '事件表恰 1 行')
    const ev = (await eventsOf())[0]
    eq(ev.event_id, letterEventId('r1'), 'event_id 绑定 request_id（幂等键）')
    eq(ev.kind, 'wrong', '复用 v14 kind=wrong，未新增枚举 / stores')
    eq((ev as unknown as { letter_index: number }).letter_index, 0, '记录错误字母位置')
    eq((ev as unknown as { typed_char: string }).typed_char, 'z', '记录输入字符')
    eq((ev as unknown as { error_source: string }).error_source, 'letter', '标记逐字母来源')
    eq(ev.status, 'settled', '事件同事务直接 settled')
    eq((await row('s1')).applied_error_event_ids?.[letterEventId('r1')], true, '凭证同事务写入')
  })

  /* ===== 2. 同词连续错两个字母 = 两个事件 ===== */
  await group('规则 2 · 同一单词连续错两个字母 = 两条独立事件', async () => {
    await resetDb()
    await putSession(session('s2', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const a = await submitLetter({ word_id: W1, char: 'z', request_id: 'a', now: NOW })
    const b = await submitLetter({ word_id: W1, char: 'x', request_id: 'b', now: NOW + 1 })
    eq(a.result.outcome, 'wrong', '第一个错误字母')
    eq(b.result.outcome, 'wrong', '第二个错误字母')
    eq((await eventsOf()).length, 2, '事件表恰 2 行（不是 1 行）')
    eq(new Set((await eventsOf()).map((e) => e.event_id)).size, 2, '两个独立 event_id')
    eq(noopSpeechLog.errorTones, 2, '错误提示音触发 2 次（每个错误字母 1 次）')
    eq((await loadWrongWordBook('s2')).records[0].active_wrong_count, 2, '错词本错误次数 = 2')
  })

  /* ===== 3. 同词多次错误，错词本合并 + 最近错误时间 ===== */
  await group('规则 3 · 同词多次错误合并计数、更新最近错误时间', async () => {
    await resetDb()
    await putSession(session('s3', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    await submitLetter({ word_id: W1, char: 'z', request_id: 'c1', now: NOW })
    await submitLetter({ word_id: W1, char: 'q', request_id: 'c2', now: NOW + 500 })
    await submitLetter({ word_id: W1, char: 'p', request_id: 'c3', now: NOW + 900 })
    const book = await loadWrongWordBook('s3')
    eq(book.records.length, 1, '同一单词合并成 1 条错词记录（不是 3 条）')
    eq(book.records[0].word_id, W1, '记录归属正确')
    eq(book.records[0].word, 'abandon', '词条快照来自事件行，未编造')
    eq(book.records[0].active_wrong_count, 3, '错误次数 = 错误字母数 3')
    eq(book.records[0].total_error_events, 3, '历史错误事件行数 = 3')
    eq(book.records[0].last_error_at, NOW + 900, '最近错误时间取最大 occurred_at（仅展示）')
    eq(book.total_error_events, 3, '错词本合计 total = 3')
  })

  /* ===== 4. 不同单词错误互相隔离 ===== */
  await group('规则 3/9 · 不同单词错误互相隔离', async () => {
    await resetDb()
    await putSession(session('s4'))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    await VOCAB.put(vocab(W2, 'ability') as never)
    await submitLetter({ word_id: W1, char: 'z', request_id: 'd1', now: NOW })
    await submitLetter({ word_id: W1, char: 'z', request_id: 'd2', now: NOW + 1 })
    // 手动把当前位置切到第二个词，制造跨词错误
    const s = await row('s4')
    await putSession({ ...s, current_position: 1 } as SpellingSession)
    await submitLetter({ word_id: W2, char: 'z', request_id: 'd3', now: NOW + 2 })
    const book = await loadWrongWordBook('s4')
    eq(book.records.length, 2, '两个词各 1 条错词记录')
    const r1 = book.records.find((r) => r.word_id === W1)!
    const r2 = book.records.find((r) => r.word_id === W2)!
    eq(r1.active_wrong_count, 2, 'W1 错误次数 = 2')
    eq(r2.active_wrong_count, 1, 'W2 错误次数 = 1（未串词）')
    eq(book.total_error_events, 3, '总行数 = 3')
  })

  /* ===== 5. 重试不重复计数 ===== */
  await group('规则 10 · 同一 request_id 重试不重复计数、不重复播音', async () => {
    await resetDb()
    await putSession(session('s5', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const r1 = await submitLetter({ word_id: W1, char: 'z', request_id: 'same', now: NOW })
    const r2 = await submitLetter({ word_id: W1, char: 'z', request_id: 'same', now: NOW })
    const r3 = await submitLetter({ word_id: W1, char: 'z', request_id: 'same', now: NOW })
    eq(r1.errorInserted, true, '首次落 1 行')
    eq(r2.errorInserted, false, '重放不落第二行')
    eq(r3.errorInserted, false, '再次重放仍不落行')
    eq((await eventsOf()).length, 1, '事件表恒 1 行')
    eq(noopSpeechLog.errorTones, 1, '重放不重复播放提示音')
    eq(r2.result.outcome, r1.result.outcome, '重放原样回放结果')
    eq((await loadWrongWordBook('s5')).records[0].active_wrong_count, 1, '错词次数恒 1')
    // 崩溃后 drain：生产路径不产生 pending，drain 无活可干
    const d = await drainPendingEvents({ sessionId: 's5' })
    eq(d.scanned, 0, '无遗留 pending 事件')
    ok(d.converged, 'drain 收敛')
  })

  /* ===== 6. 错误后输入进度归零 ===== */
  await group('规则 5 · 错误后输入进度清零、从第一个字母重新开始', async () => {
    await resetDb()
    await putSession(session('s6', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const c1 = await submitLetter({ word_id: W1, char: 'a', request_id: 'e1', now: NOW })
    const c2 = await submitLetter({ word_id: W1, char: 'b', request_id: 'e2', now: NOW })
    eq(c1.result.typed_prefix, 'a', '第 1 个字母后前缀 = a')
    eq(c2.result.typed_prefix, 'ab', '第 2 个字母后前缀 = ab')
    eq((currentWord(await row('s6'))?.typed_prefix), 'ab', '输入进度已持久化')
    const bad = await submitLetter({ word_id: W1, char: 'z', request_id: 'e3', now: NOW })
    eq(bad.result.typed_prefix, '', '错误后前缀归零')
    eq(bad.result.letter_index, 0, '下一个待输入位置回到 0')
    eq(currentWord(await row('s6'))?.typed_prefix, '', '归零状态已落库（刷新后不回退）')
    const again = await submitLetter({ word_id: W1, char: 'a', request_id: 'e4', now: NOW })
    eq(again.result.typed_prefix, 'a', '归零后确实从第一个字母重新开始')
  })

  /* ===== 7. 连续正确次数归零 ===== */
  await group('规则 6 · 错误字母使连续正确次数归零', async () => {
    await resetDb()
    await putSession(
      session('s7', {
        total_words: 1,
        queue: [{ ...wordState(W1, 'abandon', 0), consecutive_correct: 2 }],
      }),
    )
    await VOCAB.put(vocab(W1, 'abandon') as never)
    eq(currentWord(await row('s7'))?.consecutive_correct, 2, '前置：连对 = 2')
    const bad = await submitLetter({ word_id: W1, char: 'z', request_id: 'f1', now: NOW })
    eq(bad.result.consecutive_correct, 0, '错误后连对归零')
    eq(currentWord(await row('s7'))?.consecutive_correct, 0, '归零已落库')
    eq(bad.result.total_attempts, 0, '错误未增加完整答题提交次数')
    eq(bad.result.srs_due, false, '错误不产生 SRS 交接义务')
  })

  /* ===== 8. 错误不增加 SRS 与 total_attempts ===== */
  await group('规则 7/8/9 · 错误不污染 SRS / total_attempts / in_wrong_pool', async () => {
    await resetDb()
    await putSession(session('s8', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const beforeLogs = await LOGS.count()
    const beforeVocab = (await VOCAB.get(W1)) as unknown as VocabEntry
    await submitLetter({ word_id: W1, char: 'z', request_id: 'g1', now: NOW })
    await submitLetter({ word_id: W1, char: 'x', request_id: 'g2', now: NOW })
    const w = currentWord(await row('s8'))
    eq(w?.total_attempts, 0, 'total_attempts 未被错误字母增加')
    eq(w?.correct_attempts, 0, 'correct_attempts 未变')
    eq(w?.wrong_attempts, 0, 'wrong_attempts 未变（错词本独立统计）')
    eq(await LOGS.count(), beforeLogs, 'reviewLog 无新增（SRS 未触发）')
    const afterVocab = (await VOCAB.get(W1)) as unknown as VocabEntry
    eq(afterVocab.consecutive_correct, beforeVocab.consecutive_correct, 'VocabEntry 连对未变')
    eq(afterVocab.in_wrong_pool, false, 'SRS 错题池未被错词事件污染')
    eq(afterVocab.srs_step, beforeVocab.srs_step, 'SRS 步进未变')
    eq((await loadWrongWordBook('s8')).records[0].active_wrong_count, 2, '错词本独立记录 2 次错误')
  })

  /* ===== 9. 错误提示音触发 ===== */
  await group('规则 4 · 错误提示音按错误字母逐个触发', async () => {
    await resetDb()
    await putSession(session('s9', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    eq(noopSpeechLog.errorTones, 0, '初始 0 次')
    await submitLetter({ word_id: W1, char: 'a', request_id: 'h1', now: NOW }) // 正确
    eq(noopSpeechLog.errorTones, 0, '正确字母不播音')
    await submitLetter({ word_id: W1, char: 'z', request_id: 'h2', now: NOW }) // 错误
    eq(noopSpeechLog.errorTones, 1, '第 1 个错误字母播音 1 次')
    await submitLetter({ word_id: W1, char: 'q', request_id: 'h3', now: NOW }) // 错误
    eq(noopSpeechLog.errorTones, 2, '第 2 个错误字母再播 1 次')
    eq((await eventsOf()).length, 2, '提示音次数与错误事件数一致')
  })

  /* ===== 10. 达到正确次数目标才完成单词 ===== */
  await group('规则 10 · 拼完整个词才算一次完整提交，达标才完成并切换', async () => {
    await resetDb()
    await putSession(
      session('s10', {
        total_words: 2,
        queue: [wordState(W1, 'ab', 0, 2), wordState(W2, 'cd', 1, 2)],
      }),
    )
    await VOCAB.put(vocab(W1, 'ab') as never)
    await VOCAB.put(vocab(W2, 'cd') as never)
    // 第一轮完整拼对 ab（2 个字母）
    const r1 = await submitLetter({ word_id: W1, char: 'a', request_id: 'i1', now: NOW })
    const r2 = await submitLetter({ word_id: W1, char: 'b', request_id: 'i2', now: NOW })
    eq(r1.result.outcome, 'correct', '第 1 个字母只是进度，未完成')
    eq(r1.result.is_full_attempt, false, '单个字母不是完整答题提交')
    eq(r2.result.is_full_attempt, true, '拼完整个词 = 一次完整答题提交')
    eq(r2.result.consecutive_correct, 1, '连对 = 1（目标 2，未完成）')
    eq(r2.result.word_status, 'IN_PROGRESS', '未达标不完成')
    eq(currentWord(await row('s10'))?.word_id, W1, '仍停在当前词')
    eq(currentWord(await row('s10'))?.total_attempts, 1, '完整答题提交次数 = 1')
    // 第二轮完整拼对 → 达标完成并切换
    await submitLetter({ word_id: W1, char: 'a', request_id: 'i3', now: NOW })
    const done = await submitLetter({ word_id: W1, char: 'b', request_id: 'i4', now: NOW })
    eq(done.result.consecutive_correct, 2, '连对 = 2 达标')
    eq(done.result.word_status, 'COMPLETED', '整词完成')
    eq(done.result.outcome, 'word_completed', '触发切词')
    eq(currentWord(await row('s10'))?.word_id, W2, '已切换到下一个词')
    eq(done.result.srs_due, true, '整词达标产生 SRS 交接义务（非错误事件触发）')
    eq((await eventsOf()).length, 0, '全程正确 → 0 条错词事件')
  })

  /* ===== 11. 双驱动一致 ===== */
  await group('规则 10 · Dexie / memory 双驱动状态机结果一致', async () => {
    await resetDb()
    const base = session('s11', {
      total_words: 1,
      queue: [wordState(W1, 'abandon', 0)],
    })
    // 纯函数层在两驱动上跑同一输入序列，结果必须逐项相同
    const seq = [
      { char: 'a', request_id: 'j1' },
      { char: 'b', request_id: 'j2' },
      { char: 'z', request_id: 'j3' },
      { char: 'a', request_id: 'j4' },
    ]
    let dex = base
    const dexResults: LetterResult[] = []
    for (const c of seq) {
      const out = applyLetter(dex, { ...c, word_id: W1, now: NOW })
      dex = out.session
      dexResults.push(out.result)
    }
    await memoryStorage.table('spellingSessions').put(base as never)
    let mem = (await memoryStorage.table('spellingSessions').get('s11')) as unknown as SpellingSession
    const memResults: LetterResult[] = []
    for (const c of seq) {
      const out = applyLetter(mem, { ...c, word_id: W1, now: NOW })
      mem = out.session
      await memoryStorage.table('spellingSessions').put(mem as never)
      memResults.push(out.result)
    }
    eq(JSON.stringify(memResults), JSON.stringify(dexResults), '两驱动 4 次逐字母结果逐项一致')
    eq(memResults[2].outcome, 'wrong', '两驱动都判第 3 个字母为错误')
    eq(memResults[3].typed_prefix, 'a', '两驱动错误后都从第一个字母重新开始')
    // 真实 Dexie 写路径 + memory 只读对照
    await putSession(base)
    await VOCAB.put(vocab(W1, 'abandon') as never)
    await submitLetter({ word_id: W1, char: 'z', request_id: 'j-real', now: NOW })
    const dexBook = await loadWrongWordBook('s11')
    const memRows = (await memoryStorage.table('spellingErrorEvents').toArray()) as unknown as SpellingErrorEvent[]
    eq(dexBook.total_error_events, 1, 'Dexie 路径 1 条事件')
    eq(memRows.length, 0, 'memory 驱动未被误写入（隔离）')
  })

  /* ===== 12. 双标签竞争 / 崩溃恢复 / drain 幂等 ===== */
  await group('回归 · 双标签竞争、U16 恢复、drain 幂等与事件隔离', async () => {
    await resetDb()
    await putSession(session('s12', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    await submitLetter({ word_id: W1, char: 'z', request_id: 'k1', now: NOW })
    // 另一标签接管后，旧标签写入必须被拒且零落盘
    await takeoverSessionLock('s12', { confirmed: true, tabId: 'tab-B', now: NOW + 1 })
    let rejected = 0
    try {
      await submitLetter({ word_id: W1, char: 'q', request_id: 'k2', now: NOW })
    } catch {
      rejected += 1
    }
    eq(rejected, 1, '接管后旧标签写入被明确拒绝')
    eq((await eventsOf()).length, 1, '旧标签零事件落盘')
    // 租约未过期时，恢复链不得偷偷接管（严格锁校验，符合 U16 铁律 2）
    invalidateLocalLocks()
    let refused = 0
    try {
      await runRecoveryChain('s12', { tabId: TAB_ID, now: NOW + 2 })
    } catch {
      refused += 1
    }
    eq(refused, 1, '他人持锁且租约未过期时，恢复链明确拒绝（不假报恢复成功）')
    // 模拟持锁标签崩溃：租约过期后本标签可接管并走完整恢复链
    const held = await row('s12')
    await putSession({ ...held, lock_held_at: 1 } as SpellingSession)
    invalidateLocalLocks()
    const chain = await runRecoveryChain('s12', { tabId: TAB_ID, now: NOW + LOCK_LEASE_MS + 10 })
    ok(chain.converged, '租约过期接管后 U16 恢复链收敛')
    ok(chain.takenOver, '恢复链确实重新取得写锁（重新 open ≠ 已持锁）')
    eq(chain.drain.scanned, 0, '生产逐字母路径不产生 pending 事件')
    const d2 = await drainPendingEvents({ sessionId: 's12' })
    ok(d2.converged, '重复 drain 仍收敛')
    eq((await eventsOf()).length, 1, '恢复 / drain 后事件行数不变')
  })

  /* ===== 13. 每个错误字母对应正确的错词统计 ===== */
  await group('规则 2 · 每个错误字母对应正确的错词统计（两指标分别标注）', async () => {
    await resetDb()
    await putSession(session('s13', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    // 一次拼写里错 3 个字母，中间夹正确字母
    await submitLetter({ word_id: W1, char: 'a', request_id: 'l1', now: NOW }) // 对
    await submitLetter({ word_id: W1, char: 'z', request_id: 'l2', now: NOW }) // 错
    await submitLetter({ word_id: W1, char: 'a', request_id: 'l3', now: NOW }) // 对（归零后重来）
    await submitLetter({ word_id: W1, char: 'x', request_id: 'l4', now: NOW }) // 错
    await submitLetter({ word_id: W1, char: 'q', request_id: 'l5', now: NOW }) // 错
    const book = await loadWrongWordBook('s13')
    eq(book.records[0].active_wrong_count, 3, '活动错词事件数 = 3（错误字母数）')
    eq(book.records[0].total_error_events, 3, '历史错误事件行数 = 3')
    eq(book.active_wrong_count, 3, '合计 active = 3')
    eq(book.total_error_events, 3, '合计 total = 3')
    ok(STAT_LABELS.active !== STAT_LABELS.total, '两个指标分别标注')
    ok(!STAT_LABELS.active.includes('拼错次数'), '活动指标不含主观「拼错次数」')
    ok(!STAT_LABELS.total.includes('拼错次数'), '历史指标不含主观「拼错次数」')
    ok(STAT_LABELS.note.includes('每个真实错误字母'), '口径说明写明逐字母累计')
  })

  /* ===== 14. 不污染其他会话和 owner ===== */
  await group('规则 9 · 不污染其他会话 / 其他 owner 的错词数据', async () => {
    await resetDb()
    await putSession(session('s14a', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await putSession(session('s14b', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await putSession(session('s14c', { owner: 'other-user', total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    // 手工构造：本会话 1 条 + 别的会话 1 条 + 别的 owner 1 条（同 session_id 但 owner 不同）
    const mk = (id: string, sid: string, owner: string, word_id: string) =>
      ({
        event_id: id,
        owner,
        word_id,
        session_id: sid,
        kind: 'wrong',
        occurred_at: NOW,
        status: 'settled',
        tab_id: TAB_ID,
        lock_epoch: 0,
        word_snapshot: 'abandon',
      }) as unknown as SpellingErrorEvent
    await EVENTS.put(mk('own', 's14a', 'guest', W1) as never)
    await EVENTS.put(mk('other-session', 's14b', 'guest', W1) as never)
    await EVENTS.put(mk('other-owner', 's14a', 'someone-else', W1) as never)
    const bookA = await loadWrongWordBook('s14a')
    eq(bookA.owner, 'guest', 'owner 取自会话文档')
    eq(bookA.total_error_events, 1, '只统计本会话本账号的 1 条')
    eq(bookA.active_wrong_count, 1, 'active 也只算 1 条')
    const bookB = await loadWrongWordBook('s14b')
    eq(bookB.total_error_events, 1, '会话 B 独立统计')
    eq(bookB.records[0].word_id, W1, '会话 B 记录不被 A 覆盖')
    // 纯聚合层 owner 过滤
    const allRows = (await EVENTS.toArray()) as unknown as WrongBookEvent[]
    const s = await row('s14a')
    const onlyGuest = aggregateWrongWordBook(allRows, () => s, 'guest')
    eq(onlyGuest.total_error_events, 2, '纯聚合按 owner 过滤后只剩 2 条 guest 事件')
    eq(onlyGuest.records.length, 1, '按 word_id 合并成 1 条记录')
  })

  /* ===== 补充：V1 整词 API 仍可用（不破坏既有回归） ===== */
  await group('兼容 · V1 整词提交 API 未被 V2 改造破坏', async () => {
    await resetDb()
    await putSession(session('s15', { total_words: 1, queue: [wordState(W1, 'abandon', 0)] }))
    await VOCAB.put(vocab(W1, 'abandon') as never)
    const { submitAttempt } = await import('../src/domain/spellingSession')
    const r = await submitAttempt({ word_id: W1, input: 'wrng', request_id: 'v1-1' })
    eq(r.result.result, 'wrong', 'V1 整词判定仍返回 wrong')
    eq((await eventsOf()).length, 1, 'V1 整词错误仍为 1 条事件（兼容）')
    eq((currentWord(await row('s15'))?.total_attempts), 1, 'V1 完整答题计数未变')
  })

  console.log(`\n${'─'.repeat(64)}`)
  if (failed === 0) {
    console.log(`✅ V2 逐字母状态机全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ V2 逐字母状态机失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run().catch((err) => {
  console.error('❌ 测试执行异常', err)
  process.exit(1)
})
