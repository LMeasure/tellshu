/**
 * 「一页即一屏」分页算法单测（V3.0 需求三）
 * 运行：npx tsx scripts/test_fitpaging.ts
 *
 * 只测**纯逻辑**：packByHeight 用注入的合成高度函数驱动，
 * 不依赖浏览器测量，可稳定复现。
 */

import { packByHeight, paraToPageMap, wholeParaPages, PARA_GAP } from '../src/lib/fitPaging'
import { paginate } from '../src/lib/paging'

let failed = 0
function assert(cond: boolean, msg: string) {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed += 1
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  assert(
    actual === expected,
    `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`,
  )
}

/** 合成高度：每 10 个字符一行，每行 10px（单调不减，便于手算） */
const h10 = (_para: number, start: number, end: number) => Math.ceil((end - start) / 10) * 10

console.log('[fitPaging] 超长段落按行拆成片段跨页（不溢出、不丢字）')
{
  const paras = ['a'.repeat(40)]
  const pages = packByHeight(paras, h10, 25, 5)
  eq(pages.length, 2, '40 字 / 每页 25px（≈20 字）→ 2 页')
  const f0 = pages[0].frags[0]
  eq(f0.para, 0, '第 1 页片段属于第 0 段')
  eq(f0.start, 0, '第 1 页片段从 0 开始')
  eq(f0.end, 20, '第 1 页放下 20 字')
  const f1 = pages[1].frags[0]
  eq(f1.start, 20, '第 2 页片段接着第 20 字')
  eq(f1.end, 40, '第 2 页放完剩下的 20 字')
  eq(pages[0].frags[0].end, pages[1].frags[0].start, '片段首尾相接，不漏字不重复')
}

console.log('[fitPaging] 段落放得下就整段收，放不下就整体挪到下一页')
{
  const paras = ['a'.repeat(30), 'b'.repeat(30)]
  const pages = packByHeight(paras, h10, 35, 5)
  eq(pages.length, 2, '第 1 页装不下两段（30+5+30>35）→ 2 页')
  eq(pages[0].frags.length, 1, '第 1 页只有第 0 段')
  eq(pages[0].frags[0].para, 0, '且是整段（para=0）')
  eq(pages[0].frags[0].end, 30, '整段收下（不切段）')
  eq(pages[1].frags[0].para, 1, '第 2 页是第 1 段')
}

console.log('[fitPaging] 剩余高度不够放任何字符 → 换页而不是硬塞')
{
  const paras = ['a'.repeat(30), 'b'.repeat(30)]
  const pages = packByHeight(paras, h10, 30, 5)
  eq(pages.length, 2, '每页只放得下一段 → 2 页')
  eq(pages.every((p) => p.frags.length === 1), true, '每页恰好一段')
}

console.log('[fitPaging] 英文尽量不切词（回退到最近的空白）')
{
  const text = 'hello world foo bar baz qux quux corge'
  const paras = [text]
  const pages = packByHeight(paras, (_p, s, e) => Math.ceil((e - s) / 12) * 12, 30, 5)
  const first = pages[0].frags[0]
  assert(pages.length >= 2, `长句被拆成多页（实际 ${pages.length} 页）`)
  assert(
    first.end === text.length || text[first.end - 1] === ' ',
    `第 1 页切点在词边界（end=${first.end}，字符=${JSON.stringify(text[first.end - 1] ?? 'EOS')}）`,
  )
}

console.log('[fitPaging] 完整文本无损覆盖（拼回去等于原文）')
{
  const paras = ['a'.repeat(37), 'b'.repeat(11), 'c'.repeat(63)]
  const pages = packByHeight(paras, h10, 40, PARA_GAP)
  const rebuilt = new Array(paras.length).fill('')
  for (const p of pages) for (const f of p.frags) rebuilt[f.para] += paras[f.para].slice(f.start, f.end)
  assert(
    rebuilt.every((s, i) => s === paras[i]),
    '每段拼回原文（分页不丢字、不重复）',
  )
}

console.log('[fitPaging] 段落下标 → 页下标（取首次出现页）')
{
  const paras = ['a'.repeat(40), 'b'.repeat(10)]
  const pages = packByHeight(paras, h10, 25, 5)
  const map = paraToPageMap(pages, paras.length)
  eq(map[0], 0, '第 0 段在第 1 页')
  eq(map[1], pages.length - 1, '第 1 段在最后一页')
}

console.log('[fitPaging] 兜底：字符预算分页 → 整段不拆')
{
  const paras = ['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150)]
  const fit = wholeParaPages(paras, paginate(paras, 400))
  eq(fit.length, 2, '沿用字符预算的页数（3 段 ×150 字 / 400 → 2 页）')
  eq(fit[0].frags.length, 2, '第 1 页两段')
  eq(fit[0].frags[0].start, 0, '整段起点为 0')
  eq(fit[0].frags[0].end, 150, '整段终点为段长')
}

console.log('[fitPaging] 边界：空输入 / 非法页高')
{
  eq(packByHeight([], h10, 100).length, 0, '空段落 → 0 页')
  eq(packByHeight(['x'], h10, 0).length, 0, '页高为 0 → 0 页（不做除法/死循环）')
  eq(packByHeight(['x'], h10, -5).length, 0, '页高为负 → 0 页')
  const tiny = packByHeight(['x'.repeat(5)], () => 999, 1, 0)
  eq(tiny.length, 5, '页高极小（放不下任何一段）→ 逐字分页、正常终止（不死循环）')
}

console.log('[反向] 断言本身有效')
{
  const paras = ['a'.repeat(40)]
  const pages = packByHeight(paras, h10, 25, 5)
  assert(pages[0].frags[0].end !== 40, '若把整段硬塞进一页（20 字页放 40 字），断言会失败')
}

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n一页即一屏分页单测全部通过 ✓')
