import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import {
  saveReading,
  getReadings,
  getReading,
  deleteReading,
  updateReadingProgress,
  addReadingTime,
  addDictationTime,
  addAnnotation,
  addRecitation,
  getTotalReadingSeconds,
  type ReadingDoc,
} from '../src/domain/learning'
import { storage } from '../src/services/storage'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

async function run() {
  // 保存一篇文本素材
  const r1: ReadingDoc = await saveReading({
    title: 'My Day',
    type: 'article',
    content: 'I wake up early. The sun is bright. We read books together.',
  })
  assert(typeof r1.id === 'string' && r1.id.length > 0, '应生成 id')
  assert(r1.word_count === 12, `词数应为 12，实际 ${r1.word_count}`)
  assert(r1.owner === 'guest', `新素材 owner 应为 guest，实际 ${r1.owner}`)
  console.log('✅ saveReading（文本）→ 词数统计正确，并写入 owner=guest')

  // 保存一篇音频转写
  await saveReading({ title: 'Recording', type: 'audio', content: 'Hello world' })
  const all = await getReadings()
  assert(all.length === 2, `应有 2 篇，实际 ${all.length}`)
  assert(all[0].created_at >= all[1].created_at, '列表按时间倒序')
  console.log('✅ getReadings 倒序返回 2 篇')

  // 单篇查询
  const got = await getReading(r1.id)
  assert(got?.title === 'My Day', 'getReading 命中')
  console.log('✅ getReading 命中')

  // 进度更新
  await updateReadingProgress(r1.id, 320)
  const got2 = await getReading(r1.id)
  assert(got2?.scroll_pos === 320, 'scroll_pos 已更新')
  assert(typeof got2?.last_read_at === 'number', 'last_read_at 已写入')
  console.log('✅ updateReadingProgress 写入滚动位置')

  // 阅读时长累计（跨多次、跨日）
  await addReadingTime(60)
  await addReadingTime(30)
  const today = await getTotalReadingSeconds()
  assert(today === 90, `当日累计应为 90s，实际 ${today}`)
  // 切换日期累计到不同行
  const tomorrow = new Date(Date.now() + 86400_000)
  const y = tomorrow.getFullYear()
  const m = String(tomorrow.getMonth() + 1).padStart(2, '0')
  const d = String(tomorrow.getDate()).padStart(2, '0')
  await addReadingTimeToDate(`${y}-${m}-${d}`, 45)
  const total = await getTotalReadingSeconds()
  assert(total === 135, `总累计应为 135s，实际 ${total}`)
  console.log('✅ addReadingTime 当日/跨日累计正确')

  const times = storage.table('readingTime')
  const todayRow = (await times.toArray()).find((t) => t.total_seconds === 90)
  assert(todayRow?.owner === 'guest', 'addReadingTime 新行写入 owner=guest')
  await times.put({ ...todayRow!, dictation_seconds: 15, owner: 'alice' })
  await addReadingTime(5)
  const kept = await times.get(todayRow!.date)
  assert(kept?.total_seconds === 95, `保留默写后阅读累计应为 95，实际 ${kept?.total_seconds}`)
  assert(kept?.dictation_seconds === 15, 'addReadingTime 保留 dictation_seconds')
  assert(kept?.owner === 'alice', 'addReadingTime 不覆盖已有 owner')

  await times.delete(todayRow!.date)
  await addDictationTime(8)
  const dictated = await times.get(todayRow!.date)
  assert(dictated?.owner === 'guest', 'addDictationTime 新行写入 owner=guest')
  assert(dictated?.dictation_seconds === 8, 'addDictationTime 写入默写秒数')
  assert(dictated?.total_seconds === 0, '仅默写时阅读秒数为 0')
  await addReadingTime(2)
  const merged = await times.get(todayRow!.date)
  assert(merged?.total_seconds === 2, '随后阅读时长累加')
  assert(merged?.dictation_seconds === 8, '阅读累计不冲掉默写秒数')
  assert(merged?.owner === 'guest', '阅读累计保留 owner')
  console.log('✅ 阅读/默写时长互相保留字段与 owner')

  const ann = await addAnnotation({
    doc_id: r1.id,
    page: 0,
    para: 0,
    start: 0,
    end: 4,
    text: 'wake',
    kind: 'underline',
  })
  assert(ann.owner === 'guest', 'addAnnotation 写入 owner=guest')
  const rec = await addRecitation({
    blob: new Blob(['x'], { type: 'audio/webm' }),
    duration_ms: 1000,
    media_type: 'audio/webm',
    title: 'rec',
    doc_id: r1.id,
  })
  assert(rec.owner === 'guest', 'addRecitation 写入 owner=guest')
  const current = await getReading(r1.id)
  await storage.table('readings').put({ ...current!, owner: 'alice' })
  const overwritten = await saveReading({
    id: r1.id,
    title: 'My Day',
    type: 'article',
    content: r1.content,
  })
  assert(overwritten.owner === 'alice', 'saveReading 覆盖保留已有 owner')
  console.log('✅ 批注/背诵写入 owner，覆盖保存保留原 owner')

  // 删除
  await deleteReading(r1.id)
  const afterDel = await getReadings()
  assert(afterDel.length === 1, `删除后应剩 1 篇，实际 ${afterDel.length}`)
  console.log('✅ deleteReading 生效')

  await storage.table('vocab').put({
    word_id: 'clear-rollback',
    word: 'clear',
    layer: 'new',
    consecutive_correct: 0,
    srs_step: 0,
    in_wrong_pool: false,
    next_review: 0,
    added_at: 1,
    owner: 'guest',
  })
  // Dexie.Table 只是类型；运行时 clear 在各库 Table 构造器共享的原型上。
  const probe = new Dexie('clearall-probe')
  probe.version(1).stores({ t: 'id' })
  const shared = Object.getPrototypeOf(probe.Table.prototype) as { clear: () => Promise<void> }
  const origClear = shared.clear
  shared.clear = function (this: { name: string }) {
    if (this.name === 'readings') return Promise.reject(new Error('injected clear failure'))
    return origClear.call(this)
  }
  try {
    let threw = false
    try {
      await storage.clearAll()
    } catch {
      threw = true
    }
    assert(threw, 'clearAll 中途失败应抛出')
    const still = await storage.table('vocab').get('clear-rollback')
    assert(still?.word_id === 'clear-rollback', 'clearAll 失败后应回滚，已清空的表不留空')
  } finally {
    shared.clear = origClear
    probe.close()
  }
  await storage.clearAll()
  assert((await storage.table('vocab').count()) === 0, 'clearAll 成功时 vocab 被清空')
  assert((await storage.table('readings').count()) === 0, 'clearAll 成功时 readings 被清空')
  console.log('✅ clearAll 单事务：中途失败回滚，成功时全部清空')

  console.log('\n🎉 导入/阅读数据层测试全部通过')
}

// 直接写指定日期（绕过 todayStr），用于跨日累计验证。
// 走 storage 服务而不是裸 db 句柄 —— 这正是 service 层改造后测试也该遵守的边界。
async function addReadingTimeToDate(date: string, seconds: number) {
  const t = storage.table('readingTime')
  const row = await t.get(date)
  await t.put({ date, total_seconds: (row?.total_seconds ?? 0) + seconds })
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
