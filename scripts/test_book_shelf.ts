/**
 * 发现书入架闭环单测（fake-indexeddb）
 * ------------------------------------------------------------------
 * 验证点（线6 MVP · 先入架后全文）：
 *   1. shelveDiscoveredBook 写入 type=book、on_shelf、空正文、source 快照
 *   2. 同一 (source_site, source_id) 重复入架不增行，并保留 created_at
 *   3. getShelfBooks 可见；isBookShelved 为 true
 *   4. isDiscoveredBook 区分发现书与无 source_site 的导入书
 *   5. discoveredDocId 对同一输入稳定
 * 不编造正文：content 必须是空串。
 * 运行：npx tsx scripts/test_book_shelf.ts
 */
import 'fake-indexeddb/auto'
import {
  discoveredDocId,
  getReading,
  getReadings,
  getShelfBooks,
  isBookShelved,
  isDiscoveredBook,
  saveReading,
  shelveDiscoveredBook,
} from '../src/domain/learning'
import { DISCOVER_SOURCE_SITE } from '../src/domain/discover/search'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

async function run() {
  assert(DISCOVER_SOURCE_SITE === 'gutenberg', `来源站点常量应为 gutenberg，实际 ${DISCOVER_SOURCE_SITE}`)

  const id = discoveredDocId(DISCOVER_SOURCE_SITE, '7')
  assert(id === 'discovered:gutenberg:7', `稳定主键应为 discovered:gutenberg:7，实际 ${id}`)
  assert(discoveredDocId('gutenberg', '7') === id, '同一输入得到同一 id')
  assert(discoveredDocId('gutenberg', '8') !== id, '不同 source_id 得到不同 id')
  console.log('✅ discoveredDocId 确定性')

  const doc = await shelveDiscoveredBook({
    title: 'Crime and Punishment',
    author: 'Fyodor Dostoyevsky',
    source_site: DISCOVER_SOURCE_SITE,
    source_id: '7',
  })
  assert(doc.id === id, '入架 id 使用稳定主键')
  assert(doc.type === 'book', 'type=book')
  assert(doc.on_shelf === true, 'on_shelf===true')
  assert(doc.content === '', `content 应为空串，实际 ${JSON.stringify(doc.content)}`)
  assert(doc.source_site === 'gutenberg', 'source_site 快照 gutenberg')
  assert(doc.source_id === '7', 'source_id 快照 = book_id')
  assert(doc.author === 'Fyodor Dostoyevsky', 'author 快照')
  assert(doc.word_count === 0, '空正文词数为 0，不编造')
  console.log('✅ shelveDiscoveredBook 写入字段快照且正文为空')

  const stored = await getReading(id)
  assert(stored !== undefined, 'getReading 按稳定主键命中')
  const { storage } = await import('../src/services/storage')
  await storage.table('readings').put({
    ...stored!,
    created_at: 1_700_000_000_000,
    pinned_at: 1_700_000_111_000,
    booklists: ['夜读'],
  })

  const again = await shelveDiscoveredBook({
    title: 'Crime and Punishment',
    author: 'Fyodor Dostoyevsky',
    source_site: 'gutenberg',
    source_id: '7',
  })
  const rows = await getReadings()
  const matched = rows.filter((r) => r.id === id)
  assert(matched.length === 1, `重复入架后该 id 应只有 1 行，实际 ${matched.length}`)
  assert(rows.length === 1, `重复入架后库内总行数应为 1，实际 ${rows.length}`)
  assert(again.created_at === 1_700_000_000_000, `重复入架应保留 created_at，实际 ${again.created_at}`)
  assert(again.pinned_at === 1_700_000_111_000, '重复入架保留 pinned_at')
  assert(again.booklists?.[0] === '夜读', '重复入架保留 booklists')
  assert(again.on_shelf === true, '重复入架仍在书架')
  assert(again.content === '', '重复入架仍不写入正文')
  console.log('✅ 重复入架幂等，保留 created_at / pinned_at / booklists')

  const shelf = await getShelfBooks()
  assert(shelf.some((b) => b.id === id && b.source_id === '7'), 'getShelfBooks 包含该书')
  assert((await isBookShelved('gutenberg', '7')) === true, "isBookShelved('gutenberg','7')===true")
  assert((await isBookShelved('gutenberg', '8')) === false, '未入架的 source_id 为 false')
  console.log('✅ 书架可见且 isBookShelved')

  const imported = await saveReading({
    title: '本地导入',
    type: 'book',
    content: 'Hello world from an imported book.',
    on_shelf: true,
  })
  assert(isDiscoveredBook(again) === true, '发现书 isDiscoveredBook 为 true')
  assert(isDiscoveredBook(imported) === false, '无 source_site 的导入书 isDiscoveredBook 为 false')
  assert(imported.source_site === undefined, 'saveReading 不给导入书写 source_site')
  assert(imported.content !== '', '导入书正文来自调用方，本测试不把它当成发现书')
  console.log('✅ isDiscoveredBook 区分发现书与导入书')

  console.log('\n🎉 发现书入架闭环测试全部通过')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
