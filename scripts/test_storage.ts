/**
 * 存储服务单测（内存 driver）
 * ------------------------------------------------------------------
 * 故意 **不** import fake-indexeddb：这样 Node 里没有 indexedDB，
 * `services/storage` 会选中内存实现 —— 正好验证「领域逻辑与存储实现解耦」。
 * Dexie 实现的等价性由 test_learning_loop.ts / test_readings.ts 覆盖
 * （那两个脚本会 load fake-indexeddb）。
 *
 * 运行：npx tsx scripts/test_storage.ts
 */
import { storage, isStorageEphemeral } from '../src/services/storage'
import { addToVocab, getLayerCounts, recordQuiz } from '../src/domain/learning'
import type { Recitation, VocabEntry } from '../src/domain/types'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed++
  }
}

function vocabRow(word_id: string, layer: VocabEntry['layer'] = 'new'): VocabEntry {
  return {
    word_id,
    word: word_id,
    layer,
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: 0,
    added_at: 0,
  }
}

async function expectReject(p: Promise<unknown>, label: string) {
  let rejected = false
  try {
    await p
  } catch {
    rejected = true
  }
  assert(rejected, label)
}

async function main() {
  console.log('[storage] driver 选择')
  assert(storage.driver === 'memory', `无 indexedDB 时选中内存实现（实际 ${storage.driver}）`)
  assert(isStorageEphemeral, 'isStorageEphemeral 标记为 true，设置页可据此提示')

  console.log('[storage] 基础 CRUD')
  await storage.clearAll()
  const vocab = storage.table('vocab')
  await vocab.put(vocabRow('a'))
  assert((await vocab.get('a'))?.word_id === 'a', 'put / get 往返')
  assert((await vocab.count()) === 1, 'count 正确')

  await vocab.put(vocabRow('a', 'apply'))
  assert((await vocab.get('a'))?.layer === 'apply', 'put 同主键为覆盖写')

  await vocab.put(vocabRow('b'))
  const arr = await vocab.toArray()
  assert(arr.length === 2, `toArray 返回 2 行（实际 ${arr.length}）`)

  await vocab.delete('a')
  assert((await vocab.get('a')) === undefined, 'delete 生效')

  console.log('[storage] 批量读写')
  await storage.clearAll()
  await vocab.bulkPut([vocabRow('x'), vocabRow('y'), vocabRow('z')])
  assert((await vocab.count()) === 3, 'bulkPut 写入 3 行')
  const many = await vocab.bulkGet(['x', 'y', 'missing', 'z'])
  assert(
    many.length === 4 && many[0] !== undefined && many[2] === undefined && many[3] !== undefined,
    'bulkGet 保序返回，缺失位为 undefined',
  )

  console.log('[storage] 自增主键表')
  const logs = storage.table('reviewLog')
  await storage.clearAll()
  const id1 = await logs.add({ word_id: 'a', at: 1, correct: true, quiz_form: 'dictation' })
  const id2 = await logs.add({ word_id: 'b', at: 2, correct: false, quiz_form: 'spelling' })
  assert(id1 === 1 && id2 === 2, `自增主键从 1 开始递增（实际 ${id1}, ${id2}）`)
  assert((await logs.count()) === 2, '自增表 2 行')

  console.log('[storage] 索引查询与防误用')
  await storage.clearAll()
  await vocab.bulkPut([vocabRow('p', 'new'), vocabRow('q', 'apply'), vocabRow('r', 'new')])
  const news = await vocab.whereIndex('layer', 'new')
  assert(news.length === 2, `whereIndex('layer') 命中 2 行（实际 ${news.length}）`)
  await expectReject(vocab.whereIndex('srs_step', 0), '未建索引字段查询被显式拒绝（不静默全表扫）')

  console.log('[storage] 领域逻辑跑在内存实现上')
  await storage.clearAll()
  const entry = await addToVocab({ id: 'w1', word: 'apple' })
  assert(entry.layer === 'new', 'addToVocab 落到 new 层')
  for (let i = 0; i < 5; i++) await recordQuiz('w1', true, 'dictation')
  const counts = await getLayerCounts()
  assert(counts.apply === 1, `连续答对 5 次 → apply（实际 apply=${counts.apply}）`)

  console.log('[storage] clearAll')
  await storage.clearAll()
  assert((await vocab.count()) === 0, 'vocab 已清空')
  assert((await logs.count()) === 0, 'reviewLog 已清空')

  console.log('[storage] 带 Blob 的行（背诵录音）')
  await storage.clearAll()
  const rec = storage.table('recitations')
  const blob = new Blob(['fake-audio'], { type: 'audio/webm' })
  const row: Recitation = {
    id: 'rec_1',
    doc_id: 'doc_1',
    title: '2026-10-03-00:05',
    duration_ms: 5000,
    size: blob.size,
    media_type: 'audio/webm',
    created_at: 1,
    blob,
  }
  await rec.put(row)
  const back = await rec.get('rec_1')
  assert(back?.blob instanceof Blob && back.blob.size === blob.size, 'Blob 字段读写往返')
  const byDoc = await rec.whereIndex('doc_id', 'doc_1')
  assert(byDoc.length === 1, 'whereIndex(doc_id) 命中')

  console.log('')
  if (failed) {
    console.error(`${failed} 项失败`)
    process.exit(1)
  }
  console.log('存储服务单测全部通过 ✓')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
