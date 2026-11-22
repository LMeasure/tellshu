/**
 * T-P2 scheme B：导入书籍默认不上架，只有「加入书架」才进首页书架。
 * ------------------------------------------------------------------
 * 调用现有公开 API（saveReading / setOnShelf / getShelfBooks），不改 learning.ts。
 * 「我的素材」按钮用 jsdom 渲染 MaterialShelfButton（素材行与阅读器共用）。
 * 导入页整页在 tsx 下会加载 convert client（import.meta.env 无可选链），
 * 因此这里不挂整页，而核对 ReadingRow / AudioRow / BookImport 的源码接线。
 *
 * 覆盖：
 *   1. 新导入的 type=book 不写 on_shelf，不在 getShelfBooks()
 *   2. setOnShelf(id, true) 以及按钮点击之后，出现在 getShelfBooks() 和首页书架
 *   3. setOnShelf(id, false) / 「移出书架」可以再移出
 *   4. article（粘贴/扫描）、audio、transcript 不上架，也没有书架按钮
 *
 * 运行：npx tsx scripts/test_material_shelf.ts
 */

/* fake-indexeddb 必须在 globalThis.window 之前导入，否则 storage 会降级成内存库。 */
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/import',
  pretendToBeVisual: true,
})

for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'getComputedStyle',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  })
}
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setTimeout as sleep } from 'node:timers/promises'

