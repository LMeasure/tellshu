import 'fake-indexeddb/auto'
import {
  saveReading,
  getReadings,
  getReading,
  deleteReading,
  updateReadingProgress,
  addReadingTime,
  getTotalReadingSeconds,
  type ReadingDoc,
} from '../src/domain/learning'

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
  console.log('✅ saveReading（文本）→ 词数统计正确')

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

  // 删除
  await deleteReading(r1.id)
  const afterDel = await getReadings()
  assert(afterDel.length === 1, `删除后应剩 1 篇，实际 ${afterDel.length}`)
  console.log('✅ deleteReading 生效')

  console.log('\n🎉 导入/阅读数据层测试全部通过')
}

// 直接写指定日期（绕过 todayStr），用于跨日累计验证。
// 走 storage 服务而不是裸 db 句柄 —— 这正是 service 层改造后测试也该遵守的边界。
async function addReadingTimeToDate(date: string, seconds: number) {
  const { storage } = await import('../src/services/storage')
  const t = storage.table('readingTime')
  const row = await t.get(date)
  await t.put({ date, total_seconds: (row?.total_seconds ?? 0) + seconds })
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
