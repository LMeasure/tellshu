/**
 * 书籍资产 / 单词默写 V2 · v11 → v14 迁移测试（fake-indexeddb 真实库）
 * ------------------------------------------------------------------
 * 为什么单独一个文件：同 test_spelling_migration.ts —— 迁移正确性取决于「先按 v11
 * schema 建好带数据的库并关闭，再 import 真实 storage」触发升级；同进程内后导入才走升级分支。
 *
 * 验证目标（对应《Dexie版本协调-G9-D9-结论.md》§二 v12/v13/v14 分配）：
 *   1. 存量 v11 数据（vocab / reviewLog / readings / recitations / transcripts /
 *      studyNotes / annotations / spellingSessions / wordLearningSessions）**一行不丢**；
 *   2. v12 升级回调为 5 张「此前无 owner」的表存量行补 owner='guest'，且已有 owner 的行不被覆盖；
 *   3. v14 新建 spellingErrorEvents 表存在且为空、索引可用、可写入回读；
 *   4. 升级后持久化层立即可用（owner 索引可按 'guest' 等值查）。
 *
 * 运行：tsx scripts/test_bookschema_migration.ts
 */

import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string) {
  if (cond) {
    passed += 1
    console.log('  ✓', msg)
  } else {
    failed += 1
    failures.push(msg)
    console.error(`  ❌ ${msg}`)
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  ok(actual === expected, `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`)
}

const NOW = 1_700_000_000_000

/**
 * v11 时代的完整 schema（照 web.ts 中 version(1)~version(11) 的累积结果抄）。
 * 关键点：readings / recitations / transcripts / studyNotes / annotations **此时尚无 owner** ——
 * 这就是「存量库」的定义，正是 v12 要补索引并回填的那 5 张表。
 */
const V11_STORES: Record<string, string> = {
  vocab: 'word_id, word, layer, next_review, added_at, owner',
  reviewLog: '++id, word_id, at, uid, owner',
  readings: 'id, created_at, type, on_shelf',
  readingTime: 'date, owner',
  diagnose: '++id, at',
  recitations: 'id, created_at, doc_id',
  dictEntries: 'key, word_lower, pos, updated_at',
  dictToc: 'id, book, page_start',
  dictGrammar: 'key, base_lower, type',
  dictMeta: 'key',
  annotations: 'id, doc_id, created_at',
  collections: 'id, owner, updated_at',
  settings: 'owner',
  session: 'user_id',
  sync_queue: 'id, entity, entity_id, created_at, attempts',
  sync_meta: 'key',
  transcripts: 'id, created_at, source',
  studyNotes: 'id, transcript_id, status, created_at, updated_at, source',
  spellingSessions: 'id, status, started_at, owner',
  wordLearningSessions: 'id, book, level, updated_at, owner',
}

/** 造一份「v11 时代」的库：表结构是 v11，里面带有真实数据（5 张目标表故意不带 owner） */
async function seedV11Database(): Promise<void> {
  const probe = new Dexie('shushu-learn')
  probe.version(11).stores(V11_STORES)
  await probe.open()
  try {
    await probe.table('vocab').put({
      word_id: 'CET4:abandon',
      word: 'abandon',
      layer: 'new',
      consecutive_correct: 2,
      srs_step: 1,
      definition_zh: 'v. 抛弃；放弃',
      added_at: NOW,
      next_review: NOW,
      owner: 'guest',
      updated_at: NOW,
      in_wrong_pool: false,
      deleted_at: null,
    })
    await probe.table('reviewLog').add({
      word_id: 'CET4:abandon',
      at: NOW,
      correct: true,
      quiz_form: 'spelling',
      uid: 'uid-v11-1',
      owner: 'guest',
      updated_at: NOW,
    })
    // readings：无 owner（v12 应补 'guest'）
    await probe.table('readings').put({
      id: 'r-v11-plain',
      title: '无 owner 的存量阅读',
      type: 'txt',
      created_at: NOW,
      on_shelf: true,
    })
    // readings：已带 owner=alice（v12 不应覆盖）
    await probe.table('readings').put({
      id: 'r-v11-alice',
      title: '已归属 alice 的存量阅读',
      type: 'txt',
      created_at: NOW,
      on_shelf: true,
      owner: 'alice',
    })
    // recitations / transcripts / studyNotes / annotations：均无 owner
    await probe.table('recitations').put({
      id: 'rec-v11-1',
      doc_id: 'doc-v11',
      title: 'rec',
      duration_ms: 1000,
      size: 10,
      media_type: 'audio/webm',
      created_at: NOW,
    })
    await probe.table('transcripts').put({ id: 't-v11-1', created_at: NOW, source: 'asr' })
    await probe.table('studyNotes').put({
      id: 'sn-v11-1',
      transcript_id: 't-v11-1',
      status: 'draft',
      created_at: NOW,
      updated_at: NOW,
      source: 'asr',
    })
    await probe.table('annotations').put({
      id: 'an-v11-1',
      doc_id: 'doc-v11',
      created_at: NOW,
    })
    // v10 / v11 表也放点数据，确认升级后仍在
    await probe.table('spellingSessions').put({
      id: 'sess-v11-1',
      type: 'spelling',
      owner: 'guest',
      status: 'IN_PROGRESS',
      selection_mode: 'recent',
      target_correct: 3,
      total_words: 0,
      current_position: -1,
      started_at: NOW,
      updated_at: NOW,
      queue: [],
      processed_requests: {},
    })
    await probe.table('wordLearningSessions').put({
      id: 'wls-v11-1',
      book: 'CET4',
      level: 'all',
      updated_at: NOW,
      owner: 'guest',
    })
  } finally {
    probe.close()
  }
}

async function run() {
  console.log('▶ v11 → v14 迁移：存量数据不丢、v12 回填 owner、v14 新表可用')
  await seedV11Database()

  // 关键：在 v11 库已经存在之后才导入 storage —— 单例构造时带 version(1)~version(14)，
  // 打开时发现 verno=11 < 14，依次走 12→13→14 升级分支。
  const { storage } = await import('../src/services/storage')
  await storage.open()

  eq(storage.driver, 'dexie', '升级后仍走 Dexie 持久化实现')

  /* ---- 1. 老数据一行不丢 ---- */
  eq((await storage.table('vocab').toArray()).length, 1, 'vocab 1 行原样保留')
  eq((await storage.table('reviewLog').toArray()).length, 1, 'reviewLog 1 行原样保留')
  eq((await storage.table('readings').toArray()).length, 2, 'readings 2 行原样保留')
  eq((await storage.table('recitations').toArray()).length, 1, 'recitations 1 行原样保留')
  eq((await storage.table('transcripts').toArray()).length, 1, 'transcripts 1 行原样保留')
  eq((await storage.table('studyNotes').toArray()).length, 1, 'studyNotes 1 行原样保留')
  eq((await storage.table('annotations').toArray()).length, 1, 'annotations 1 行原样保留')
  eq((await storage.table('spellingSessions').toArray()).length, 1, 'spellingSessions(v10) 保留')
  eq((await storage.table('wordLearningSessions').toArray()).length, 1, 'wordLearningSessions(v11) 保留')

  /* ---- 2. v12 回填：5 表存量行有 owner='guest'，已有 owner 不被覆盖 ---- */
  const readings = await storage.table('readings').toArray()
  const plain = readings.find((r: any) => r.id === 'r-v11-plain')
  const alice = readings.find((r: any) => r.id === 'r-v11-alice')
  ok(plain !== undefined, 'r-v11-plain 还在')
  eq(plain?.owner, 'guest', 'v12 为无 owner 的 readings 行补 owner=guest')
  ok(alice !== undefined, 'r-v11-alice 还在')
  eq(alice?.owner, 'alice', 'v12 不覆盖已有的 owner=alice')

  const rec = await storage.table('recitations').toArray()
  eq(rec[0]?.owner, 'guest', 'v12 为 recitations 存量行补 owner=guest')
  const tr = await storage.table('transcripts').toArray()
  eq(tr[0]?.owner, 'guest', 'v12 为 transcripts 存量行补 owner=guest')
  const sn = await storage.table('studyNotes').toArray()
  eq(sn[0]?.owner, 'guest', 'v12 为 studyNotes 存量行补 owner=guest')
  const an = await storage.table('annotations').toArray()
  eq(an[0]?.owner, 'guest', 'v12 为 annotations 存量行补 owner=guest')

  /* ---- 3. v14 新表：存在、为空、索引可用、可写入回读 ---- */
  const events = await storage.table('spellingErrorEvents').toArray()
  eq(events.length, 0, 'spellingErrorEvents 新表为空（不凭空造数据）')

  await storage.table('spellingErrorEvents').put({
    event_id: 'evt-1',
    owner: 'guest',
    word_id: 'CET4:abandon',
    session_id: 'sess-v11-1',
    kind: 'wrong',
    occurred_at: NOW,
    status: 'pending',
  } as any)
  const back = await storage.table('spellingErrorEvents').get('evt-1')
  ok(back !== undefined, 'spellingErrorEvents 按主键回读成功')
  eq(back?.word_id, 'CET4:abandon', 'spellingErrorEvents 字段完整回读')

  const byWord = await storage.table('spellingErrorEvents').whereIndex('word_id', 'CET4:abandon')
  eq(byWord.length, 1, 'spellingErrorEvents word_id 索引可用')
  const byStatus = await storage.table('spellingErrorEvents').whereIndex('status', 'pending')
  eq(byStatus.length, 1, 'spellingErrorEvents status 索引可用')

  /* ---- 4. 升级后 owner 索引可按 'guest' 等值查 ---- */
  const guestReadings = await storage.table('readings').whereIndex('owner', 'guest')
  eq(guestReadings.length, 1, 'readings owner 索引可按 guest 查到回填行')
  const aliceReadings = await storage.table('readings').whereIndex('owner', 'alice')
  eq(aliceReadings.length, 1, 'readings owner 索引可按 alice 查到保留行')

  console.log(`\n${'─'.repeat(56)}`)
  if (failed === 0) {
    console.log(`✅ v11 → v14 迁移测试全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ v11 → v14 迁移测试失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run()
