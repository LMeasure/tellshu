/**
 * 单词默写 · v9 → v10 迁移测试（fake-indexeddb 真实库）
 * ------------------------------------------------------------------
 * 为什么单独一个文件：
 *   迁移的正确性**取决于打开数据库时的版本号**，所以必须「先按 v9 schema 建好
 *   带数据的库并关闭，再 import 真实 storage」—— 同进程内后导入才会触发升级。
 *   放在 test_spelling_session.ts 里做不到（它顶部就 import 了 storage，
 *   库会被直接建成 v10，根本走不到升级分支）。
 *
 * 验证目标（对应任务书 B1「不改历史 migration，只新增 version(10)」）：
 *   1. 存量 v9 数据（vocab / reviewLog / readings / transcripts）**一行不丢**；
 *   2. 新表 spellingSessions 被建成且为空，索引可用；
 *   3. 升级后持久化层立即可用（能建会话、能按 status 索引查）。
 *
 * 运行：tsx scripts/test_spelling_migration.ts
 */

import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let passed = 0
let failed = 0
const failures: string[] = []

function ok(cond: boolean, msg: string) {
  if (cond) passed += 1
  else {
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
 * v9 时代的完整 schema（照 web.ts 中 version(1)~version(9) 的累积结果抄）。
 * 这里**故意不含 spellingSessions** —— 它就是「存量库」的定义。
 */
const V9_STORES: Record<string, string> = {
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
}

/** 造一份「v9 时代」的库：表结构是 v9，里面有真实数据 */
async function seedV9Database(): Promise<void> {
  const probe = new Dexie('shushu-learn')
  probe.version(9).stores(V9_STORES)
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
    await probe.table('vocab').put({
      word_id: 'CET4:benefit',
      word: 'benefit',
      layer: 'new',
      consecutive_correct: 0,
      srs_step: 0,
      definition_zh: 'n. 利益；好处',
      added_at: NOW + 1,
      next_review: NOW + 1,
      owner: 'guest',
      updated_at: NOW + 1,
      in_wrong_pool: false,
      deleted_at: null,
    })
    await probe.table('reviewLog').add({
      word_id: 'CET4:abandon',
      at: NOW,
      correct: true,
      quiz_form: 'spelling',
      uid: 'uid-v9-1',
      owner: 'guest',
      updated_at: NOW,
    })
    await probe.table('readings').put({
      id: 'r-v9-1',
      title: '存量阅读',
      type: 'txt',
      created_at: NOW,
      on_shelf: true,
    })
    await probe.table('transcripts').put({
      id: 't-v9-1',
      created_at: NOW,
      source: 'asr',
    })
  } finally {
    probe.close()
  }
}

async function run() {
  console.log('▶ v9 → v10 迁移：存量数据不丢、新表可用')
  await seedV9Database()

  // 关键：在 v9 库已经存在之后才导入 storage —— 单例构造时带 version(1)~version(10)，
  // 打开时发现 verno=9 < 10，走升级分支。
  const { storage } = await import('../src/services/storage')
  await storage.open()

  eq(storage.driver, 'dexie', '升级后仍走 Dexie 持久化实现')

  /* ---- 1. 老数据一行不丢 ---- */
  const vocab = await storage.table('vocab').toArray()
  eq(vocab.length, 2, 'vocab 2 行原样保留')
  const abandon = vocab.find((v) => v.word_id === 'CET4:abandon')
  ok(abandon !== undefined, 'abandon 还在')
  eq(abandon?.consecutive_correct, 2, 'consecutive_correct 没被迁移改写')
  eq(abandon?.definition_zh, 'v. 抛弃；放弃', 'definition_zh 没被迁移改写')
  eq(abandon?.srs_step, 1, 'srs_step 没被迁移改写')

  const logs = await storage.table('reviewLog').toArray()
  eq(logs.length, 1, 'reviewLog 1 行原样保留')
  eq(logs[0]?.uid, 'uid-v9-1', 'reviewLog 跨端 uid 保留')

  const readings = await storage.table('readings').toArray()
  eq(readings.length, 1, 'readings 1 行原样保留')
  eq(readings[0]?.title, '存量阅读', 'readings 内容保留')

  const transcripts = await storage.table('transcripts').toArray()
  eq(transcripts.length, 1, 'transcripts 1 行原样保留')

  /* ---- 2. 新表已建成、为空、索引可用 ---- */
  const sessions = await storage.table('spellingSessions').toArray()
  eq(sessions.length, 0, 'spellingSessions 新表为空（不凭空造数据）')

  const byStatus = await storage
    .table('spellingSessions')
    .whereIndex('status', 'IN_PROGRESS')
  eq(byStatus.length, 0, 'status 索引可用（空表查得到空结果）')

  /* ---- 3. 升级后持久化层立即可用 ---- */
  const { createSession, getActiveSessions } = await import('../src/domain/spellingSession')
  const created = await createSession({ mode: 'recent', count: 5, now: NOW, id: 'sess-mig' })
  eq(created.session.total_words, 2, '用存量 vocab 直接建会话成功（2 词）')
  eq((await getActiveSessions()).length, 1, '新会话能被活跃查询找到')

  const rowsAfter = await storage.table('spellingSessions').toArray()
  eq(rowsAfter.length, 1, '新表写入正常')
  const vocabAfter = await storage.table('vocab').toArray()
  eq(vocabAfter.length, 2, '建会话没有改动 vocab')

  console.log(`\n${'─'.repeat(56)}`)
  if (failed === 0) {
    console.log(`✅ v9 → v10 迁移测试全部通过：${passed} 项断言`)
  } else {
    console.error(`❌ v9 → v10 迁移测试失败：${failed} 项失败 / ${passed} 项通过`)
    failures.forEach((f) => console.error(`   - ${f}`))
    process.exit(1)
  }
}

void run()