const API_TITLE = 'API Shelf Book'
const ROW_TITLE = 'Row Shelf Book'
const PASTE_TITLE = 'Pasted Article'
const SCAN_TITLE = 'Scanned Page'
const AUDIO_TITLE = 'Voice Note'
const TRANSCRIPT_TITLE = 'Subtitle Clip'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(detail ? `${name}  ${detail}` : name)
    console.log(`  ✗ ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function sliceBetween(src: string, startMark: string, endMark: string): string {
  const start = src.indexOf(startMark)
  const end = src.indexOf(endMark, start + startMark.length)
  if (start < 0 || end < 0) return ''
  return src.slice(start, end)
}

async function main(): Promise<void> {
  const { saveReading, setOnShelf, getShelfBooks, getReading, deleteReading } = await import(
    '../src/domain/learning'
  )
  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { MemoryRouter } = await import('react-router-dom')
  const { Bookshelf } = await import('../src/components/home/Bookshelf')
  const { MaterialShelfButton } = await import('../src/components/import/MaterialShelfButton')
  const act = React.act

  async function waitFor(pred: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 4000
    while (!pred()) {
      if (Date.now() >= deadline) throw new Error(`等待超时：${label}`)
      await act(async () => {
        await sleep(20)
      })
    }
  }

  console.log('\n▶ 1. 导入书籍默认不在书架（公开 API）')
  const apiBook = await saveReading({
    title: API_TITLE,
    type: 'book',
    content: 'Chapter 1\nA book imported without a shelf flag.',
    chapters: [{ title: 'Chapter 1', para: 0 }],
  })
  check('新书 type=book', apiBook.type === 'book')
  check('saveReading 不写 on_shelf（undefined）', apiBook.on_shelf === undefined, `实际 ${String(apiBook.on_shelf)}`)
  const apiStored = await getReading(apiBook.id)
  check('读回后 on_shelf 仍未设置', apiStored?.on_shelf == null, `实际 ${String(apiStored?.on_shelf)}`)
  check('新书不在 getShelfBooks()', !(await getShelfBooks()).some((b) => b.id === apiBook.id))

  await setOnShelf(apiBook.id, true)
  const afterAdd = await getShelfBooks()
  const added = afterAdd.find((b) => b.id === apiBook.id)
  check('setOnShelf(id, true) 后出现在书架', added !== undefined)
  check('上架不写入 source_site / source_id', added?.source_site == null && added?.source_id == null)
  check('上架不改写导入正文', added?.content === apiBook.content)

  await setOnShelf(apiBook.id, false)
  check('setOnShelf(id, false) 后移出书架', !(await getShelfBooks()).some((b) => b.id === apiBook.id))
  const removed = await getReading(apiBook.id)
  check('移出后素材仍在，on_shelf 为 false', removed?.type === 'book' && removed.on_shelf === false)
  await deleteReading(apiBook.id)

  console.log('\n▶ 2. 文章 / 扫描 / 音频 / 字幕不会自动上架')
  const paste = await saveReading({
    title: PASTE_TITLE,
    type: 'article',
    content: 'A pasted article that must stay off the shelf.',
  })
  const scan = await saveReading({
    title: SCAN_TITLE,
    type: 'article',
    content: 'A scanned page saved as an article.',
  })
  const audio = await saveReading({
    title: AUDIO_TITLE,
    type: 'audio',
    content: '',
  })
  const transcript = await saveReading({
    title: TRANSCRIPT_TITLE,
    type: 'transcript',
    content: '1\n00:00:00,000 --> 00:00:01,000\nHello',
  })
  const rowBook = await saveReading({
    title: ROW_TITLE,
    type: 'book',
    content: 'The material-row book starts off the shelf.',
    chapters: [{ title: 'Chapter 1', para: 0 }],
  })
  check('素材行书籍 on_shelf 未设置', rowBook.on_shelf === undefined)
  const beforeUi = await getShelfBooks()
  for (const doc of [paste, scan, audio, transcript, rowBook]) {
    check(`${doc.title} 不在 getShelfBooks()`, !beforeUi.some((b) => b.id === doc.id))
  }

  console.log('\n▶ 3. 非书籍没有书架动作，强行 setOnShelf 也不进首页书架')
  await setOnShelf(paste.id, true)
  await setOnShelf(scan.id, true)
  await setOnShelf(audio.id, true)
  await setOnShelf(transcript.id, true)
  const forced = await getShelfBooks()
  check('粘贴文章 setOnShelf(true) 后仍不在书架', !forced.some((b) => b.id === paste.id))
  check('扫描文章 setOnShelf(true) 后仍不在书架', !forced.some((b) => b.id === scan.id))
  check('音频 setOnShelf(true) 后仍不在书架', !forced.some((b) => b.id === audio.id))
  check('字幕 setOnShelf(true) 后仍不在书架', !forced.some((b) => b.id === transcript.id))
  check('此时书架仍为空', forced.length === 0, `实际 ${forced.length}`)

  const importSrc = readFileSync(new URL('../src/pages/Import.tsx', import.meta.url), 'utf8')
  const readingRow = sliceBetween(importSrc, 'function ReadingRow', 'function AudioRow')
  const audioRow = sliceBetween(importSrc, 'function AudioRow', 'function TextImport')
  const bookImport = sliceBetween(importSrc, 'function BookImport', 'const AUDIO_HINT')
  check('导入页不写 on_shelf: 字段', !importSrc.includes('on_shelf:'))
  check('ReadingRow 挂了 MaterialShelfButton', readingRow.includes('<MaterialShelfButton'))
  check(
    '「已在书架」只标在 type=book 上',
    readingRow.includes("doc.type === 'book' && doc.on_shelf"),
  )
  check('AudioRow 没有书架按钮', audioRow !== '' && !audioRow.includes('MaterialShelfButton') && !audioRow.includes('加入书架'))
  check('BookImport 不传 on_shelf', bookImport !== '' && !bookImport.includes('on_shelf'))

  const readerSrc = readFileSync(new URL('../src/pages/Reader.tsx', import.meta.url), 'utf8')
  check('阅读器复用同一个书架按钮', readerSrc.includes('<MaterialShelfButton'))
  check('阅读器不直接调用 setOnShelf', !readerSrc.includes('setOnShelf'))

  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const probeRoot = createRoot(probe)
  for (const id of [paste.id, scan.id, audio.id, transcript.id]) {
    const stored = await getReading(id)
    await act(async () => {
      probeRoot.render(
        React.createElement(MaterialShelfButton, {
          doc: stored!,
          onChanged: () => undefined,
        }),
      )
    })
    check(
      `${stored?.type}「${stored?.title}」不渲染书架按钮`,
      probe.querySelector('button') === null && !/加入书架|移出书架/.test(probe.textContent ?? ''),
    )
  }
  await act(async () => {
    probeRoot.unmount()
  })
  probe.remove()

  console.log('\n▶ 4. 素材行按钮：加入书架 / 移出书架，且不触发行点击')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let navigated = 0
  let refreshed = 0

  async function renderRows(): Promise<void> {
    const ids = [rowBook.id, paste.id, scan.id, audio.id, transcript.id]
    const docs = []
    for (const id of ids) {
      const doc = await getReading(id)
      if (doc) docs.push(doc)
    }
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          ...docs.map((doc) =>
            React.createElement(
              'div',
              {
                key: doc.id,
                'data-title': doc.title,
                onClick: () => {
                  navigated += 1
                },
              },
              React.createElement('div', { className: 'truncate font-medium' }, doc.title),
              React.createElement(MaterialShelfButton, {
                doc,
                onChanged: () => {
                  refreshed += 1
                },
              }),
            ),
          ),
        ),
      )
    })
  }

  await renderRows()
  const row = host.querySelector(`[data-title="${ROW_TITLE}"]`)
  check('书籍行有「加入书架」', row?.querySelector('button[aria-label="加入书架"]') != null)
  check('未上架书籍行没有「移出书架」', row?.querySelector('button[aria-label="移出书架"]') == null)
  check(
    '列表里只有书籍有「加入书架」',
    host.querySelectorAll('button[aria-label="加入书架"]').length === 1,
    `实际 ${host.querySelectorAll('button[aria-label="加入书架"]').length}`,
  )
  for (const title of [PASTE_TITLE, SCAN_TITLE, AUDIO_TITLE, TRANSCRIPT_TITLE]) {
    const card = host.querySelector(`[data-title="${title}"]`)
    check(`${title} 没有加入书架`, card?.querySelector('button[aria-label="加入书架"]') == null)
    check(`${title} 没有移出书架`, card?.querySelector('button[aria-label="移出书架"]') == null)
  }

  const shelfHost = document.createElement('div')
  document.body.appendChild(shelfHost)
  let shelfRoot = createRoot(shelfHost)
  async function renderShelf(): Promise<void> {
    await act(async () => {
      shelfRoot.unmount()
    })
    shelfRoot = createRoot(shelfHost)
    await act(async () => {
      shelfRoot.render(React.createElement(MemoryRouter, null, React.createElement(Bookshelf)))
    })
    await waitFor(() => !(shelfHost.textContent ?? '').includes('加载中'), '首页书架加载完成')
  }
  await renderShelf()
  check('加入前首页书架为空', (shelfHost.textContent ?? '').includes('书架还是空的'))
  check('加入前首页看不到这本书', !(shelfHost.textContent ?? '').includes(ROW_TITLE))

  const addBtn = row?.querySelector('button[aria-label="加入书架"]')
  await act(async () => {
    addBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(30)
  })
  await waitFor(() => refreshed === 1, '加入书架回调')
  check('点击「加入书架」没有冒泡成行点击', navigated === 0, `navigated=${navigated}`)
  const shelved = await getShelfBooks()
  const shelvedBook = shelved.find((b) => b.id === rowBook.id)
  check('按钮路径之后 getShelfBooks() 含该书', shelvedBook !== undefined)
  check('粘贴文章仍不在书架', !shelved.some((b) => b.id === paste.id))
  check('扫描文章仍不在书架', !shelved.some((b) => b.id === scan.id))
  check('音频仍不在书架', !shelved.some((b) => b.id === audio.id))
  check('字幕仍不在书架', !shelved.some((b) => b.id === transcript.id))
  check('按钮上架不写入 Gutenberg source_id', shelvedBook?.source_id == null && shelvedBook?.source_site == null)
  check('按钮上架保留原文', shelvedBook?.content === rowBook.content)

  await renderRows()
  const shelvedRow = host.querySelector(`[data-title="${ROW_TITLE}"]`)
  check('刷新后书籍行变为「移出书架」', shelvedRow?.querySelector('button[aria-label="移出书架"]') != null)
  check('刷新后不再显示「加入书架」', host.querySelector('button[aria-label="加入书架"]') == null)
  for (const title of [PASTE_TITLE, SCAN_TITLE, AUDIO_TITLE, TRANSCRIPT_TITLE]) {
    const card = host.querySelector(`[data-title="${title}"]`)
    check(`${title} 上架标志被写上后仍没有书架按钮`, card?.querySelector('button') == null)
  }

  await renderShelf()
  check('首页书架出现这本书', (shelfHost.textContent ?? '').includes(ROW_TITLE))
  check('首页书架不再是空态', !(shelfHost.textContent ?? '').includes('书架还是空的'))

  const removeBtn = shelvedRow?.querySelector('button[aria-label="移出书架"]')
  await act(async () => {
    removeBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(30)
  })
  await waitFor(() => refreshed === 2, '移出书架回调')
  check('点击「移出书架」没有冒泡成行点击', navigated === 0, `navigated=${navigated}`)
  check('按钮移出后 getShelfBooks() 不再包含该书', !(await getShelfBooks()).some((b) => b.id === rowBook.id))
  const afterRemove = await getReading(rowBook.id)
  check('移出后书籍还在素材库', afterRemove?.title === ROW_TITLE && afterRemove.on_shelf === false)
  await renderShelf()
  check('首页书架再次为空', (shelfHost.textContent ?? '').includes('书架还是空的'))
  check('首页不再显示这本书', !(shelfHost.textContent ?? '').includes(ROW_TITLE))

  console.log('\n▶ 5. 移出后仍可用公开 API 再加入、再移出')
  await setOnShelf(rowBook.id, true)
  check('再次 setOnShelf(true) 回到书架', (await getShelfBooks()).some((b) => b.id === rowBook.id))
  await setOnShelf(rowBook.id, false)
  check('再次 setOnShelf(false) 离开书架', !(await getShelfBooks()).some((b) => b.id === rowBook.id))

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
  console.log('🎉 T-P2 scheme B 素材书架测试全部通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
